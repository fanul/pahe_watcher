import { createLogger } from '../core/logger.js';
import { BrowserManager } from './browser.js';
import { createCaptchaSolver, detectCaptcha, tryAutoClickRecaptchaCheckbox } from './captcha/index.js';
import { isGdflixUrl, resolveGdflix, classifyFinalLink } from './resolvers/gdflix.js';
import { isGoogleAuthHost, ensureGoogleLogin, normalizeGoogleDriveLink } from './resolvers/googleDrive.js';
import { isDeadLinkPage } from './deadLinkPatterns.js';
import { isAntiAutomationWallPage } from './antiAutomationWall.js';
import { resolveLLAdGate, isLLAdGateUrl } from './resolvers/llAdGate.js';
import { AD_HOSTS } from './userscript.js';
import { restoreWindow } from './windowControl.js';
import { isWorkerCacheOriginUrl, checkWorkerCache, saveToWorkerCache } from './shortlinkWorkerCache.js';

const log = createLogger('bypass');

const FINAL_HOST_RE = /(drive\.google\.com|googleusercontent\.com|pixeldrain\.|pixeldra\.in|workers\.dev|\.r2\.)/i;

/**
 * Hostname only, never the raw URL string. Confirmed live: a Google sign-in
 * wall (accounts.google.com/v3/signin/...?continue=https://drive.google.com/...)
 * contains "drive.google.com" as a query-string substring despite the host
 * itself requiring a login FINAL_HOST_RE.test(url) can't tell apart from an
 * actual resolved Drive link. That false match made two real jobs report
 * "done" with a dead sign-in-wall URL as their finalUrl the moment cookie
 * login failed — and because the job looked complete, its checkpoint got
 * cleared, so the next retry had nothing to resume from and reran the whole
 * ad-chain (intercelestial → pahe.plus → ouo → gdflix) from scratch instead
 * of just retrying the Google auth step. See resolvers/gdflix.js's
 * classifyFinalLink for the same fix applied there.
 */
function hostnameOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

// Some shorteners' page automation replicates a click handler's navigation
// logic (e.g. reading an atob()-encoded query string off a script tag)
// without dispatching a real trusted click — if the destination validates
// that a genuine click happened, it bounces back to the exact same URL, the
// automation re-triggers, and it repeats forever until the job timeout.
// Confirmed live on linegee.net. STUCK_LOOP_THRESHOLD consecutive reloads of
// the *same* URL is treated as unrecoverable rather than silently burning
// the whole timeout on a chain that will never progress.
export const STUCK_LOOP_THRESHOLD = 6;

/**
 * Pure tracker for "has this exact URL reloaded STUCK_LOOP_THRESHOLD times in
 * a row" — kept separate from the Playwright event wiring in `resolve()` so
 * the detection logic itself is unit-testable without mocking a Page.
 * @param {{lastUrl: string|null, repeatCount: number}} state mutated in place
 * @param {string} url the newly-navigated-to URL
 * @returns {boolean} true once the threshold is reached (fires only once — subsequent calls at the same count return false again until it climbs past the threshold again, since state.repeatCount keeps incrementing)
 */
export function trackUrlRepeat(state, url) {
  state.repeatCount = url === state.lastUrl ? state.repeatCount + 1 : 1;
  state.lastUrl = url;
  return state.repeatCount === STUCK_LOOP_THRESHOLD;
}

/**
 * BypassEngine drives one job from a shortener entry URL through the ad chain to
 * the final Google Drive (or pixeldrain/direct) link.
 *
 * The injected page automation (userscript.js) auto-advances the known ad hosts;
 * this engine watches for the browser to land on a GDFlix page (or directly on a
 * final host), then runs the GDFlix resolver. Captcha handling is delegated to
 * the configured solver.
 */
/**
 * Resolve the effective headless flag.
 * - "headful"  -> always headful
 * - "headless" -> always headless
 * - "auto" (default) -> follow the captcha provider: MANUAL needs a visible
 *   window to solve Turnstile by hand, so headful; paid/automated providers
 *   (2captcha, capsolver, none, flaresolverr, byparr) run headless.
 */
export function resolveHeadless(config) {
  const mode = (config.bypass.browserMode || 'auto').toLowerCase();
  if (mode === 'headful') return false;
  if (mode === 'headless') return true;
  const provider = (config.bypass.captcha?.provider || 'none').toLowerCase();
  return provider !== 'manual';
}

