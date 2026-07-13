import { ManualSolver } from './manual.js';
import { TwoCaptchaSolver } from './twocaptcha.js';
import { NoopSolver } from './noop.js';
import { FlareSolverrSolver } from './flaresolverr.js';

/**
 * Factory returning a captcha solver based on config.
 * All solvers share the interface:
 *   async solve(page, ctx) -> { solved: boolean, method: string }
 *   detect(page) -> Promise<{ present, kind, siteKey?, url? } | null>
 */
export function createCaptchaSolver(config, deps = {}) {
  const provider = config.bypass.captcha.provider;
  switch (provider) {
    case '2captcha':
      return new TwoCaptchaSolver(config.bypass.captcha.twoCaptchaApiKey);
    case 'flaresolverr':
      return new FlareSolverrSolver(config.bypass.captcha.flaresolverrUrl || 'http://localhost:8191', 'flaresolverr');
    case 'byparr':
      return new FlareSolverrSolver(config.bypass.captcha.byparrUrl || 'http://localhost:8192', 'byparr');
    case 'manual':
      return new ManualSolver(deps);
    case 'none':
    default:
      return new NoopSolver();
  }
}

/**
 * Detect a reCAPTCHA / hCaptcha / Turnstile widget on the page.
 * Returns null when no captcha is present.
 */
export async function detectCaptcha(page) {
  return page
    .evaluate(() => {
      const find = (sel) => document.querySelector(sel);
      if (find('iframe[src*="recaptcha/api2/anchor"], .g-recaptcha, #recaptcha')) {
        const el = find('.g-recaptcha');
        return { present: true, kind: 'recaptcha-v2', siteKey: el?.getAttribute('data-sitekey') || null };
      }
      if (find('iframe[src*="hcaptcha.com"], .h-captcha')) {
        const el = find('.h-captcha');
        return { present: true, kind: 'hcaptcha', siteKey: el?.getAttribute('data-sitekey') || null };
      }
      if (find('iframe[src*="challenges.cloudflare.com"], .cf-turnstile')) {
        const el = find('.cf-turnstile');
        return { present: true, kind: 'turnstile', siteKey: el?.getAttribute('data-sitekey') || null };
      }
      return null;
    })
    .catch(() => null);
}

export default createCaptchaSolver;
