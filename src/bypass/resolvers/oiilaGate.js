import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from '../../core/logger.js';
import { getInjectedAutomationScript, AD_HOSTS } from '../userscript.js';
import { isAntiAutomationWallPage } from '../antiAutomationWall.js';
import { isDeadLinkPage } from '../deadLinkPatterns.js';
import { isGdflixUrl } from './gdflix.js';

const log = createLogger('resolver:oiilaGate');
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const OIILA_GATE_HOSTS = ['oii.la', 'tpi.li', 'srnky.com', 'clksz.com'];

// A resolved final link looks like one of these hosts — same list as
// bypass/index.js's own FINAL_HOST_RE.
const FINAL_HOST_RE = /(drive\.google\.com|googleusercontent\.com|pixeldrain\.|pixeldra\.in|workers\.dev|\.r2\.)/i;

export function isOiilaGateUrl(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return OIILA_GATE_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

/** True once we've actually reached a resolvable final link — the only condition that should end this resolver and hand off to the main pipeline. */
function isFinalDestination(url) {
  return FINAL_HOST_RE.test(url) || isGdflixUrl(url);
}

// Confirmed live: oii.la's chain can hop through OTHER ad-gate domains
// this resolver doesn't itself special-case (e.g. a blogmystt.com-family
// clone) before ever reaching a real final host. The injected automation
// script this resolver already runs (getInjectedAutomationScript, same as
// the main pipeline) handles every domain in AD_HOSTS/ADBLOCK_GATE_HOSTS
// generically — so landing on one of those isn't an "escape" at all, it's
// still mid-chain and should keep polling in THIS SAME session/browser.
// Reported live: treating any non-oii.la-family host as "escaped" (this
// resolver's original behavior) handed the next hop off to the main
// pipeline's completely different browser session — different cookies, no
// referrer continuity from the redirect that got there — which is its own
// plausible reason a session-validated intermediate page would show decoy
// content instead of its real gate. Staying in one session for every
// KNOWN ad-chain hop avoids that entirely.
function isKnownAdChainUrl(url) {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    return AD_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

// Same reasoning as llAdGate.js's own cleanupInBackground — deliberately
// not awaited by callers, a slow browser-close + profile-delete shouldn't
// block returning an already-known result.
function cleanupInBackground(browser, profileDir) {
  browser
    .close()
    .catch((err) => log.warn(`Cleanup error: ${err.message}`))
    .finally(() =>
      fs.promises.rm(profileDir, { recursive: true, force: true }).catch((err) => {
        log.warn(`Profile cleanup error: ${err.message}`);
      }),
    );
}

/**
 * Resolves an oii.la-family (oii.la/tpi.li/srnky.com/clksz.com) shortlink
 * using a fresh, isolated, throwaway-profile browser.
 *
 * Same underlying problem as llAdGate.js's isolated intercelestial
 * resolver, just tracked a different way: this app's main pipeline browser
 * uses ONE persistent profile (data/browser-profile) shared across every
 * job and every retry ever run. Confirmed live — a job stuck on oii.la/
 * clksz.com for several retries eventually got served decoy blog content
 * ("PolicyBuzz" — an unrelated insurance article) at the exact same URL
 * instead of the real Continue/Turnstile gate, no error, just nothing left
 * to click. Same symptom as intercelestial's stale-token issue (this
 * session's own dumpFrameDiagnostics first surfaced that pattern), just
 * driven by accumulated cookies/session history in the shared profile here
 * instead of a single-use URL token.
 *
 * Unlike llAdGate.js, this does NOT hand-roll Node-side click/wait logic —
 * rules/oiila.js's DOMAIN_RULES handler (disabled-button wait, 10s
 * countdown, Get Link click) is already well-tuned from earlier live
 * investigation and doesn't have intercelestial's trusted-click
 * requirement (fallback.js's own comment confirms only intercelestial/
 * teknoasian need real Playwright clicks). The only thing that needed
 * fixing here is WHICH browser session runs that existing script, so this
 * just runs the same getInjectedAutomationScript() output inside a clean,
 * single-use profile instead of the shared one.
 *
 * @param {string} startUrl the oii.la/tpi.li entry link, or a clone-domain
 *   URL (clksz.com/<slug>, srnky.com/<slug>) if already redirected there
 * @param {object} opts
 * @param {{log?: (msg: string) => void}} [opts.ctx] optional job-log sink
 * @param {object} [opts.config] app config, forwarded to
 *   getInjectedAutomationScript (ouo-injection/speedup toggles)
 * @param {number} [opts.timeoutMs] overall budget for this resolver
 * @returns {Promise<{finalUrl: string}>}
 */
export async function resolveOiilaGate(startUrl, { ctx = {}, config = {}, timeoutMs = 120000 } = {}) {
  const profileDir = path.resolve(
    __dirname, '..', '..', '..', 'data',
    `oiilagate-run-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );

  const pw = await import('patchright');
  const browser = await pw.chromium.launchPersistentContext(profileDir, {
    headless: false,
    channel: 'chrome',
    viewport: { width: 1366, height: 768 },
  });

  try {
    // Same automation this app's shared pipeline browser already runs
    // (browser.js's own newPage() does the identical addInitScript call) —
    // reused as-is so the Continue/countdown/Get-Link flow behaves exactly
    // like the already-proven implementation, just in a clean session.
    await browser.addInitScript(getInjectedAutomationScript(config));
    const page = await browser.newPage();

    await page.bringToFront().catch(() => {});

    // Every .myButton-family ad click on this template can pop-under a new
    // tab and steal focus — same fix as llAdGate.js's popup closer.
    browser.on('page', (popup) => {
      const popupUrl = (() => { try { return popup.url(); } catch { return null; } })();
      ctx.log?.(`[oiilaGate] Closing popup: ${popupUrl && popupUrl !== 'about:blank' ? popupUrl.slice(0, 80) : '(url not yet available)'}`);
      popup.close().catch(() => {});
      page.bringToFront().catch(() => {});
    });

    ctx.log?.(`[oiilaGate] Fresh patchright instance resolving ${startUrl.slice(0, 60)}…`);
    await page.goto(startUrl, { waitUntil: 'load', timeout: 30000 }).catch(() => {});

    const deadline = Date.now() + timeoutMs;
    let lastUrl = page.url();
    let suspiciousUrl = null;
    let suspiciousTicks = 0;
    while (Date.now() < deadline) {
      if (page.isClosed()) throw new Error('oii.la-family gate page closed unexpectedly');
      const url = page.url();

      if (url && url !== 'about:blank' && isFinalDestination(url)) {
        ctx.log?.(`[oiilaGate] Escaped to ${url.slice(0, 60)}…`);
        cleanupInBackground(browser, profileDir);
        return { finalUrl: url };
      }

      // Still mid-chain (either an oii.la-family host, or some OTHER known
      // ad-gate domain this resolver's injected script already knows how
      // to click through — see isKnownAdChainUrl's comment) — keep polling
      // in this same session. Only a genuinely UNRECOGNIZED, non-final
      // destination counts as suspicious.
      if (url && url !== 'about:blank' && !isOiilaGateUrl(url) && !isKnownAdChainUrl(url)) {
        // Give it a few ticks in case it's mid-redirect to somewhere legit,
        // then fail fast rather than checkpointing onto dead content or
        // burning the rest of the job timeout on a page that will never
        // change (a static decoy page, once served, doesn't self-correct).
        if (url === suspiciousUrl) {
          suspiciousTicks += 1;
        } else {
          suspiciousUrl = url;
          suspiciousTicks = 1;
          ctx.log?.(`[oiilaGate] Landed on an unrecognized destination — waiting to see if it redirects further: ${url.slice(0, 70)}…`);
        }
        if (suspiciousTicks >= 6) {
          throw new Error(`Landed on an unrecognized, likely decoy destination (not a final host or known ad-chain domain): ${url}`);
        }
        await page.waitForTimeout(1500);
        continue;
      }

      if (url !== lastUrl) {
        lastUrl = url;
        ctx.log?.(`[oiilaGate] Landed on a new page (${url.slice(0, 60)}…) — letting it settle`);
        await page.waitForLoadState('load', { timeout: 10000 }).catch(() => {});
      }

      const pageText = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
      if (isDeadLinkPage(pageText)) {
        throw Object.assign(new Error(`Dead link detected at ${url}`), { dead: true });
      }
      if (isAntiAutomationWallPage(pageText)) {
        throw new Error(`oii.la-family gate wall detected at ${url}`);
      }

      await page.waitForTimeout(500);
    }
    throw new Error('oii.la-family gate resolver timed out');
  } catch (err) {
    cleanupInBackground(browser, profileDir);
    throw err;
  }
}

export default resolveOiilaGate;