export class BypassEngine {
  constructor({ config, store }) {
    this.config = config;
    this.store = store;
    const headless = resolveHeadless(config);
    log.info(`Browser mode resolved: ${headless ? 'headless' : 'headful'} (browserMode=${config.bypass.browserMode}, captcha=${config.bypass.captcha?.provider})`);
    this.browser = new BrowserManager({
      profileDir: config.bypass.profileDir,
      headless,
      initialPageDelayMs: (config.bypass.initialPageDelaySeconds || 1.5) * 1000,
      config: config,
    });
    this.captcha = createCaptchaSolver(config, { headless });
    this.activeJobs = new Map();
  }

  async close() {
    await this.browser.close();
  }

  /**
   * Opens a fresh tab in the SAME persistent browser profile every job
   * already runs through, and brings it to front so a human can sign in by
   * hand. The session then lives directly in that profile afterward —
   * ensureGoogleLogin/ensureGdflixLogin's own "already logged in" fast path
   * (see resolvers/googleDrive.js, resolvers/gdflix.js) picks it up
   * automatically on the next job, no cookie export/import needed.
   *
   * This exists because copy-pasted cookies turned out to be fundamentally
   * unreliable for Google specifically: confirmed live that a freshly
   * exported, unexpired cookie set (SID/HSID/SAPISID/etc.) still failed to
   * authenticate when replayed from this machine, landing on a bare "Sign
   * in" page that didn't even recognize a prior session. Google's SIDCC /
   * __Secure-1PSIDCC family of cookies bind a session to the network it was
   * issued from as anti-session-theft protection — so a cookie transplant
   * from a different machine/IP gets silently rejected regardless of how
   * fresh the cookies are. Logging in directly in this profile sidesteps
   * that entirely, since the session is then native to this machine.
   */
  async openLoginPage(url) {
    if (this.browser.headless) {
      throw new Error('Browser is running headless — switch Browser Mode to "headful" in Settings, then try again.');
    }
    const page = await this.browser.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch((err) => {
      log.warn(`openLoginPage navigation error: ${err.message}`);
    });
    await restoreWindow(page);
    await page.bringToFront().catch(() => {});
    return { url: page.url() };
  }

  async abort(jobId) {
    const active = this.activeJobs.get(jobId);
    if (active) {
      log.info(`Aborting active job ${jobId}`);
      try {
        await active.page.close().catch(() => {});
      } catch (e) {}
      this.activeJobs.delete(jobId);
    }
  }

