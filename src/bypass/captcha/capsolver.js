import { createLogger } from '../../core/logger.js';
import { detectCaptcha } from './index.js';
import { injectTurnstileToken } from './turnstileInject.js';

const log = createLogger('captcha:capsolver');

/**
 * CapSolver (capsolver.com) solver. CapSolver's AntiTurnstileTaskProxyLess is one
 * of the more reliable Cloudflare Turnstile solvers, which is exactly ouo.io's
 * challenge. Also handles reCAPTCHA v2 / hCaptcha.
 *
 * Plain HTTP API: createTask -> poll getTaskResult -> inject token.
 */
export class CapSolverSolver {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.base = 'https://api.capsolver.com';
  }

  async _createTask(task) {
    const res = await fetch(`${this.base}/createTask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientKey: this.apiKey, task }),
    });
    const data = await res.json();
    if (data.errorId) throw new Error(`capsolver createTask: ${data.errorCode} ${data.errorDescription}`);
    return data.taskId;
  }

  async _poll(taskId, { tries = 40, delayMs = 3000 } = {}) {
    for (let i = 0; i < tries; i++) {
      await new Promise((r) => setTimeout(r, delayMs));
      const res = await fetch(`${this.base}/getTaskResult`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientKey: this.apiKey, taskId }),
      });
      const data = await res.json();
      if (data.errorId) throw new Error(`capsolver getTaskResult: ${data.errorCode} ${data.errorDescription}`);
      if (data.status === 'ready') return data.solution;
    }
    throw new Error('capsolver timed out');
  }

  async solve(page, ctx = {}) {
    if (!this.apiKey) return { solved: false, method: 'capsolver', reason: 'no-api-key' };
    const info = await detectCaptcha(page);
    if (!info || !info.present) return { solved: true, method: 'capsolver', reason: 'no-captcha' };

    if (info.kind === 'turnstile' && info.solvedToken) {
      ctx.log?.('Turnstile already solved by the browser (stealth auto-pass) — skipping CapSolver.');
      return { solved: true, method: 'auto-pass' };
    }
    if (!info.siteKey) {
      log.warn('Captcha present but sitekey not found', info);
      return { solved: false, method: 'capsolver', reason: 'no-sitekey' };
    }

    const websiteURL = page.url();
    let task;
    if (info.kind === 'turnstile') {
      task = { type: 'AntiTurnstileTaskProxyLess', websiteURL, websiteKey: info.siteKey };
      if (info.action || info.cData) {
        task.metadata = {};
        if (info.action) task.metadata.action = info.action;
        if (info.cData) task.metadata.cdata = info.cData;
      }
    } else if (info.kind === 'hcaptcha') {
      task = { type: 'HCaptchaTaskProxyLess', websiteURL, websiteKey: info.siteKey };
    } else {
      task = { type: 'ReCaptchaV2TaskProxyLess', websiteURL, websiteKey: info.siteKey };
    }

    ctx.log?.(`Submitting ${info.kind} to CapSolver…`);
    const taskId = await this._createTask(task);
    const solution = await this._poll(taskId);
    const token = solution.token || solution.gRecaptchaResponse;
    if (!token) throw new Error('capsolver returned no token');

    ctx.log?.('CapSolver returned a token; injecting.');
    await page.evaluate(injectTurnstileToken, { token, kind: info.kind });
    return { solved: true, method: 'capsolver', token };
  }
}

export default CapSolverSolver;
