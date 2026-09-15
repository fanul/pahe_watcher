import { ManualSolver } from './manual.js';
import { TwoCaptchaSolver } from './twocaptcha.js';
import { NoopSolver } from './noop.js';
import { FlareSolverrSolver } from './flaresolverr.js';
import { CapSolverSolver } from './capsolver.js';

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
    case 'capsolver':
      return new CapSolverSolver(config.bypass.captcha.capSolverApiKey);
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
 * reCAPTCHA v2 (and many hCaptcha deployments) can pass outright on a real
 * click of the checkbox alone — no image challenge — for a session Google's
 * risk scoring doesn't flag. This costs nothing (no paid-solver API call, no
 * human wait) and only takes ~1s, so it's worth trying unconditionally
 * before falling through to whatever solver is configured. Confirmed this
 * is a real, commonly-used technique — the actively-maintained "ugibypass"
 * Greasyfork userscript (ouo.io et al.) does the same checkbox-click-first
 * step ahead of its own paid-solver fallback.
 *
 * Real Playwright click (not injected-script el.click()) as everywhere else
 * this session found a *trusted* click matters for exactly this kind of
 * widget — a synthetic click risks not registering as a genuine
 * interaction at all.
 *
 * @returns {Promise<boolean>} true if the checkbox click alone solved it
 */
export async function tryAutoClickRecaptchaCheckbox(page) {
  try {
    const alreadyTried = await page.evaluate(() => !!window.__paheRecaptchaCheckboxTried).catch(() => true);
    if (alreadyTried) return false;
    await page.evaluate(() => { window.__paheRecaptchaCheckboxTried = true; }).catch(() => {});

    const anchorFrame = page.frames().find((f) => /recaptcha\/api2\/anchor/.test(f.url()));
    if (!anchorFrame) return false;
    const checkbox = anchorFrame.locator('#recaptcha-anchor, .recaptcha-checkbox-border');
    if ((await checkbox.count()) === 0) return false;

    await checkbox.first().click({ timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(1500);

    const solved = await page
      .evaluate(() => {
        const ta = document.querySelector('textarea[name="g-recaptcha-response"], #g-recaptcha-response');
        return !!(ta && ta.value && ta.value.trim().length > 20);
      })
      .catch(() => false);
    return solved;
  } catch {
    return false;
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
      if (find('iframe[src*="recaptcha/api2/anchor"], .g-recaptcha, #recaptcha, [data-sitekey]')) {
        const el = find('.g-recaptcha') || find('[data-sitekey]');
        let siteKey = el?.getAttribute('data-sitekey') || null;
        if (!siteKey) {
          const ifr = find('iframe[src*="recaptcha"]');
          const m = ifr?.getAttribute('src')?.match(/[?&]k=([^&]+)/);
          if (m) siteKey = decodeURIComponent(m[1]);
        }
        if (siteKey) {
          return { present: true, kind: 'recaptcha-v2', siteKey };
        }
      }
      if (find('iframe[src*="hcaptcha.com"], .h-captcha')) {
        const el = find('.h-captcha');
        let siteKey = el?.getAttribute('data-sitekey') || null;
        if (!siteKey) {
          const ifr = find('iframe[src*="hcaptcha.com"]');
          const m = ifr?.getAttribute('src')?.match(/[?&]sitekey=([^&]+)/);
          if (m) siteKey = decodeURIComponent(m[1]);
        }
        return { present: true, kind: 'hcaptcha', siteKey };
      }
      if (find('iframe[src*="challenges.cloudflare.com"], .cf-turnstile')) {
        const el = find('.cf-turnstile') || find('[data-sitekey]');
        let siteKey = el?.getAttribute('data-sitekey') || null;
        if (!siteKey) {
          const ifr = find('iframe[src*="challenges.cloudflare.com"]');
          const m = ifr?.getAttribute('src')?.match(/[?&/](?:k|sitekey)[=/]([^&?/]+)/);
          if (m) siteKey = decodeURIComponent(m[1]);
        }
        const respEl = find('[name="cf-turnstile-response"]');
        const solvedToken = respEl && respEl.value ? respEl.value : null;
        return {
          present: true,
          kind: 'turnstile',
          siteKey,
          action: el?.getAttribute('data-action') || null,
          cData: el?.getAttribute('data-cdata') || null,
          solvedToken,
        };
      }
      return null;
    })
    .catch(() => null);
}

export default createCaptchaSolver;