  /**
   * Resolve a single download option.
   * @param {object} job  the queue job (has .url, .provider, .quality, .title)
   * @param {object} ctx  { log(msg), jobId }
   * @returns {Promise<{finalUrl, linkType, hops}>}
   */
  async resolve(job, ctx = {}) {
    const timeoutMs = this.config.bypass.timeoutSeconds * 1000;
    const page = await this.browser.newPage();
    const context = page.context();
    this.activeJobs.set(job.id, { page, context });
    
    // Clear cookies for shorteners to prevent Nginx "400 Bad Request (Cookie Too Large)"
    try {
      await context.clearCookies({ domain: 'ouo.io' }).catch(() => {});
      await context.clearCookies({ domain: '.ouo.io' }).catch(() => {});
      await context.clearCookies({ domain: 'ouo.press' }).catch(() => {});
      await context.clearCookies({ domain: '.ouo.press' }).catch(() => {});
      await context.clearCookies({ domain: 'pahe.plus' }).catch(() => {});
      await context.clearCookies({ domain: '.pahe.plus' }).catch(() => {});
    } catch (e) {}

    const hops = [];
    let settled = null;
    let stuckLoopError = null;

    const activePages = new Set([page]);
    const navListeners = new Map();

    const trackPage = (p) => {
      const repeatState = { lastUrl: null, repeatCount: 0 };
      const navListener = (frame) => {
        if (frame === p.mainFrame()) {
          const u = frame.url();
          if (u && u !== 'about:blank') {
            hops.push(u);
            ctx.log?.(`→ ${shorten(u)}`);

            if (trackUrlRepeat(repeatState, u) && !stuckLoopError) {
              stuckLoopError = new Error(
                `Stuck in a redirect loop at ${shorten(u)} — the same page reloaded ${repeatState.repeatCount} times in a row without progressing. This shortener step likely requires interaction the automation can't replicate.`,
              );
            }
          }
        }
      };
      p.on('framenavigated', navListener);
      navListeners.set(p, navListener);

      p.once('close', () => {
        p.off('framenavigated', navListener);
        navListeners.delete(p);
        activePages.delete(p);
      });
    };

    // Track the initial page
    trackPage(page);

    // Reused by both the immediate popup-closer right below and
    // _driveToFinal's own poll-tick pruning further down — same list, so a
    // popup landing on a real ad-chain host never gets closed either way.
    const WHITELIST_DOMAINS = this.config?.bypass?.tabPruningWhitelist || [
      ...AD_HOSTS,
      'gdflix', 'drive.google', 'pixeldrain', 'pixeldra.in', 'about:blank',
    ];

    // Track any new tabs or popups created in this context
    const onPage = (newPage) => {
      activePages.add(newPage);
      ctx.log?.(`[tab] New tab opened: ${shorten(newPage.url())}`);
      trackPage(newPage);

      // Close ad-chain popups the instant they open and reclaim focus on
      // the real page, instead of waiting for the next ~1s poll tick in
      // _driveToFinal (which also only ran at all when pruneAdTabs was
      // explicitly enabled — off by default). Reported live on pahe.plus:
      // every click there pop-unders a new ad tab and steals focus, and it
      // sat there disrupting things until the next tick closed it — same
      // "popup steals focus" problem llAdGate.js already solves for
      // intercelestial.com, just missing here for the shared main browser.
      // A brief wait lets the popup's URL settle before checking it against
      // the whitelist (a fresh popup often starts at about:blank for a
      // moment) — every domain actually part of a real chain step is in
      // AD_HOSTS/WHITELIST_DOMAINS, so this never fights a legitimate hop.
      newPage
        .waitForLoadState('domcontentloaded', { timeout: 3000 })
        .catch(() => {})
        .then(() => {
          if (newPage.isClosed()) return;
          const popupUrl = newPage.url().toLowerCase();
          const isWhitelisted = popupUrl === 'about:blank' || WHITELIST_DOMAINS.some((d) => popupUrl.includes(d));
          if (isWhitelisted) return;
          ctx.log?.(`[tab] Closing ad popup and reclaiming focus: ${shorten(newPage.url())}`);
          newPage.close().catch(() => {});
          page.bringToFront().catch(() => {});
        });
    };
    context.on('page', onPage);

    // Resolved-shortlink cache (Store#getCachedDestination) — a prior
    // resolve() of this exact entry URL may have already walked the whole ad
    // chain. Only consulted on a fresh attempt (no checkpoint yet), since a
    // checkpoint is a more precise, job-specific resume point already. If
    // this cached start turns out stale (dead link, wall, timeout — anything
    // that throws below), the catch block evicts it so the next attempt does
    // a full fresh resolution instead of retrying the same bad shortcut.
    let cachedDestination = !job.checkpointUrl ? this.store?.getCachedDestination(job.url) : null;
    let usedCachedStart = Boolean(cachedDestination);
    // Set once we know where the entry link actually redirects to (see the
    // worker-cache lookup below) — the URL saveToWorkerCache() should key
    // its contribution under, since that's how the community cache itself
    // is keyed (job.url may be a same-path-redirecting entry link like
    // tpi.li/<slug>, not the clone-domain URL that redirect lands on).
    let workerCacheKeyUrl = null;

    try {
      // Resume from the last known-good hop if a previous attempt on this
      // same job got that far (see jobQueue.js's setCheckpoint) — skips
      // re-walking the whole chain, including intercelestial.com's flaky
      // ad-gate, on every retry. Falls back to the shortlink cache, then to
      // job.url if there's no checkpoint (first attempt) or the queue
      // already cleared a stale one after a failed resume.
      const startUrl = job.checkpointUrl || cachedDestination || job.url;
      const startLabel = job.checkpointUrl ? ' (resumed from checkpoint)' : usedCachedStart ? ' (from cached destination)' : '';
      ctx.log?.(`Starting: ${job.provider} ${job.quality || ''} — ${shorten(startUrl)}${startLabel}`);
      await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});

