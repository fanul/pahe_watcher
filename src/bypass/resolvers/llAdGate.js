import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from '../../core/logger.js';
import { isAntiAutomationWallPage } from '../antiAutomationWall.js';

const log = createLogger('resolver:llAdGate');
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const LL_AD_GATE_HOSTS = ['intercelestial.com', 'teknoasian.com'];

export function isLLAdGateUrl(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return LL_AD_GATE_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

/**
 * Resolves an intercelestial.com/teknoasian.com "LL" ad-gate link by
 * reproducing — deliberately, exactly — the one configuration that showed
 * signs of working earlier in this investigation, instead of the app's
 * usual automation stack:
 *   - raw `patchright.chromium.launchPersistentContext()`, NOT BrowserManager
 *   - a genuinely fresh profile dir, deleted when this call finishes
 *   - no injected automation script at all (no getInjectedAutomationScript,
 *     no decoy-stripper, no DOMAIN_RULES, no speedup-timer override)
 *   - `page.click()` (Playwright's real, trusted click) for every button,
 *     no synthetic el.click()
 *   - fully isolated: its own process, own profile, closed and deleted on
 *     every exit path
 *
 * This intentionally does NOT reuse bypass/index.js's evaluateWithTimeout
 * or any of the click-decoy-clearing logic built up earlier — the point of
 * this run is to test whether the earlier result reproduces under this
 * exact, minimal configuration, not to carry over this session's other
 * fixes.
 *
 * @param {string} startUrl the intercelestial.com/teknoasian.com entry link
 * @param {object} opts
 * @param {{log?: (msg: string) => void}} [opts.ctx] optional job-log sink
 * @param {number} [opts.timeoutMs] overall budget for this resolver
 * @returns {Promise<{finalUrl: string}>}
 */
export async function resolveLLAdGate(startUrl, { ctx = {}, timeoutMs = 60000 } = {}) {
  const profileDir = path.resolve(
    __dirname, '..', '..', '..', 'data',
    `llgate-run-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );

  const pw = await import('patchright');
  const browser = await pw.chromium.launchPersistentContext(profileDir, {
    headless: false,
    channel: 'chrome',
    viewport: { width: 1366, height: 768 },
    // Purely a window-manager flag — doesn't touch navigator.webdriver, CDP
    // behavior, or any other JS-observable signal — so it doesn't carry the
    // "custom args can reintroduce detectable patterns" risk that applies
    // to actual stealth/automation flags on the patchright path. This
    // resolver never needs a human to look at it (no captcha step lives on
    // intercelestial.com/teknoasian.com), so there's no reason for its
    // window to ever surface and steal focus.
    args: ['--start-minimized'],
  });

  try {
    const page = await browser.newPage();
    ctx.log?.(`[llGate] Fresh patchright instance resolving ${startUrl.slice(0, 60)}…`);
    await page.goto(startUrl, { waitUntil: 'load', timeout: 30000 }).catch(() => {});

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (page.isClosed()) throw new Error('LL ad-gate page closed unexpectedly');
      const url = page.url();

      if (url && url !== 'about:blank' && !isLLAdGateUrl(url)) {
        ctx.log?.(`[llGate] Escaped ad-gate to ${url.slice(0, 60)}…`);
        return { finalUrl: url };
      }

      const pageText = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
      if (isAntiAutomationWallPage(pageText)) {
        throw new Error(`LL ad-gate wall detected at ${url}`);
      }

      const hasWb = await page.evaluate(() => !!document.getElementById('wb')).catch(() => false);
      const hasMyButton = await page.evaluate(() => !!document.querySelector('.myButton')).catch(() => false);
      const sel = hasWb ? '#wb' : (hasMyButton ? '.myButton' : null);
      if (sel) {
        ctx.log?.(`[llGate] Clicking ${sel} (real Playwright click)`);
        await page.click(sel, { timeout: 5000 }).catch((err) => {
          ctx.log?.(`[llGate] Click error: ${err.message}`);
        });
      }

      await page.waitForTimeout(1000);
    }
    throw new Error('LL ad-gate resolver timed out');
  } finally {
    await browser.close().catch((err) => log.warn(`Cleanup error: ${err.message}`));
    await fs.promises.rm(profileDir, { recursive: true, force: true }).catch((err) => {
      log.warn(`Profile cleanup error: ${err.message}`);
    });
  }
}

export default resolveLLAdGate;
