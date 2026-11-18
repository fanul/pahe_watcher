import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from '../../core/logger.js';
import { isAntiAutomationWallPage } from '../antiAutomationWall.js';
import { isDeadLinkPage } from '../deadLinkPatterns.js';

const log = createLogger('resolver:exeyGate');
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const EXEY_GATE_HOSTS = [
  'exe.io',
  'exeygo.com',
  'exeo.app',
  'exey.io',
  'exe-links.com',
  'exe-urls.com',
  'exego.app',
  'exnion.com',
];

export function isExeyGateUrl(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return EXEY_GATE_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

const randomDelay = (minMs, maxMs) => minMs + Math.random() * (maxMs - minMs);

function cleanupInBackground(browser, profileDir) {
  browser
    .close()
    .catch((err) => log.warn(`Cleanup error: ${err.message}`))
    .finally(() => {
      if (!profileDir) return;
      fs.promises.rm(profileDir, { recursive: true, force: true }).catch((err) => {
        log.warn(`Profile cleanup error: ${err.message}`);
      });
    });
}

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
    `exeygate-run-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  const context = await pw.chromium.launchPersistentContext(profileDir, {
    headless: false,
    channel: 'chrome',
    viewport: { width: 1366, height: 768 },
  });
  return { context, profileDir };
}

/**
 * Resolves an exe.io / exeygo.com shortlink in an isolated patchright
 * context without userscript.js's 50x timer speedup or DOM monkey-patches,
 * which otherwise trigger exeygo.com's robot/anti-bot detection even after
 * clicking "Continue with ads".
 */
export async function resolveExeyGate(startUrl, { ctx = {}, config = {}, timeoutMs = 120000 } = {}) {
  const { context: browser, profileDir } = await acquireIsolatedContext(config);

  try {
    const page = await browser.newPage();
    await page.bringToFront().catch(() => {});

    browser.on('page', (popup) => {
      const popupUrl = (() => { try { return popup.url(); } catch { return null; } })();
      ctx.log?.(`[exeyGate] Closing popup: ${popupUrl && popupUrl !== 'about:blank' ? popupUrl.slice(0, 80) : '(url not yet available)'}`);
      popup.close().catch(() => {});
      page.bringToFront().catch(() => {});
    });

    ctx.log?.(`[exeyGate] Fresh patchright instance resolving ${startUrl.slice(0, 60)}…`);
    await page.goto(startUrl, { waitUntil: 'load', timeout: 30000 }).catch(() => {});

    const deadline = Date.now() + timeoutMs;
    let lastUrl = page.url();
    let lastClickAt = 0;
    let clickedGetLinkForUrl = null;
    let loggedHumanCheck = false;

    while (Date.now() < deadline) {
      if (page.isClosed()) throw new Error('exe.io/exeygo gate page closed unexpectedly');
      const url = page.url();

      if (url && url !== 'about:blank' && !isExeyGateUrl(url)) {
        ctx.log?.(`[exeyGate] Escaped gate to ${url.slice(0, 60)}…`);
        cleanupInBackground(browser, profileDir);
        return { finalUrl: url };
      }

      if (url !== lastUrl) {
        lastUrl = url;
        loggedHumanCheck = false;
        ctx.log?.(`[exeyGate] Landed on ${url.slice(0, 60)}… — letting it settle`);
        await page.waitForLoadState('load', { timeout: 10000 }).catch(() => {});
        await page.waitForTimeout(randomDelay(800, 1400));
        continue;
      }

      const pageText = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
      if (isDeadLinkPage(pageText)) {
        throw Object.assign(new Error(`Dead link detected at ${url}`), { dead: true });
      }
      if (isAntiAutomationWallPage(pageText)) {
        throw new Error(`exe.io/exeygo anti-automation wall detected at ${url}`);
      }

      // Step 3 (variant A): #countdown[data-state='done'] + #submit-button:not([disabled])
      // (adopted from GreasyFork 593212 — exeygo.com uses #submit-button across steps)
      const step3SubmitReady = await page
        .evaluate(() => {
          const countdown = document.querySelector('#countdown');
          if (!countdown || countdown.getAttribute('data-state') !== 'done') return false;
          const btn = document.querySelector('#submit-button');
          return !!(btn && !btn.disabled && !btn.hasAttribute('disabled'));
        })
        .catch(() => false);

      if (step3SubmitReady && clickedGetLinkForUrl !== `${url}#countdown`) {
        clickedGetLinkForUrl = `${url}#countdown`;
        ctx.log?.('[exeyGate] Step 3 countdown done — clicking #submit-button');
        const btnLoc = page.locator('#submit-button').first();
        await btnLoc.evaluate((el) => el.scrollIntoView({ block: 'center', behavior: 'instant' })).catch(() => {});
        await btnLoc.click({ timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(randomDelay(800, 1400));
        continue;
      }

      // Step 3 (variant B): Final "Get link" anchor (ignore exe.io/register, /subscription, /terms, /privacy)
      const getLinkHref = await page
        .evaluate(() => {
          const candidates = Array.from(document.querySelectorAll('a.get-link[href], a.btn[href], a[href]'));
          for (const a of candidates) {
            const text = (a.textContent || '').trim().toLowerCase();
            const href = a.getAttribute('href') || '';
            if (!href || href.startsWith('#') || href.startsWith('javascript:')) continue;
            if (a.classList.contains('disabled')) continue;
            const isGetLink = a.classList.contains('get-link') || text === 'get link' || text === 'get-link';
            if (!isGetLink) continue;
            try {
              const u = new URL(href, window.location.href);
              if (/\/(register|subscription|terms|privacy|login)/i.test(u.pathname)) continue;
              return u.href;
            } catch {}
          }
          return null;
        })
        .catch(() => null);

      if (getLinkHref && clickedGetLinkForUrl !== url) {
        clickedGetLinkForUrl = url;
        ctx.log?.(`[exeyGate] Step 3 Get Link ready — navigating to ${getLinkHref.slice(0, 60)}…`);
        const btn = page.locator('a.get-link:not(.disabled), a:has-text("Get Link")').first();
        const clicked = await btn.click({ timeout: 3000 }).then(() => true).catch(() => false);
        if (!clicked) {
          await page.goto(getLinkHref, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
        }
        await page.waitForTimeout(randomDelay(800, 1400));
        continue;
      }

      // Step 2 (Human check): if Turnstile / captcha is solved and #submit-button is enabled, click it!
      const turnstileSolvedBtn = await page
        .evaluate(() => {
          const cf = document.querySelector('[name="cf-turnstile-response"]');
          const gr = document.querySelector('[name="g-recaptcha-response"]');
          const hc = document.querySelector('[name="h-captcha-response"]');
          const solved = !!((cf && cf.value) || (gr && gr.value) || (hc && hc.value));
          if (!solved) return false;
          const btn = document.querySelector('#submit-button, form button[type="submit"], form input[type="submit"]');
          return !!(btn && !btn.disabled && !btn.hasAttribute('disabled'));
        })
        .catch(() => false);

      if (turnstileSolvedBtn && Date.now() - lastClickAt > 3000) {
        lastClickAt = Date.now();
        ctx.log?.('[exeyGate] Step 2 Human check solved — clicking submit button');
        const btnLoc = page.locator('#submit-button, form button[type="submit"], form input[type="submit"]').first();
        await btnLoc.evaluate((el) => el.scrollIntoView({ block: 'center', behavior: 'instant' })).catch(() => {});
        await btnLoc.click({ timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(randomDelay(1000, 1600));
        continue;
      }

      // Step 1 / generic Continue button: match #submit-button or any visible, enabled
      // Continue / Verify / Get Link button (with 3.5s cooldown so an eaten click retries).
      if (Date.now() - lastClickAt > 3500) {
        const actionBtn = await page
          .evaluate(() => {
            const ALLOW_RE = /^(continue|continue with ads|get link|go to link|next|proceed|verify|click here to continue)$/i;
            const candidates = Array.from(
              document.querySelectorAll('#free-submit-form #submit-button, #submit-button, form button[type="submit"], button, a.btn, input[type="submit"]'),
            );
            for (let i = 0; i < candidates.length; i++) {
              const el = candidates[i];
              const style = window.getComputedStyle(el);
              if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity || '1') === 0) continue;
              const rect = el.getBoundingClientRect();
              if (rect.width === 0 || rect.height === 0) continue;
              const disabled = !!(el.disabled || el.hasAttribute('disabled') || el.classList.contains('disabled'));
              if (disabled) continue;
              const text = (el.textContent || el.value || '').replace(/\s+/g, ' ').trim();
              if (!text || /please wait|premium|earning|register|login|terms|privacy/i.test(text)) continue;
              if (el.id === 'submit-button' || ALLOW_RE.test(text)) {
                el.setAttribute('data-exey-target', '1');
                return { text };
              }
            }
            return null;
          })
          .catch(() => null);

        if (actionBtn) {
          lastClickAt = Date.now();
          ctx.log?.(`[exeyGate] Clicking "${actionBtn.text}"`);
          const btnLoc = page.locator('[data-exey-target="1"]').first();
          await btnLoc.evaluate((el) => {
            el.removeAttribute('data-exey-target');
            el.scrollIntoView({ block: 'center', behavior: 'instant' });
          }).catch(() => {});
          await page.waitForTimeout(randomDelay(300, 600));
          await btnLoc.click({ timeout: 5000 }).catch(() => {});
          await page.waitForTimeout(randomDelay(1000, 1600));
          continue;
        }
      }

      // Step 2: Human check (Turnstile / reCAPTCHA / hCaptcha)
      const hasCaptcha = await page
        .evaluate(() => {
          return !!document.querySelector(
            '.cf-turnstile, iframe[src*="challenges.cloudflare.com"], .g-recaptcha, iframe[src*="recaptcha"], .h-captcha, iframe[src*="hcaptcha"]',
          );
        })
        .catch(() => false);

      if (hasCaptcha && !loggedHumanCheck) {
        loggedHumanCheck = true;
        ctx.log?.('[exeyGate] Step 2 Human check detected — waiting for verification (solve in the open Chrome window if prompted)');
        await page.bringToFront().catch(() => {});
      }

      await page.waitForTimeout(randomDelay(700, 1200));
    }

    throw new Error('exe.io/exeygo gate resolver timed out');
  } catch (err) {
    cleanupInBackground(browser, profileDir);
    throw err;
  }
}

export default resolveExeyGate;