      // Community Worker cache (shortlinkWorkerCache.js) — checked against
      // where we actually LANDED, not job.url itself: entry links like
      // tpi.li/<slug> same-path-redirect to the oii.la-family clone domain
      // (srnky.com/<slug>, clksz.com/<slug>, …) that actually hosts the
      // gate, and the community cache is keyed by that post-redirect URL,
      // not the tpi.li entry link. Confirmed live this session: the cache
      // already had the correct destination for a shortlink we were
      // independently stuck behind a Turnstile challenge on, contributed by
      // other users of the reference userscript this was adapted from.
      // Only tried on a fresh attempt with no local-cache hit already.
      if (!usedCachedStart && !job.checkpointUrl) {
        const landedUrl = page.url();
        if (isWorkerCacheOriginUrl(landedUrl)) {
          workerCacheKeyUrl = landedUrl;
          const workerDestination = await checkWorkerCache(landedUrl);
          if (workerDestination) {
            ctx.log?.(`Found destination in community shortlink cache: ${shorten(workerDestination)}`);
            cachedDestination = workerDestination;
            usedCachedStart = true;
            await page.goto(workerDestination, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
          }
        }
      }

      settled = await this._driveToFinal(activePages, ctx, timeoutMs, () => stuckLoopError);
      if (!settled) throw new Error('Timed out before reaching a final link');

      // Whichever Drive URL shape got captured (varies by which link/button
      // the GDFlix page happened to expose), normalize to the direct-download
      // form so the recorded link doesn't just open a viewer/confirmation page.
      if (settled.linkType === 'google-drive') {
        const normalized = normalizeGoogleDriveLink(settled.finalUrl);
        if (normalized !== settled.finalUrl) {
          ctx.log?.(`Normalized Drive link to direct-download form: ${normalized}`);
          settled = { ...settled, finalUrl: normalized };
        }
      }

      ctx.log?.(`✔ Final link (${settled.linkType}): ${settled.finalUrl}`);
      // Cache the entry URL -> final link so a later resolve() of the exact
      // same shortlink (lost checkpoint, re-queued job, etc.) can skip
      // straight to it. Refreshed on every success, including cache-hit
      // runs, so a still-good cached link keeps its TTL alive.
      this.store?.setCachedDestination(job.url, settled.finalUrl);
      // Contribute back to the community cache too, same as the reference
      // userscript's own listenerNavigation() — best-effort, never awaited
      // (a slow/unreachable Worker shouldn't delay returning an already-
      // successful result), and shortlinkWorkerCache.js never throws. Keyed
      // under whichever origin-domain URL we actually landed on (set above
      // when checking the cache), not job.url — matches how the community
      // cache itself is keyed. Skipped when we started FROM a cached
      // destination (nothing new to contribute) or never reached this
      // family of hosts at all.
      if (workerCacheKeyUrl && !job.checkpointUrl && cachedDestination !== settled.finalUrl) {
        saveToWorkerCache(workerCacheKeyUrl, settled.finalUrl);
      }
      return { ...settled, hops };
    } catch (err) {
      // The cached destination didn't actually pan out this time — evict it
      // immediately rather than waiting out the TTL, so the job-queue's own
      // retry gets a full fresh resolution instead of repeating the same
      // stale shortcut.
      if (usedCachedStart) this.store?.deleteCachedDestination(job.url);
      throw err;
    } finally {
      this.activeJobs.delete(job.id);
      // Clean up context listeners and close all pages
      context.off('page', onPage);
      for (const p of activePages) {
        const listener = navListeners.get(p);
        if (listener) p.off('framenavigated', listener);
        await closeWithTimeout(p);
      }
    }
  }

  /**
   * Poll all active pages/tabs in the context until one reaches GDFlix or a final host directly.
   */
  async _driveToFinal(activePages, ctx, timeoutMs, getStuckLoopError) {
    let deadline = Date.now() + timeoutMs;
    let handledGdflix = false;
    let handledGoogleAuth = false;
    let handledLLGate = false;
    const deadCheckedUrls = new Set();
    let lastCheckpointedUrl = null;
    // Stable, resumable hops worth checkpointing (see setCheckpoint in
    // jobQueue.js) — deliberately NOT every hop: the ad-chain redirect noise
    // in between (random ad-popup domains, one-shot signed shortener
    // tokens) isn't something a later retry could usefully resume from, but
    // landing on pahe.plus or ouo.io is a real, stable waypoint.
    const CHECKPOINT_HOSTS = ['pahe.plus', 'old.pahe.plus', 'ouo.io', 'ouo.press'];
    const maybeCheckpoint = (url) => {
      if (!url || url === lastCheckpointedUrl || !ctx.setCheckpoint) return;
      try {
        const parsed = new URL(url);
        // A bare domain root is never a valid resume point for these hosts
        // — pahe.plus/ouo.io/ouo.press links always carry a short-link slug
        // in the path. Confirmed live: a chain that got knocked off its
        // specific link (a Cloudflare challenge + decoy-article redirect
        // detour) can land back on just "https://ouo.press/", and without
        // this guard that overwrites the last GOOD checkpoint (the actual
        // /3SB2v1C link) with a useless one a future retry can't resume
        // from at all.
        if (parsed.pathname === '/' || parsed.pathname === '') return;
        const host = parsed.hostname.replace(/^www\./, '');
        const isCheckpointHost = CHECKPOINT_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
        if (isCheckpointHost || isGdflixUrl(url)) {
          lastCheckpointedUrl = url;
          ctx.setCheckpoint(url);
        }
      } catch {}
    };

    // Reuses AD_HOSTS (the full ad-chain host list the page automation
    // already knows how to click through) plus the non-shortener hosts a
    // resolved chain can legitimately land on — so a popup tab never gets
    // pruned before the automation gets a chance to act on it.
    const WHITELIST_DOMAINS = this.config?.bypass?.tabPruningWhitelist || [
      ...AD_HOSTS,
      'gdflix', 'drive.google', 'pixeldrain', 'pixeldra.in', 'about:blank',
    ];

    while (Date.now() < deadline) {
      const stuckLoopError = getStuckLoopError?.();
      if (stuckLoopError) {
        ctx.log?.(`✖ ${stuckLoopError.message}`);
        throw stuckLoopError;
      }

      const pages = Array.from(activePages).filter(p => !p.isClosed());
      if (pages.length === 0) {
        throw new Error('All browser pages/tabs were closed');
      }

      for (const p of pages) {
        const url = p.url();

        if (p === pages[0]) maybeCheckpoint(url);

        // 1. Close failed/error tabs immediately
        if (url.includes('chrome-error://') || url.includes('chromewebdata')) {
          ctx.log?.(`[tab] Closing failed/error tab`);
          await closeWithTimeout(p);
          continue;
        }

        // 1b. Close search spam/ad redirect popup tabs immediately (always safe)
        const isInitialTabCheck = (p === pages[0] && pages.length === 1);
        if (!isInitialTabCheck && url && (url.includes('google.com/search') || url.includes('olxtoto'))) {
          ctx.log?.(`[tab] Closing ad redirect/spam popup: ${shorten(url)}`);
          await closeWithTimeout(p);
          continue;
        }

        // 2. Close unwanted ad popups (if enabled, and it's not the initial tab and not whitelisted)
        if (this.config?.bypass?.pruneAdTabs) {
          const isInitialTab = (p === pages[0] && pages.length === 1);
          if (!isInitialTab && url && url !== 'about:blank') {
            const isWhitelisted = WHITELIST_DOMAINS.some(d => url.toLowerCase().includes(d));
            if (!isWhitelisted) {
              ctx.log?.(`[tab] Closing unwanted ad popup tab: ${shorten(url)}`);
              await closeWithTimeout(p);
              continue;
            }
          }
        }

        // Confirmed-dead file check — once per distinct URL landed on, so we
        // don't re-evaluate the same static page every polling tick. Applies
        // at any hop (shortener, GDFlix, or the final Drive/pixeldrain page
        // itself), since "file removed" pages can appear anywhere in the chain.
        //
        // The anti-automation wall check below is deliberately NOT gated by
        // deadCheckedUrls the same way — confirmed live that intercelestial.com
        // is a single-page app that shows the wall at the SAME url
        // (https://intercelestial.com/) it was already sitting at before the
        // wall appeared (no navigation). Gating on "have we checked this URL
        // before" meant the wall page's own content was never (re-)inspected
        // once that URL had been checked once early in the chain — the job
        // just sat on the wall, silent, until the full job timeout. Content
        // can change under a stable URL here, so this has to re-check every
        // tick regardless of URL.
        if (url && url !== 'about:blank') {
          const pageText = (await evaluateWithTimeout(p, () => document.body?.innerText || '')) || '';
          if (!deadCheckedUrls.has(url)) {
            deadCheckedUrls.add(url);
            if (isDeadLinkPage(pageText)) {
              throw Object.assign(new Error(`Dead link detected at ${shorten(url)}`), { dead: true });
            }
          }
          // Ad-gate anti-bot wall (confirmed on intercelestial.com/teknoasian.com's
          // "LL" template) — a probabilistic judgment, not a hard block. Failing
          // fast here (instead of idling out the job timeout) lets the queue's
          // existing retry loop get a fresh token/session sooner, which is the
          // only thing that actually improves the odds.
          if (isAntiAutomationWallPage(pageText)) {
            throw new Error(`Anti-automation wall detected at ${shorten(url)} — retrying with a fresh session`);
          }
        }

        // Google sign-in wall reached mid-chain (e.g. a restricted-access Drive
        // link redirected here before the final drive.google.com URL). Inject
        // configured Google cookies so navigation can continue; no-ops quickly
        // if no cookies are configured. Guarded so we don't reload every
        // second if it doesn't resolve — one attempt per page landing here.
        if (isGoogleAuthHost(url) && !handledGoogleAuth) {
          handledGoogleAuth = true;
          const loginResult = await ensureGoogleLogin(
            p,
            { ...this.config.bypass.google, profileDir: this.config.bypass.profileDir },
            ctx,
          ).catch((err) => {
            ctx.log?.(`Google login error: ${err.message}`);
            return { loggedIn: false };
          });
          if (!loginResult?.loggedIn) {
            // Fail fast rather than idle on this wall for the rest of the job
            // timeout — same reasoning as the anti-automation-wall/LL ad-gate
            // checks above: a fresh job-queue retry is the only thing that
            // actually improves the odds (a different/refreshed cookie set,
            // or the operator fixing Settings), so there's no point waiting
            // out the clock here. Throwing (instead of the old behavior of
            // silently falling through) also means the checkpoint progress
            // already made this attempt (pahe.plus/ouo/etc.) is preserved by
            // the job queue's retry logic, instead of the next retry
            // restarting the whole ad-chain from scratch.
            throw new Error(
              loginResult?.skipped
                ? 'Google sign-in required but no Google account cookies are configured (Settings → Google Drive).'
                : 'Google sign-in wall could not be bypassed — configured cookies may be expired or for the wrong account.',
            );
          }
        }

        // Reached a final host directly.
        if (FINAL_HOST_RE.test(hostnameOf(url))) {
          if (classifyFinalLink(url) === 'google-drive') {
            // Some Drive pages show an inline "Sign in" prompt rather than
            // redirecting to accounts.google.com — check here too. Cheap
            // no-op for the common public "anyone with the link" case
            // (ensureGoogleLogin returns loggedIn:true immediately whenever
            // the page doesn't actually need a login).
            const loginResult = await ensureGoogleLogin(
              p,
              { ...this.config.bypass.google, profileDir: this.config.bypass.profileDir },
              ctx,
            ).catch((err) => {
              ctx.log?.(`Google login error: ${err.message}`);
              return { loggedIn: false };
            });
            if (!loginResult?.loggedIn) {
              // Same reasoning as the accounts.google.com wall check above —
              // don't report a broken sign-in-wall URL as a resolved link.
              throw new Error(
                loginResult?.skipped
                  ? 'Google sign-in required but no Google account cookies are configured (Settings → Google Drive).'
                  : 'Google sign-in wall could not be bypassed — configured cookies may be expired or for the wrong account.',
              );
            }
            // Cookie injection may have reloaded/redirected the page.
            const settledUrl = p.url();
            return { finalUrl: settledUrl, linkType: classifyFinalLink(settledUrl) };
          }
          return { finalUrl: url, linkType: classifyFinalLink(url) };
        }

        // oii.la-family (oii.la, tpi.li, clksz.com, srnky.com) "#continue" /
        // ".btn-captcha" button — confirmed live via a Node-side DOM dump
        // that this is a single element serving two identities depending on
        // page state: while genuinely disabled, its onclick is
        // `window.open(adUrl)` (an ad decoy — clicking it just fires the
        // ad); once the page's own script clears that onclick (~3s in), the
        // element is a bare `type="submit"` button gated by a real
        // Cloudflare Turnstile challenge (a hidden `cf-turnstile-response`/
        // `visit_token` field that only gets a value once Turnstile actually
        // passes). Force-removing `disabled` and clicking it early — what
        // this handler and the injected script's fallback heuristic both
        // used to do — submits the form before that token exists, which the
        // server reads as an invalid/bot submission and bounces the job
        // through an ad-redirect chain (hai8g.com → advertisingcamps.com →
        // taboola.com) every time. There is no "trusted click" workaround
        // for that — a real click on a still-gated button is just as
        // premature as a synthetic one. This deliberately does NOT click:
        // detectCaptcha()/this.captcha below is the right place to actually
        // solve the Turnstile challenge blocking it (not yet recognized
        // there — see the "widget not detected" note lower down); until
        // then, a job stuck here should time out with a clear picture in
        // the logs rather than force a submission that's confirmed harmful.

        // Node-side ouo.io automation fallback when userscript is disabled/restricted
        if (url && /ouo\.(io|press)/i.test(url)) {
          const removeAds = this.config?.bypass?.removeOuoAds !== false;
          await p.evaluate((removeAds) => {
            if (removeAds) {
              try {
                document.querySelectorAll('div, a, iframe, span').forEach((el) => {
                  if (el.closest('#form-captcha') || el.closest('#form-go')) return;
                  const style = window.getComputedStyle(el);
                  if (style.position === 'fixed' || style.position === 'absolute') {
                    if (el.querySelector('.cf-turnstile') || el.classList.contains('cf-turnstile')) return;
                    el.style.display = 'none';
                    el.remove();
                  }
                });
              } catch {}
            }

            if (window.__nodeDone) return;
            function nodeFormSubmit(form) {
              const btn = form.querySelector('#btn-main, button[type="submit"], button');
              if (btn) {
                btn.removeAttribute('disabled');
                btn.click();
                setTimeout(() => { try { form.submit(); } catch {} }, 100);
              } else {
                form.submit();
              }
            }

            // Page 2: countdown / redirect
            const goForm = document.getElementById('form-go');
            if (goForm) {
              window.__nodeDone = true;
              console.log('[node-auto] Page 2: submitting form #form-go');
              nodeFormSubmit(goForm);
              return;
            }

            // Page 1: Turnstile Captcha page
            const captchaForm = document.getElementById('form-captcha');
            if (captchaForm) {
              const cfres = document.querySelector('[name="cf-turnstile-response"]');
              if (cfres && cfres.value && !window.__nodeSubmitTimer) {
                window.__nodeSubmitTimer = true;
                console.log('[node-auto] Page 1: Turnstile solved. Waiting 1000ms for Cloudflare sync...');
                setTimeout(() => {
                  window.__nodeDone = true;
                  console.log('[node-auto] Page 1: Submitting #form-captcha');
                  nodeFormSubmit(captchaForm);
                }, 1000);
              }
            }
          }).catch(() => {});
        }

        // "LL" ad-gate template (intercelestial.com/teknoasian.com) gets
        // handed off to a dedicated, isolated browser instance (see
        // resolvers/llAdGate.js) rather than clicked through in-page on this
        // shared job page/context. resolveLLAdGate deliberately reproduces
        // the one configuration that showed signs of working earlier in
        // this investigation — raw patchright.launchPersistentContext (not
        // BrowserManager), a fresh throwaway profile deleted after every
        // run, no injected automation script, and real page.click() for
        // every button — rather than this app's usual stealth/speedup
        // stack, specifically to test whether that config reproduces.
        // Isolation is also a genuine, separate win regardless of outcome:
        // a wall/hang/crash here can't take down the shared page/context
        // everything else (GDFlix, captcha solving) runs in.
        if (url && isLLAdGateUrl(url) && !handledLLGate) {
          handledLLGate = true;
          let llResult;
          try {
            llResult = await resolveLLAdGate(url, { ctx });
          } catch (err) {
            // One shot per job attempt — spawning a whole new browser
            // instance to retry immediately would be wasteful, and a fresh
            // job-queue retry gets a genuinely fresh session anyway. Fail
            // fast rather than let the shared page idle out the rest of the
            // job timeout sitting on the same unresolved ad-gate URL.
            throw new Error(`LL ad-gate resolve failed: ${err.message}`);
          }
          ctx.log?.(`LL ad-gate resolved to ${shorten(llResult.finalUrl)}`);
          // Checkpoint immediately, regardless of whether this destination
          // also happens to match CHECKPOINT_HOSTS below — escaping this
          // gate is the slowest, most failure-prone step in the whole
          // chain, so a retry after any later failure should never have to
          // walk it again. maybeCheckpoint() only fires for whatever
          // CHECKPOINT_HOSTS/GDFlix URL a later loop iteration happens to
          // land on, which isn't guaranteed if the chain fails on some
          // intermediate hop before reaching one of those hosts.
          ctx.setCheckpoint?.(llResult.finalUrl);
          lastCheckpointedUrl = llResult.finalUrl;
          await p.goto(llResult.finalUrl, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
        }

        // Reached GDFlix — run the resolver once.
        if (isGdflixUrl(url) && !handledGdflix) {
          handledGdflix = true;
          const res = await resolveGdflix(
            p,
            { credentials: this.config.bypass.gdflix, captcha: this.captcha },
            ctx,
          ).catch((err) => {
            if (err?.terminal) throw err; // unrecoverable (e.g. login required) — stop looping, fail the job now
            if (err?.dead) throw err; // confirmed-dead file — stop looping, mark the job dead
            ctx.log?.(`GDFlix resolve error: ${err.message}`);
            return null;
          });
          if (res) return res;
          handledGdflix = false; // allow retry if page changed
        }

        // If a captcha is blocking this tab, try to solve it.
        const cap = await detectCaptcha(p);
        if (cap?.present) {
          ctx.log?.(`Captcha detected (${cap.kind}) at ${shorten(url)}`);
          if (cap.kind === 'recaptcha-v2') {
            const autoSolved = await tryAutoClickRecaptchaCheckbox(p);
            if (autoSolved) {
              ctx.log?.(`reCAPTCHA solved by checkbox click alone — no challenge, no manual/paid solve needed`);
              continue;
            }
          }
          // ManualSolver waits up to 5 minutes for a human to solve it — well
          // past the default 180s job timeout. Without this, the outer
          // `while (Date.now() < deadline)` check (which can't fire until
          // this blocking await returns) sees the deadline as already
          // expired the moment solve() comes back, and reports "Timed out"
          // even on a successful solve — a real human's correct answer just
          // silently discarded because it took longer than 3 minutes to
          // find it. Extending the deadline past whatever this solve() call
          // could take means a genuine solve always gets the chance to be
          // acted on; it only ever pushes the deadline OUT, never in, so
          // paid/automated solvers (which finish in seconds) are unaffected.
          deadline = Math.max(deadline, Date.now() + 5 * 60 * 1000 + 15_000);
          await this.captcha.solve(p, ctx).catch(() => {});
        }
      }

      await pages[0].waitForTimeout(1000);
    }
    return null;
  }
}

