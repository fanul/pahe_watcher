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
    const solved = await new Promise((resolve) => {
      this._pending.set(requestId, () => resolve(true));
      setTimeout(() => {
        if (this._pending.has(requestId)) {
          this._pending.delete(requestId);
          resolve(false);
        }
      }, timeoutMs);
    });

    return { solved, method: 'manual', requestId };
  }
}

export default ManualSolver;
