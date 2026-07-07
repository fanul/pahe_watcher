import { createLogger } from '../../core/logger.js';
import { detectCaptcha } from './index.js';

const log = createLogger('captcha:2captcha');

/**
 * 2Captcha (2captcha.com) solver for reCAPTCHA v2 / hCaptcha / Turnstile.
 * Submits the sitekey+pageurl, polls for the token, then injects it into the
 * page and triggers the standard callbacks.
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

  async _poll(id, { tries = 24, delayMs = 5000 } = {}) {
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
    if (!info.siteKey) {
      log.warn('Captcha present but sitekey not found', info);
      return { solved: false, method: '2captcha', reason: 'no-sitekey' };
    }

    const pageurl = page.url();
    const method = info.kind === 'hcaptcha' ? 'hcaptcha' : info.kind === 'turnstile' ? 'turnstile' : 'userrecaptcha';
    ctx.log?.(`Submitting ${info.kind} to 2captcha…`);
    const id = await this._submit({ method, sitekey: info.siteKey, pageurl });
    const token = await this._poll(id);
    ctx.log?.('2captcha returned a token; injecting.');

    await page.evaluate((tok) => {
      const set = (name) => {
        document.querySelectorAll(`textarea[name="${name}"]`).forEach((t) => (t.value = tok));
      };
      set('g-recaptcha-response');
      set('h-captcha-response');
      set('cf-turnstile-response');
      // fire common callbacks
      try { if (window.___grecaptcha_cfg) { /* noop */ } } catch {}
      try { if (typeof window.onCaptchaSuccess === 'function') window.onCaptchaSuccess(tok); } catch {}
    }, token);

    return { solved: true, method: '2captcha', token };
  }
}

export default TwoCaptchaSolver;
