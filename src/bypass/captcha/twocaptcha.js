import { createLogger } from '../../core/logger.js';
import { detectCaptcha } from './index.js';
import { injectTurnstileToken } from './turnstileInject.js';

const log = createLogger('captcha:2captcha');

/**
 * 2Captcha (2captcha.com) solver for reCAPTCHA v2 / hCaptcha / Cloudflare
 * Turnstile. Submits sitekey + pageurl (+ action/cdata for Turnstile), polls for
 * the token, injects it, and lets the site's form logic proceed.
 *
 * Uses the plain HTTP API (no SDK dependency).
 */
export class TwoCaptchaSolver {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.base = 'https://2captcha.com';
  }

  async _submit(params) {
    const body = new URLSearchParams({ key: this.apiKey, json: '1', ...params });
    const res = await fetch(`${this.base}/in.php`, { method: 'POST', body });
    const data = await res.json();
    if (data.status !== 1) throw new Error(`2captcha submit failed: ${data.request}`);
    return data.request; // captcha id
  }

  async _poll(id, { tries = 30, delayMs = 5000 } = {}) {
    for (let i = 0; i < tries; i++) {
      await new Promise((r) => setTimeout(r, delayMs));
      const res = await fetch(`${this.base}/res.php?key=${this.apiKey}&action=get&id=${id}&json=1`);
      const data = await res.json();
      if (data.status === 1) return data.request; // token
      if (data.request !== 'CAPCHA_NOT_READY') throw new Error(`2captcha error: ${data.request}`);
    }
    throw new Error('2captcha timed out');
  }

  async solve(page, ctx = {}) {
    if (!this.apiKey) return { solved: false, method: '2captcha', reason: 'no-api-key' };
    const info = await detectCaptcha(page);
    if (!info || !info.present) return { solved: true, method: '2captcha', reason: 'no-captcha' };

    // Stealth may have already auto-issued a Turnstile token — no need to pay.
    if (info.kind === 'turnstile' && info.solvedToken) {
      ctx.log?.('Turnstile already solved by the browser (stealth auto-pass) — skipping 2captcha.');
      return { solved: true, method: 'auto-pass' };
    }
    if (!info.siteKey) {
      log.warn('Captcha present but sitekey not found', info);
      return { solved: false, method: '2captcha', reason: 'no-sitekey' };
    }

    const pageurl = page.url();
    ctx.log?.(`Submitting ${info.kind} to 2captcha…`);

    let params;
    if (info.kind === 'turnstile') {
      params = { method: 'turnstile', sitekey: info.siteKey, pageurl };
      if (info.action) params.action = info.action;
      if (info.cData) params.data = info.cData;
    } else if (info.kind === 'hcaptcha') {
      params = { method: 'hcaptcha', sitekey: info.siteKey, pageurl };
    } else {
      params = { method: 'userrecaptcha', googlekey: info.siteKey, pageurl };
    }

    const id = await this._submit(params);
    const token = await this._poll(id);
    ctx.log?.('2captcha returned a token; injecting.');

    await page.evaluate(injectTurnstileToken, { token, kind: info.kind });
    return { solved: true, method: '2captcha', token };
  }
}

export default TwoCaptchaSolver;
