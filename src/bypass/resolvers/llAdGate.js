import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from '../../core/logger.js';
import { isAntiAutomationWallPage } from '../antiAutomationWall.js';

const log = createLogger('resolver:llAdGate');
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const LL_AD_GATE_HOSTS = ['intercelestial.com', 'teknoasian.com'];

export function isLLAdGateUrl(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return LL_AD_GATE_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

const randomDelay = (minMs, maxMs) => minMs + Math.random() * (maxMs - minMs);

// Allowlist, not a blocklist — reported live: an "I'm not a robot"-
// labeled .myButton sitting next to the real target got clicked instead,
// and trying to enumerate every possible decoy/honeypot label (the
// reference project's own reverse-engineered notes on this exact gate,
// INTERCELESTIAL_ISSUES.md's "honeypot" section, describe deliberately-
// placed trap buttons styled to blend in with the real ones) is a losing
// battle — the site can add a new decoy text we've never seen at any
// time. Only the button texts actually confirmed live across this whole
// investigation ever need clicking; anything else — decoy, honeypot, or
// some future label we haven't seen — is never a valid target by
// construction, no enumeration needed. Shared between readButtonState's
// target selection and findClickableInstance's final click-time scan so
// neither can land on anything outside this set, at either step.
const REAL_BUTTON_TEXT_PATTERN = 'continue|generate link|get link|get verified link|verified link|click to verify';

// Deliberately NOT awaited by callers — closing a real Chrome process and
// recursively deleting its profile directory (cache, cookie DB, etc.) is
// genuinely slow (can run into multiple seconds, worse on Windows), and
// none of it needs to finish before the caller acts on an already-known
// result. Reported live: the main browser sat idle for a visible beat
// after "[llGate] Escaped ad-gate to ..." was logged before it actually
// navigated there — that gap was this cleanup blocking the function's
// return, not anything about the navigation itself.
function cleanupInBackground(browser, profileDir) {
  browser
    .close()
    .catch((err) => log.warn(`Cleanup error: ${err.message}`))
    .finally(() => {
      // profileDir is null under CDP mode (see acquireIsolatedContext) —
      // there's no local profile directory to delete, and closing the
      // context there only ends this one isolated context, not the shared
      // remote Chrome process itself (which keeps running on the client
      // PC for the next job).
      if (!profileDir) return;
      fs.promises.rm(profileDir, { recursive: true, force: true }).catch((err) => {
        log.warn(`Profile cleanup error: ${err.message}`);
      });
    });
}

/**
 * Gets a fresh, isolated browser context to run the gate in — either a
 * genuinely new local Chrome process with a throwaway profile (the
 * original design), or, when `config.bypass.cdpEnabled`/`cdpUrl` are set,
 * a fresh incognito-style context on an ALREADY-RUNNING remote Chrome
 * instance (connectOverCDP + newContext, same pattern BrowserManager's own
 * CDP mode uses — see browser.js). The latter is what makes this resolver
 * usable from a Linux server/Docker container with no display of its own:
 * the server never launches a browser locally at all, it only drives
 * Chrome running on the operator's own PC over the network. `newContext()`
 * on a shared remote Browser still gets its own cookie jar/storage — the
 * "genuinely fresh session every run" property this resolver depends on
 * (see the module docstring on why that matters) holds either way, it's
 * just a new BrowserContext within one long-lived Chrome process instead
 * of a brand new OS process.
 *
 * @returns {Promise<{context: import('patchright').BrowserContext, profileDir: string|null}>}
 */
async function acquireIsolatedContext(config) {
  const cdpUrl = config?.bypass?.cdpUrl;
  const cdpEnabled = config?.bypass?.cdpEnabled;
  const pw = await import('patchright');

  if (cdpEnabled && cdpUrl) {
    const remoteBrowser = await pw.chromium.connectOverCDP(cdpUrl);
    const context = await remoteBrowser.newContext({ viewport: { width: 1366, height: 768 } });
    return { context, profileDir: null };
  }

  const profileDir = path.resolve(
    __dirname, '..', '..', '..', 'data',
    `llgate-run-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  const context = await pw.chromium.launchPersistentContext(profileDir, {
    headless: false,
    channel: 'chrome',
    viewport: { width: 1366, height: 768 },
    // NOT --start-minimized — launches visible, then gets explicitly
    // minimized below via CDP after bringToFront(). Requested despite the
    // acknowledged risk: an earlier direct A/B test found the window
    // minimized AT ANY POINT during this flow — not just at launch — is
    // enough to reproduce the failure (24 of 28 attempts, never past the
    // first step), since Chrome throttles a hidden/minimized tab's JS
    // (Page Visibility API) and this template's own decoy-overlay-clearing
    // logic appears to depend on that JS running continuously throughout,
    // not just at startup. If failures return to that pattern, minimizing
    // below is the first thing to revert.
  });
  return { context, profileDir };
}

/**
 * Reads which .myButton instance (if any) is the real target — the first
 * one NOT labeled "scroll" — and whether it's currently on-screen, plus
 * whether a "Scroll Down" placeholder exists at all. Shared by the sweep
 * logic below and the main loop so both act on the exact same snapshot.
 *
 * Confirmed live: this template can render its button entirely inside an
 * iframe (diagnostic log showed `iframes=1` while `.myButton count=0` at
 * every scroll position — the button was never missing, it was just never
 * looked for in the right document). `page.evaluate()` only ever sees the
 * main frame, so this now runs the same detection in EVERY frame
 * (`page.frames()`, main frame included) and returns whichever frame
 * actually has a real target — that frame is carried on the result so
 * callers scroll/click inside it, not blindly against the main page.
 */
export async function readButtonState(page) {
  const detectInFrame = (frame) =>
    frame
    .evaluate((realPattern) => {
      const isRealLabel = (text) => new RegExp(realPattern, 'i').test(text);
      const buttons = Array.from(document.querySelectorAll('.myButton')).map((el) => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        const renderable =
          rect.width > 0 &&
          rect.height > 0 &&
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          parseFloat(style.opacity || '1') > 0;
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const visible = renderable && cx >= 0 && cx <= window.innerWidth && cy >= 0 && cy <= window.innerHeight;
        const centered = renderable && cx >= 0 && cx <= window.innerWidth && cy >= 90 && cy <= window.innerHeight - 90;
        let uncovered = false;
        if (visible) {
          const top = document.elementFromPoint(cx, cy);
          uncovered = !!(top && (top === el || el.contains(top) || top.contains(el)));
        }
        return {
          text: (el.textContent || '').trim(),
          renderable,
          visible,
          centered,
          uncovered,
          top: Math.round(rect.top),
        };
      });
      // Prefer a matching button that is visible & uncovered, then visible, then renderable,
      // so a hidden 0x0 decoy never shadows a real button in the middle of the page.
      const realCandidates = buttons
        .map((b, i) => ({ b, i }))
        .filter(({ b }) => isRealLabel(b.text));
      const picked =
        realCandidates.find(({ b }) => b.visible && b.uncovered) ||
        realCandidates.find(({ b }) => b.visible) ||
        realCandidates.find(({ b }) => b.renderable) ||
        realCandidates[0];
      const targetIndex = picked ? picked.i : -1;
      const wbEl = document.getElementById('wb');
      const wbText = wbEl ? (wbEl.textContent || '').trim() : '';
      return {
        hasWb: !!wbEl && isRealLabel(wbText),
        hasMyButton: buttons.length > 0,
        targetIndex,
        targetVisible: targetIndex >= 0 ? buttons[targetIndex].visible : false,
        targetCentered: targetIndex >= 0 ? buttons[targetIndex].centered : false,
        targetUncovered: targetIndex >= 0 ? buttons[targetIndex].uncovered : false,
        targetTop: targetIndex >= 0 ? buttons[targetIndex].top : null,
        hasScrollButton: buttons.some((b) => /scroll/i.test(b.text)),
        buttonCount: buttons.length,
        scrollY: Math.round(window.scrollY),
        wbText,
        buttonsSummary: buttons.map((b, i) => `${i}:"${b.text.slice(0, 20)}"${b.visible ? '(vis)' : ''}@${b.top}`).join(', '),
        iframeCount: document.querySelectorAll('iframe').length,
      };
    }, REAL_BUTTON_TEXT_PATTERN)
    .catch(() => null);

  const frames = page.frames();
  const results = await Promise.all(frames.map(detectInFrame));

  let winner = null;
  let winnerFrame = null;
  for (let i = 0; i < frames.length; i++) {
    const r = results[i];
    if (r && (r.hasWb || r.targetIndex >= 0)) {
      winner = r;
      winnerFrame = frames[i];
      break;
    }
  }
  if (!winner) {
    winner = results[0] || {
      hasWb: false, hasMyButton: false, targetIndex: -1, targetVisible: false, targetCentered: false,
      targetUncovered: false, hasScrollButton: false, buttonCount: 0, scrollY: -1, wbText: '',
      buttonsSummary: '', iframeCount: -1,
    };
    winnerFrame = page.mainFrame();
  }
  return { ...winner, frame: winnerFrame, frameCount: frames.length };
}

/**
 * Sweeps all the way to one end of the page (real, trusted mouse-wheel
 * events, not JS scrollTo/scrollBy) rather than a single computed jump.
 * Confirmed live: this template can shift which .myButton instance is the
 * real one unpredictably as earlier steps complete (content loading/
 * collapsing), so a "smart" scroll to one specific element isn't reliable
 * enough on its own — a full sweep to a page extreme is a fixed, always-
 * reachable reference point a human effectively falls back on too when a
 * page's layout misbehaves.
 *
 * Reported live: the button at the top still often never entered the
 * viewport — this page has scroll CONTAINERS NESTED inside it, not just
 * the top-level window. page.mouse.wheel() only scrolls whatever's under
 * the mouse's current position (wherever a previous click left it, not
 * necessarily over the real scrollable content), and tracking only
 * window.scrollY as the stopping signal means a nested container that's
 * still mid-scroll gets mistaken for "reached the end" the moment the
 * outer window (which may already be static) stops moving. Now
 * repositions the mouse over the viewport center before every tick so the
 * wheel event reliably lands on real content, and tracks the deepest
 * scrollTop found across EVERY scrollable element on the page (not just
 * window), so the loop only stops once nothing — at any nesting level —
 * is still moving.
 *
 * Reported live: a button sitting in the MIDDLE of the page was still
 * getting missed even with this sweep in place — because the caller only
 * ever checked readButtonState() AFTER the sweep finished, once it had
 * already run all the way to the extreme. A button that only renders (or
 * is only genuinely visible) while scrolled near its own position, and
 * disappears again once scrolled past, was never caught — the check
 * happened too late, at the wrong scroll position entirely. `checkFn`
 * (readButtonState, from the caller) now runs after EVERY tick, and the
 * sweep stops the instant it reports a real, visible target — instead of
 * always running the full 25-tick trip to the extreme first regardless.
 */
export async function sweepToExtreme(page, direction, deadline, checkFn) {
  // Step by 450px (< 768px viewport height) so there is always ~318px of
  // overlap between consecutive ticks and a button in the middle of the
  // page (even surrounded by tall ads) can never be jumped over.
  const stepPx = 450;
  const deltaY = direction === 'down' ? stepPx : -stepPx;
  const viewport = page.viewportSize() || { width: 1366, height: 768 };
  const cx = Math.round(viewport.width / 2);
  const cy = Math.round(viewport.height / 2);
  let lastSignature = null;
  for (let i = 0; i < 40 && Date.now() < deadline; i++) {
    await page.mouse.move(cx, cy).catch(() => {});
    await page.mouse.wheel(0, deltaY).catch(() => {});
    // Scroll nested scrollable containers incrementally too (not straight to
    // scrollHeight/0 in one jump, which would skip a middle-positioned button).
    await page
      .evaluate((dy) => {
        document.querySelectorAll('*').forEach((el) => {
          if (el === document.documentElement || el === document.body) return;
          if (el.scrollHeight - el.clientHeight > 10) {
            el.scrollTop += dy;
          }
        });
      }, deltaY)
      .catch(() => {});
    await page.waitForTimeout(randomDelay(150, 300));

    if (checkFn) {
      const state = await checkFn();
      if (state && (state.hasWb || (state.targetIndex >= 0 && state.targetVisible))) {
        return state; // found mid-sweep — stop right here, don't keep scrolling past it
      }
    }

    const signature = await page
      .evaluate(() => {
        const tops = Array.from(document.querySelectorAll('*'))
          .filter((el) => el !== document.documentElement && el !== document.body && el.scrollHeight - el.clientHeight > 10)
          .map((el) => Math.round(el.scrollTop));
        return [Math.round(window.scrollY), ...tops].join(',');
      })
      .catch(() => null);
    if (signature === null) break;
    if (signature === lastSignature) break; // nothing, at any level, still moving
    lastSignature = signature;
  }
  return null;
}

/**
 * Confirmed live: this template can put TWO `.myButton` instances on the
 * page at once (e.g. one near the top, one further down after a "Scroll
 * Down" step) — `document.querySelector` would always grab whichever is
 * first in DOM order, even if that one is off-screen/behind the scroll
 * position and the OTHER instance is the one actually visible and
 * interactable right now. Scans every instance and returns the index of
 * whichever one is both on-screen and not covered by a decoy overlay (the
 * cursor would genuinely show a hand over it) — or -1 if none qualify yet.
 *
 * Takes a Frame, not necessarily the Page's main frame — readButtonState
 * may have found the real target inside an iframe (see its own comment),
 * and the click-time scan has to run in that same document or it would
 * always see zero elements, same bug as before.
 */
export async function findClickableInstance(frame, selector, allowTextPattern) {
  return frame
    .evaluate(({ sel, allowPattern }) => {
      const allow = allowPattern ? new RegExp(allowPattern, 'i') : null;
      const els = Array.from(document.querySelectorAll(sel));
      // Probe center first, then 4 inner points in case a small floating ad
      // overlaps one part of the button while another part is clear.
      const probeOffsets = [
        [0.5, 0.5],
        [0.25, 0.5],
        [0.75, 0.5],
        [0.5, 0.25],
        [0.5, 0.75],
      ];
      for (let i = 0; i < els.length; i++) {
        const el = els[i];
        if (allow && !allow.test((el.textContent || '').trim())) continue;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity || '1') === 0) continue;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        for (const [rx, ry] of probeOffsets) {
          const px = rect.left + rect.width * rx;
          const py = rect.top + rect.height * ry;
          if (px < 0 || px > window.innerWidth || py < 0 || py > window.innerHeight) continue;
          const top = document.elementFromPoint(px, py);
          if (!top) continue;
          if (top === el || el.contains(top) || top.contains(el)) {
            return {
              index: i,
              position: {
                x: Math.round(rect.width * rx),
                y: Math.round(rect.height * ry),
              },
            };
          }
        }
      }
      return null;
    }, { sel: selector, allowPattern: allowTextPattern || null })
    .catch(() => null);
}

async function clickWhenClear(page, frame, ctx, selector, deadline, allowTextPattern) {
  let blockedTicks = 0;
  while (Date.now() < deadline) {
    const found = await findClickableInstance(frame, selector, allowTextPattern);
    if (found) {
      const clicked = await frame
        .locator(selector)
        .nth(found.index)
        .click({ position: found.position, timeout: 3000 })
        .then(() => true)
        .catch((err) => {
          ctx.log?.(`[llGate] Click raced with an overlay reappearing — waiting for clear again (${err.message.split('\n')[0]})`);
          return false;
        });
      if (clicked) return true;
    } else {
      blockedTicks++;
      // If an ad or sticky bar is parked right over the button, re-center it
      // (and alternate small nudges) so it moves into a clear band.
      if (blockedTicks % 3 === 0) {
        const nudge = (blockedTicks / 3) % 2 === 1 ? 0 : 120;
        await frame
          .evaluate(({ sel, allowPattern, dy }) => {
            const allow = allowPattern ? new RegExp(allowPattern, 'i') : null;
            const els = Array.from(document.querySelectorAll(sel));
            const target = els.find((el) => !allow || allow.test((el.textContent || '').trim()));
            if (target) {
              target.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
              if (dy) window.scrollBy(0, dy);
            }
          }, { sel: selector, allowPattern: allowTextPattern || null, dy: nudge })
          .catch(() => {});
      }
    }
    await page.waitForTimeout(randomDelay(200, 500));
  }
  return false;
}

// TEMPORARY diagnostic — reported live: a full sweep (top, bottom, direct
// scroll) still finds nothing, AND nothing is visually present on screen
// either, not just off-screen/unscrolled-to. The iframe-awareness added to
// readButtonState above was a guess about WHERE the button might be, not a
// confirmed answer — an iframe present on the page doesn't necessarily mean
// it holds real gate content (could just as easily be an ad tracking pixel,
// 0x0 or off-screen by design). This dumps what's ACTUALLY rendered in
// every frame — visible body text and every iframe's src/size/visibility —
// so the next occurrence shows the real page state instead of another
// guess. Remove once the real cause here is confirmed.
async function dumpFrameDiagnostics(page, ctx) {
  for (const frame of page.frames()) {
    const info = await frame
      .evaluate(() => ({
        bodyText: (document.body?.innerText || '').trim().slice(0, 200),
        iframes: Array.from(document.querySelectorAll('iframe')).map((f) => ({
          src: (f.getAttribute('src') || '').slice(0, 80),
          w: f.offsetWidth,
          h: f.offsetHeight,
        })),
      }))
      .catch(() => null);
    if (!info) {
      ctx.log?.(`[llGate][diag] frame ${frame.url().slice(0, 60)} — evaluate failed (detached/cross-origin?)`);
      continue;
    }
    ctx.log?.(
      `[llGate][diag] frame ${frame.url().slice(0, 60)} bodyText="${info.bodyText.replace(/\s+/g, ' ')}" iframes=${JSON.stringify(info.iframes)}`,
    );
  }
}

/**
 * Resolves an intercelestial.com/teknoasian.com "LL" ad-gate link by
 * reproducing — deliberately, exactly — the one configuration that showed
 * signs of working earlier in this investigation, instead of the app's
 * usual automation stack:
 *   - raw `patchright.chromium.launchPersistentContext()`, NOT BrowserManager
 *     — or, under `bypass.cdpEnabled`, a fresh context on a remote Chrome
 *     the operator runs themselves (see acquireIsolatedContext) so this
 *     can run from a server/Docker container with no display of its own
 *   - a genuinely fresh profile dir, deleted when this call finishes (or,
 *     under CDP mode, a genuinely fresh BrowserContext on the shared
 *     remote browser, closed when this call finishes — same "no leftover
 *     session" property either way)
 *   - no injected automation script at all (no getInjectedAutomationScript,
 *     no decoy-stripper, no DOMAIN_RULES, no speedup-timer override)
 *   - `page.click()` (Playwright's real, trusted click) for every button,
 *     no synthetic el.click()
 *   - fully isolated: its own profile/context, closed on every exit path
 *
 * This intentionally does NOT reuse bypass/index.js's evaluateWithTimeout
 * or any of the click-decoy-clearing logic built up earlier — the point of
 * this run is to test whether the earlier result reproduces under this
 * exact, minimal configuration, not to carry over this session's other
 * fixes.
 *
 * @param {string} startUrl the intercelestial.com/teknoasian.com entry link
 * @param {object} opts
 * @param {{log?: (msg: string) => void}} [opts.ctx] optional job-log sink
 * @param {object} [opts.config] app config — only `bypass.cdpEnabled`/
 *   `bypass.cdpUrl` are read, to decide between a local throwaway-profile
 *   launch and a fresh context on a remote Chrome (see
 *   acquireIsolatedContext for why both still give a genuinely clean
 *   session either way)
 * @param {number} [opts.timeoutMs] overall budget for this resolver
 * @returns {Promise<{finalUrl: string}>}
 */
export async function resolveLLAdGate(startUrl, { ctx = {}, config = {}, timeoutMs = 120000 } = {}) {
  const { context: browser, profileDir } = await acquireIsolatedContext(config);

  try {
    const page = await browser.newPage();

    // Confirmed via the community reference project's own reverse-engineered
    // detection doc (INTERCELESTIAL_ISSUES.md, "dns-probes"/"decision-matrix"):
    // the gate fetches 5 real Google/Amazon ad-network URLs and treats ≥2
    // failures as a block signal (path C) — logged there as fired exactly
    // this way via ERR_BLOCKED_BY_CLIENT. This network independently blocks
    // Google ad domains at the DNS/network level (confirmed earlier this
    // session via the same pagead2.googlesyndication.com fetch failing even
    // in a real, non-automated browser) — so this isolated resolver's own
    // requests to these URLs fail for a reason that has nothing to do with
    // automation, and reads to the gate as "adblocker/bot". browser.js's
    // newPage() already fakes the one of these five the main pipeline needs
    // (adsbygoogle.js); this resolver runs its own separate raw patchright
    // context and never got that fix, so all five stay faked here.
    const AD_PROBE_URLS = [
      '**://pagead2.googlesyndication.com/pagead/show_ads.js*',
      '**://securepubads.g.doubleclick.net/tag/js/gpt.js*',
      '**://www.googletagservices.com/tag/js/gpt.js*',
      '**://s.amazon-adsystem.com/aax2/apstag.js*',
      '**://www.googleadservices.com/pagead/conversion_async.js*',
    ];
    for (const pattern of AD_PROBE_URLS) {
      await page.route(pattern, (route) =>
        route.fulfill({ status: 200, contentType: 'application/javascript', body: '' }),
      ).catch(() => {});
    }

    // Confirmed live (both the original A/B test and every minimize
    // variant tried since — start-minimized, show-then-immediately-
    // minimize, show-for-5s-then-minimize): this gate genuinely needs the
    // window focused and visible for the ENTIRE run, not just at launch or
    // for an initial settle window. Minimizing it at any point reliably
    // breaks the site's own decoy-clearing logic (Chrome throttles a
    // hidden/minimized tab's JS via the Page Visibility API), so this
    // stays fully visible throughout — no minimizeWindow() call anywhere
    // in this resolver. bringToFront() is what actually made the
    // difference in the original A/B test; without it this run got stuck
    // the same way a minimized one did.
    await page.bringToFront().catch(() => {});

    // Every .myButton click reliably pop-unders a new tab (this template's
    // own ad monetization) and Chrome hands THAT tab focus — so our actual
    // page immediately goes back to being the non-visible/throttled one
    // again, defeating the bringToFront() above within one click. Close
    // every popup the instant it opens and reclaim focus on our page, so
    // it stays the visible/active tab for the resolver's whole run instead
    // of just its first instant.
    browser.on('page', (popup) => {
      // Requested: this was closing popups with zero record of what they
      // were. window.open(url)-style popups (confirmed this template's own
      // pattern) usually already have their URL by the time this event
      // fires; log whatever's available immediately, then close — closing
      // is never delayed waiting on this.
      const popupUrl = (() => { try { return popup.url(); } catch { return null; } })();
      ctx.log?.(`[llGate] Closing popup: ${popupUrl && popupUrl !== 'about:blank' ? popupUrl.slice(0, 80) : '(url not yet available)'}`);
      popup.close().catch(() => {});
      page.bringToFront().catch(() => {});
    });

    ctx.log?.(`[llGate] Fresh patchright instance resolving ${startUrl.slice(0, 60)}…`);
    await page.goto(startUrl, { waitUntil: 'load', timeout: 30000 }).catch(() => {});

    const deadline = Date.now() + timeoutMs;
    let lastUrl = page.url();
    // TEMPORARY diagnostic — investigating a reported live case where the
    // button was never detected at any scroll position (top/middle/
    // bottom) on a second intercelestial.com landing, with the hypothesis
    // that the page adds a NEW .myButton above the existing one(s) and
    // shifts things in a way targetIndex/scrollHeight don't handle. Only
    // logs when the button count actually changes, so this stays cheap
    // and doesn't spam every 500ms tick. Remove once the real cause here
    // is identified.
    let lastLoggedButtonCount = -1;
    let loggedRecaptchaPresence = false;
    let loggedFrameDiag = false;
    while (Date.now() < deadline) {
      if (page.isClosed()) throw new Error('LL ad-gate page closed unexpectedly');
      const url = page.url();

      if (url && url !== 'about:blank' && !isLLAdGateUrl(url)) {
        ctx.log?.(`[llGate] Escaped ad-gate to ${url.slice(0, 60)}…`);
        cleanupInBackground(browser, profileDir);
        return { finalUrl: url };
      }

      // Confirmed live: clicking through to the next step here is a real
      // page navigation (a "2nd visit"), not just DOM mutation on the same
      // page — checking/clicking immediately after landing means acting on
      // a page that hasn't actually finished settling yet (the button
      // click-decoy detection above can read stale/incomplete state), which
      // is a real cause of the scroll-down step getting missed entirely.
      // Give a fresh navigation a moment before doing anything else this
      // iteration.
      if (url !== lastUrl) {
        lastUrl = url;
        ctx.log?.(`[llGate] Landed on a new page (${url.slice(0, 60)}…) — letting it settle`);
        await page.waitForLoadState('load', { timeout: 10000 }).catch(() => {});
        await page.waitForTimeout(randomDelay(1200, 2200));
        continue;
      }

      const pageText = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
      if (isAntiAutomationWallPage(pageText)) {
        throw new Error(`LL ad-gate wall detected at ${url}`);
      }

      // Reported live: intercelestial.com's own recaptcha-checkbox-border
      // element got clicked and that was actively wrong here — disabled.
      // Detection kept (cheap, useful in the diagnostic log below) but the
      // auto-click is gone; this gate's own .myButton/#wb allowlist flow
      // is what actually needs to run undisturbed, not a checkbox click
      // that was never confirmed to help THIS specific gate and, per the
      // user, should never be touched at all here.
      const hasRecaptcha = await page
        .evaluate(() => !!document.querySelector('iframe[src*="recaptcha/api2/anchor"], .recaptcha-checkbox-border'))
        .catch(() => false);
      if (hasRecaptcha && !loggedRecaptchaPresence) {
        loggedRecaptchaPresence = true;
        ctx.log?.('[llGate] recaptcha-checkbox-border element present — deliberately not clicking it (see comment above)');
      }

      // Confirmed live: this template can show TWO .myButton instances at
      // once (e.g. one near the top, one further down after a scroll
      // step), and separately can present a "Scroll Down" step with no
      // real button to click yet at all. Scanning every instance up front
      // — instead of just the first DOM match — means the scroll-vs-click
      // decision below is based on what's actually usable right now, not
      // on whichever button happens to come first in the markup.
      let buttonState = await readButtonState(page);
      if (buttonState.buttonCount !== lastLoggedButtonCount) {
        lastLoggedButtonCount = buttonState.buttonCount;
        ctx.log?.(
          `[llGate][diag] .myButton count=${buttonState.buttonCount} iframes=${buttonState.iframeCount} frames=${buttonState.frameCount} scrollY=${buttonState.scrollY} targetIndex=${buttonState.targetIndex} targetVisible=${buttonState.targetVisible} wb="${buttonState.wbText}"(allowed=${buttonState.hasWb}) → [${buttonState.buttonsSummary}]`,
        );
      }

      // Primary: a real target already exists in the DOM (even off-screen)
      // — scroll directly to that exact element via Playwright's own
      // actionability scrolling. Deterministic for ANY position on the
      // page, not just the two extremes: confirmed live, a sweep-only
      // strategy (scroll to the bottom, then the top) misses a target that
      // sits in the MIDDLE of a page taller than one viewport, since
      // neither extreme ever shows it — that was a real gap, not a timing
      // fluke.
      // Primary: a real target already exists in the DOM (off-screen, near a
      // sticky-ad viewport edge, or covered by an edge/floating ad) — scroll
      // it directly to the vertical CENTER of the viewport. Using block:'center'
      // works uniformly whether the target is above, below, or in the middle of
      // the page, and keeps it clear of top/bottom sticky ad banners.
      if (!buttonState.hasWb && buttonState.targetIndex >= 0 && (!buttonState.targetVisible || !buttonState.targetCentered || !buttonState.targetUncovered)) {
        ctx.log?.('[llGate] Centering target button in viewport (away from edge/sticky ads)');
        if (buttonState.frame !== page.mainFrame()) {
          const frameEl = await buttonState.frame.frameElement().catch(() => null);
          await frameEl?.evaluate((el) => el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })).catch(() => {});
        }
        const targetLoc = buttonState.frame.locator('.myButton').nth(buttonState.targetIndex);
        await targetLoc
          .evaluate((el) => el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }))
          .catch(() => targetLoc.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {}));
        await page.waitForTimeout(randomDelay(200, 400));
        buttonState = await readButtonState(page);
      }

      // Reported live: right after Cloudflare's own interstitial clears (no
      // URL change happens for that transition, so the "landed on a new
      // page" settle-wait above never fires for it), the real button is
      // often already on-screen near the top the instant real content
      // renders — but a check that lands mid-transition can transiently
      // miss it entirely (targetIndex still -1, no position signal to
      // sweep toward yet), and the page was left scrolled wherever the
      // interstitial happened to leave it, not necessarily the top. Cheap,
      // near-instant check first: jump straight to the top and recheck —
      // resolves the common case immediately without ever touching the
      // slower, further-displacing sweep loop below.
      if (!buttonState.hasWb && buttonState.targetIndex < 0 && buttonState.scrollY > 0) {
        await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
        await page.waitForTimeout(randomDelay(200, 400));
        buttonState = await readButtonState(page);
      }

      // Fallback: either no real target exists in the DOM at all yet (a
      // page that lazy-reveals the next button only once scrolled), or
      // the direct scroll above still didn't leave it visible for some
      // reason — sweep both fixed extremes as a last resort. Reported
      // live: this template can also reshuffle which instance is the real
      // one unpredictably as earlier steps complete, which a single direct
      // scroll can race against; two fixed, always-reachable reference
      // points is what a human effectively falls back on too.
      //
      // Reported live: a button sitting near the TOP consistently failed to
      // ever land in the viewport — root cause was this always sweeping to
      // the BOTTOM first regardless of where the button actually is, then
      // sweeping back up; that round trip (through however much lazy-
      // loaded/reshuffled content the bottom sweep touches along the way)
      // isn't guaranteed to land back at true scrollY=0 the same way a
      // direct up-sweep from the current position does. `targetTop` (set
      // by the direct-scroll attempt's own readButtonState call above) is a
      // real, current signal for which side the button is actually on when
      // it's known at all — use it to sweep toward the button first, and
      // only fall back to the fixed down-then-up order when the button
      // isn't in the DOM yet at all (targetTop is null) and there's no
      // position signal to go on.
      if (!buttonState.hasWb && (buttonState.targetIndex < 0 || !buttonState.targetVisible)) {
        const sweepUpFirst = buttonState.targetTop != null && buttonState.targetTop < 0;
        const firstDir = sweepUpFirst ? 'up' : 'down';
        const secondDir = sweepUpFirst ? 'down' : 'up';
        // Reported live: sweeping UP and stopping the instant readButtonState
        // reports the target "visible" still landed it behind a sticky/
        // fixed header — targetVisible only checks the button's bounding
        // box against the viewport, not what's actually painted on top of
        // it, so a position a sticky bar covers can still read as
        // "visible". Scrolling up never needs the early-exit that helps
        // catch a MIDDLE-of-page target on the way down (there's no
        // equivalent "overshoot past it" risk going up toward a near-top
        // button) — so an upward sweep always runs the full trip to the
        // genuine top extreme, past wherever a sticky header settles,
        // instead of trusting an early "visible" reading that might be a
        // false positive.
        const checkFnFor = (dir) => (dir === 'up' ? undefined : () => readButtonState(page));

        ctx.log?.(`[llGate] Still not visible — sweeping to the ${firstDir === 'down' ? 'bottom' : 'top'} of the page`);
        const foundFirst = await sweepToExtreme(page, firstDir, deadline, checkFnFor(firstDir));
        buttonState = foundFirst || await readButtonState(page);

        if (!foundFirst && (buttonState.targetIndex < 0 || !buttonState.targetVisible)) {
          ctx.log?.(`[llGate] Not found at the ${firstDir === 'down' ? 'bottom' : 'top'} — sweeping to the ${secondDir === 'down' ? 'bottom' : 'top'} of the page`);
          const foundSecond = await sweepToExtreme(page, secondDir, deadline, checkFnFor(secondDir));
          buttonState = foundSecond || await readButtonState(page);
        }

        if (buttonState.targetIndex >= 0 && buttonState.targetVisible) {
          ctx.log?.('[llGate] Button now visible after sweeping');
        } else {
          ctx.log?.('[llGate] Still not visible after a full sweep — waiting for the page to change');
          if (!loggedFrameDiag) {
            loggedFrameDiag = true;
            await dumpFrameDiagnostics(page, ctx);
          }
          await page.waitForTimeout(randomDelay(500, 900));
          continue;
        }
      }

      const sel = buttonState.hasWb ? '#wb' : (buttonState.hasMyButton ? '.myButton' : null);
      if (sel) {
        // Reported live: when the target is already on-screen from the very
        // FIRST check (no scroll ever needed — confirmed right after
        // Cloudflare clears, the button can already be sitting near the
        // top), every scroll branch above is skipped entirely, so this
        // resolver used to go straight to clicking with ZERO prior
        // interaction of any kind — and the click just never took effect
        // until the user manually clicked or scrolled once first. Fixing
        // that needs SOME real interaction event first, but an earlier
        // version of this fix unconditionally scrolled all the way to the
        // page top before every click — wrong whenever the button is
        // actually further down the page (middle/bottom), since that
        // scrolls straight past it instead of near it. Only jump to the
        // true top when we're already near the top (scrollY close to 0) —
        // a full top-scroll there also settles any sticky/fixed header
        // that a tiny few-pixel nudge could leave half-activated, covering
        // the button. Anywhere else, a small net-zero wheel tick right in
        // place fires a genuine interaction event without relocating the
        // scroll position the earlier steps already got right.
        {
          const viewport = page.viewportSize() || { width: 1366, height: 768 };
          const cx = Math.round(viewport.width / 2);
          const cy = Math.round(viewport.height / 2);
          await page.mouse.move(cx, cy).catch(() => {});
          if (buttonState.scrollY != null && buttonState.scrollY < 50) {
            await page.mouse.wheel(0, -3000).catch(() => {});
            await page.waitForTimeout(150);
          } else {
            await page.mouse.wheel(0, 2).catch(() => {});
            await page.waitForTimeout(80);
            await page.mouse.wheel(0, -2).catch(() => {});
          }
        }
        // Requested: once a valid, on-screen target is confirmed, settle
        // for a full second before ever attempting the click — real wall-
        // clock time for whatever decoy-clearing/overlay JS the page runs
        // right after a button becomes visible to actually finish, rather
        // than racing it. clickWhenClear's own findClickableInstance check
        // still runs fresh after this wait, so a decoy that reappears
        // during it is still caught, not blindly clicked into.
        await page.waitForTimeout(1000);
        ctx.log?.(`[llGate] Waiting for ${sel} to clear (cursor genuinely a hand, not just present in the DOM)…`);
        // Always pass the allowlist, #wb included — "it's a unique id
        // selector" turned out NOT to mean "therefore safe" (see
        // REAL_BUTTON_TEXT_PATTERN's comment on readButtonState's hasWb
        // check above); defense in depth in case the element's text
        // changes between that check and this actual click.
        const clicked = await clickWhenClear(page, buttonState.frame, ctx, sel, deadline, REAL_BUTTON_TEXT_PATTERN);
        ctx.log?.(`[llGate] ${sel} ${clicked ? 'clicked' : 'never cleared before deadline — moving on'}`);
        // A little breathing room after a real click before checking again —
        // matches how a human actually interacts (not back-to-back at a
        // fixed 1000ms cadence every single tick), and gives the page time
        // to actually process the click before we look for the next state.
        await page.waitForTimeout(randomDelay(600, 1400));
      } else {
        await page.waitForTimeout(randomDelay(700, 1100));
      }
    }
    throw new Error('LL ad-gate resolver timed out');
  } catch (err) {
    cleanupInBackground(browser, profileDir);
    throw err;
  }
}

export default resolveLLAdGate;