function shorten(u) {
  if (!u) return '';
  return u.length > 70 ? `${u.slice(0, 67)}…` : u;
}

// page.evaluate() has NO built-in timeout — if the page's own JS main
// thread ever deadlocks (observed live: rapid decoy-clear-and-reclick
// cycles racing the site's own sped-up regeneration timer can wedge it),
// the CDP Runtime.evaluate call just waits forever, which hangs this
// function's caller, which hangs the whole _driveToFinal poll loop —
// including its own `Date.now() < deadline` check, since that's on the far
// side of the stuck await. Racing every evaluate() in the hot click/check
// path against an explicit timeout is what lets a wedged page still time
// out and retry instead of hanging the job (and the whole poll loop, and
// every other tab it's tracking) indefinitely.
function evaluateWithTimeout(page, fn, arg, timeoutMs = 4000) {
  const evalPromise = arg === undefined ? page.evaluate(fn) : page.evaluate(fn, arg);
  const timeoutPromise = new Promise((resolve) => setTimeout(() => resolve(undefined), timeoutMs));
  return Promise.race([evalPromise.catch(() => undefined), timeoutPromise]);
}

// Same rationale as evaluateWithTimeout — page.close() on a wedged page
// (e.g. a popup whose own JS is stuck) can hang the poll loop too.
function closeWithTimeout(page, timeoutMs = 3000) {
  const closePromise = page.close().catch(() => {});
  const timeoutPromise = new Promise((resolve) => setTimeout(resolve, timeoutMs));
  return Promise.race([closePromise, timeoutPromise]);
}

export default BypassEngine;
