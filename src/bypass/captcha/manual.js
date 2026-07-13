import { randomUUID } from 'node:crypto';
import { bus } from '../../core/eventBus.js';
import { createLogger } from '../../core/logger.js';

const log = createLogger('captcha:manual');

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
      interval = setInterval(async () => {
        try {
          if (page.isClosed()) return;
          const currentUrl = page.url();
          // If the page redirected to a destination host, we successfully bypassed!
          if (
            currentUrl !== startUrl && 
            (currentUrl.includes('gdflix') || 
             currentUrl.includes('drive.google') || 
             currentUrl.includes('pixeldrain') || 
             currentUrl.includes('pixeldra.in') || 
             currentUrl.includes('workers.dev') ||
             currentUrl.includes('r2.cloudflarestorage') ||
             currentUrl.includes('googleusercontent'))
          ) {
            log.info('Auto-detected captcha bypass success due to page navigation', { currentUrl });
            resolve(true);
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

    return { solved, method: 'manual', requestId };
  }
}

export default ManualSolver;
