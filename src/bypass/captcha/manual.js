import { randomUUID } from 'node:crypto';
import { bus } from '../../core/eventBus.js';
import { createLogger } from '../../core/logger.js';
import { restoreWindow, minimizeWindow } from '../windowControl.js';
import { AD_HOSTS } from '../userscript.js';

const log = createLogger('captcha:manual');

// Known-legitimate hosts a captcha page can plausibly navigate to once
// actually solved — every ad-chain host this app already knows about,
// plus the final destinations a chain can land on directly.
const PLAUSIBLE_PROGRESS_HOSTS = [...AD_HOSTS, 'gdflix', 'drive.google', 'googleusercontent.com', 'pixeldrain', 'pixeldra.in', 'workers.dev'];

/**
 * Reported live: a ouo.io captcha page navigated to an unrelated ad-
 * redirect chain (frs2c.com -> a random gambling affiliate site), and the
 * "any URL change = solved" heuristic below treated that hijack as a
 * genuine captcha-bypass success — the job then chased the gambling site
 * as if it were real progress until it failed outright. Only a navigation
 * to a STILL-plausible host (same site as the start URL, or one of this
 * app's own known ad-chain/final hosts) counts as real progress; anything
 * else is very likely an ad popup/redirect hijacking the tab, not the
 * captcha actually being solved.
 */
function isPlausibleProgressUrl(startUrl, currentUrl) {
  try {
    const startHost = new URL(startUrl).hostname.toLowerCase();
    const currentHost = new URL(currentUrl).hostname.toLowerCase();
    if (currentHost === startHost) return true;
    return PLAUSIBLE_PROGRESS_HOSTS.some((h) => currentHost === h || currentHost.endsWith(`.${h}`) || currentHost.includes(h));
  } catch {
    return false;
  }
}

/**
 * Manual solver. Emits `captcha:needed` to the GUI and waits for the operator
 * to solve the captcha (in a headful browser window) and click "Solved" in the
 * GUI, which resolves the pending promise.
 *
 * Only usable with BROWSER_MODE=headful (there must be a visible window to
 * solve in). In headless mode it degrades to a timeout failure.
 */
export class ManualSolver {
  constructor({ headless = true } = {}) {
    this.headless = headless;
    this._pending = new Map(); // requestId -> resolve fn
    // GUI calls resolveCaptcha(requestId) via the API.
    bus.on('captcha:solved', (id) => this._resolve(id));
  }

  _resolve(id) {
    const fn = this._pending.get(id);
    if (fn) {
      this._pending.delete(id);
      fn();
    }
  }

  async solve(page, ctx = {}) {
    if (this.headless) {
      log.warn('Manual captcha requested but browser is headless — cannot solve');
      return { solved: false, method: 'manual', reason: 'headless' };
    }
    const requestId = randomUUID();
    const url = page.url();
    log.info('Manual captcha intervention requested', { requestId, url });
    ctx.log?.(`Captcha requires manual solving — open the browser window and solve it, then click "Solved". (${url})`);
    bus.emit('captcha:needed', { requestId, jobId: ctx.jobId, url });
    // The window stays minimized/backgrounded the rest of the time (see
    // browser.js's --start-minimized) so it doesn't steal focus during the
    // fully-automated stretches; this is the one moment a human actually
    // needs to look at it, so bring it forward. Both calls matter: restore
    // handles the OS-level minimized state, bringToFront makes sure the
    // right tab is the active one once the window is visible again.
    await restoreWindow(page);
    await page.bringToFront().catch((err) => log.warn(`bringToFront failed: ${err.message}`));

    const timeoutMs = 5 * 60 * 1000;
    let onPageClose;
    let interval;

    const solved = await new Promise((resolve) => {
      onPageClose = () => {
        log.warn('Page closed while waiting for manual captcha solving', { requestId });
        resolve(false);
      };
      page.on('close', onPageClose);

      this._pending.set(requestId, () => resolve(true));

      // Polling to automatically detect if the page redirected to GDFlix or a final host
      const startUrl = page.url();
      const warnedHijackUrls = new Set();
      interval = setInterval(async () => {
        try {
          if (page.isClosed()) return;
          const currentUrl = page.url();
          if (currentUrl === startUrl) return;
          if (isPlausibleProgressUrl(startUrl, currentUrl)) {
            log.info('Auto-detected captcha bypass success due to page navigation', { currentUrl });
            resolve(true);
          } else if (!warnedHijackUrls.has(currentUrl)) {
            // Don't resolve — this is very likely an ad popup/redirect that
            // hijacked the tab, not the captcha actually being solved (see
            // isPlausibleProgressUrl's comment). Keep waiting: either a
            // human notices and clicks "Solved" once it's genuinely fixed,
            // or the page bounces back to something plausible on its own.
            warnedHijackUrls.add(currentUrl);
            const hijackHost = new URL(currentUrl).hostname;
            log.warn('Page navigated to an unexpected host — likely an ad hijack, not real progress', { currentUrl });
            ctx.log?.(`⚠ Page navigated to an unrelated site (${hijackHost}) — looks like an ad redirect, not the real captcha bypass. Still waiting.`);
          }
        } catch {}
      }, 1000);

      setTimeout(() => {
        if (this._pending.has(requestId)) {
          this._pending.delete(requestId);
          resolve(false);
        }
      }, timeoutMs);
    });

    if (interval) clearInterval(interval);
    if (onPageClose) {
      page.off('close', onPageClose);
    }
    this._pending.delete(requestId);

    if (!page.isClosed()) {
      await minimizeWindow(page);
    }

    return { solved, method: 'manual', requestId };
  }
}

export default ManualSolver;
