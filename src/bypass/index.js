import { createLogger } from '../core/logger.js';
import { BrowserManager } from './browser.js';
import { createCaptchaSolver, detectCaptcha } from './captcha/index.js';
import { isGdflixUrl, resolveGdflix, classifyFinalLink } from './resolvers/gdflix.js';
import { isGoogleAuthHost, ensureGoogleLogin, normalizeGoogleDriveLink } from './resolvers/googleDrive.js';
import { isDeadLinkPage } from './deadLinkPatterns.js';

const log = createLogger('bypass');

const FINAL_HOST_RE = /(drive\.google\.com|googleusercontent\.com|pixeldrain\.|pixeldra\.in|workers\.dev|\.r2\.)/i;

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
  constructor({ config }) {
    this.config = config;
    const headless = resolveHeadless(config);
    log.info(`Browser mode resolved: ${headless ? 'headless' : 'headful'} (browserMode=${config.bypass.browserMode}, captcha=${config.bypass.captcha?.provider})`);
    this.browser = new BrowserManager({
      profileDir: config.bypass.profileDir,
      headless,
      initialPageDelayMs: (config.bypass.initialPageDelaySeconds || 1.5) * 1000,
      config: config,
    });
    this.captcha = createCaptchaSolver(config, { headless });
  }

  async close() {
    await this.browser.close();
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

    const activePages = new Set([page]);
    const navListeners = new Map();

    const trackPage = (p) => {
      const navListener = (frame) => {
        if (frame === p.mainFrame()) {
          const u = frame.url();
          if (u && u !== 'about:blank') {
            hops.push(u);
            ctx.log?.(`→ ${shorten(u)}`);
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

    // Track any new tabs or popups created in this context
    const onPage = (newPage) => {
      activePages.add(newPage);
      ctx.log?.(`[tab] New tab opened: ${shorten(newPage.url())}`);
      trackPage(newPage);
    };
    context.on('page', onPage);

    try {
      ctx.log?.(`Starting: ${job.provider} ${job.quality || ''} — ${shorten(job.url)}`);
      await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});

      settled = await this._driveToFinal(activePages, ctx, timeoutMs);
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
      return { ...settled, hops };
    } finally {
      // Clean up context listeners and close all pages
      context.off('page', onPage);
      for (const p of activePages) {
        const listener = navListeners.get(p);
        if (listener) p.off('framenavigated', listener);
      }
      await this.browser.close().catch(() => {});
    }
  }

  /**
   * Poll all active pages/tabs in the context until one reaches GDFlix or a final host directly.
   */
  async _driveToFinal(activePages, ctx, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let handledGdflix = false;
    let handledGoogleAuth = false;
    const deadCheckedUrls = new Set();

    const WHITELIST_DOMAINS = this.config?.bypass?.tabPruningWhitelist || [
      'pahe.plus', 'old.pahe.plus', 'ouo.io', 'ouo.press', 'gdflix', 'drive.google', 
      'pixeldrain', 'pixeldra.in', 'teknoasian.com', 'spacetica.com', 'oii.la', 'linegee.net', 
      'tpi.li', 'wordcounter.icu', 'about:blank'
    ];

    while (Date.now() < deadline) {
      const pages = Array.from(activePages).filter(p => !p.isClosed());
      if (pages.length === 0) {
        throw new Error('All browser pages/tabs were closed');
      }

      for (const p of pages) {
        const url = p.url();

        // 1. Close failed/error tabs immediately
        if (url.includes('chrome-error://') || url.includes('chromewebdata')) {
          ctx.log?.(`[tab] Closing failed/error tab`);
          await p.close().catch(() => {});
          continue;
        }

        // 1b. Close search spam/ad redirect popup tabs immediately (always safe)
        const isInitialTabCheck = (p === pages[0] && pages.length === 1);
        if (!isInitialTabCheck && url && (url.includes('google.com/search') || url.includes('olxtoto'))) {
          ctx.log?.(`[tab] Closing ad redirect/spam popup: ${shorten(url)}`);
          await p.close().catch(() => {});
          continue;
        }

        // 2. Close unwanted ad popups (if enabled, and it's not the initial tab and not whitelisted)
        if (this.config?.bypass?.pruneAdTabs) {
          const isInitialTab = (p === pages[0] && pages.length === 1);
          if (!isInitialTab && url && url !== 'about:blank') {
            const isWhitelisted = WHITELIST_DOMAINS.some(d => url.toLowerCase().includes(d));
            if (!isWhitelisted) {
              ctx.log?.(`[tab] Closing unwanted ad popup tab: ${shorten(url)}`);
              await p.close().catch(() => {});
              continue;
            }
          }
        }

        // Confirmed-dead file check — once per distinct URL landed on, so we
        // don't re-evaluate the same static page every polling tick. Applies
        // at any hop (shortener, GDFlix, or the final Drive/pixeldrain page
        // itself), since "file removed" pages can appear anywhere in the chain.
        if (url && url !== 'about:blank' && !deadCheckedUrls.has(url)) {
          deadCheckedUrls.add(url);
          const pageText = await p.evaluate(() => document.body?.innerText || '').catch(() => '');
          if (isDeadLinkPage(pageText)) {
            throw Object.assign(new Error(`Dead link detected at ${shorten(url)}`), { dead: true });
          }
        }

        // Google sign-in wall reached mid-chain (e.g. a restricted-access Drive
        // link redirected here before the final drive.google.com URL). Inject
        // configured Google cookies so navigation can continue; no-ops quickly
        // if no cookies are configured. Guarded so we don't reload every
        // second if it doesn't resolve — one attempt per page landing here.
        if (isGoogleAuthHost(url) && !handledGoogleAuth) {
          handledGoogleAuth = true;
          await ensureGoogleLogin(p, this.config.bypass.google, ctx).catch((err) => {
            ctx.log?.(`Google login error: ${err.message}`);
          });
        }

        // Reached a final host directly.
        if (FINAL_HOST_RE.test(url)) {
          if (classifyFinalLink(url) === 'google-drive') {
            // Some Drive pages show an inline "Sign in" prompt rather than
            // redirecting to accounts.google.com — check here too. Cheap
            // no-op for the common public "anyone with the link" case.
            await ensureGoogleLogin(p, this.config.bypass.google, ctx).catch((err) => {
              ctx.log?.(`Google login error: ${err.message}`);
            });
            // Cookie injection may have reloaded/redirected the page.
            const settledUrl = p.url();
            return { finalUrl: settledUrl, linkType: classifyFinalLink(settledUrl) };
          }
          return { finalUrl: url, linkType: classifyFinalLink(url) };
        }

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

export default BypassEngine;
