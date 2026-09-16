import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from '../../core/logger.js';
import { isAntiAutomationWallPage } from '../antiAutomationWall.js';
import { tryAutoClickRecaptchaCheckbox } from '../captcha/index.js';

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

const randomDelay = (minMs, maxMs) => minMs + Math.random() * (maxMs - minMs);

/**
 * Confirmed live: this template can put TWO `.myButton` instances on the
 * page at once (e.g. one near the top, one further down after a "Scroll
 * Down" step) — `document.querySelector` would always grab whichever is
 * first in DOM order, even if that one is off-screen/behind the scroll
 * position and the OTHER instance is the one actually visible and
 * interactable right now. Scans every instance and returns the index of
 * whichever one is both on-screen and not covered by a decoy overlay (the
 * cursor would genuinely show a hand over it) — or -1 if none qualify yet.
 */
async function findClickableInstance(page, selector) {
  return page
    .evaluate((sel) => {
      const els = Array.from(document.querySelectorAll(sel));
      for (let i = 0; i < els.length; i++) {
        const el = els[i];
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        if (rect.top < 0 || rect.bottom > window.innerHeight) continue; // off-screen
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const top = document.elementFromPoint(cx, cy);
        if (!top) continue;
        if (top === el || el.contains(top) || window.getComputedStyle(top).cursor === 'pointer') {
          return i;
        }
      }
      return -1;
    }, selector)
    .catch(() => -1);
}

/**
 * Never click just because the selector exists in the DOM — that's clicking
 * straight into whatever decoy overlay is still sitting on top of it (the
 * actual "<div></div> intercepts pointer events" failure, not a timing
 * fluke). Only click once the OS cursor would genuinely show a hand over a
 * specific, on-screen instance of the button (see findClickableInstance
 * for why it has to be instance-aware, not just "does the selector exist
 * anywhere"). And critically: if the click itself still fails — confirmed
 * live this overlay can toggle back on in the gap between the check and
 * the click (a real race, not a one-off) — this does NOT fall through and
 * click blind. It goes back to waiting for clear again, up to the caller's
 * deadline, exactly like a human would keep waiting rather than mash the
 * button through a popup that flickered back in.
 */
async function clickWhenClear(page, ctx, selector, deadline) {
  while (Date.now() < deadline) {
    const idx = await findClickableInstance(page, selector);
    if (idx >= 0) {
      const clicked = await page
        .locator(selector)
        .nth(idx)
        .click({ timeout: 3000 })
        .then(() => true)
        .catch((err) => {
          ctx.log?.(`[llGate] Click raced with an overlay reappearing — waiting for clear again (${err.message.split('\n')[0]})`);
          return false;
        });
      if (clicked) return true;
    }
    await page.waitForTimeout(randomDelay(200, 500));
  }
  return false;
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
export async function resolveLLAdGate(startUrl, { ctx = {}, timeoutMs = 120000 } = {}) {
  const profileDir = path.resolve(
    __dirname, '..', '..', '..', 'data',
    `llgate-run-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );

  const pw = await import('patchright');
  const browser = await pw.chromium.launchPersistentContext(profileDir, {
    headless: false,
    channel: 'chrome',
    viewport: { width: 1366, height: 768 },
    // Deliberately NOT --start-minimized. Confirmed live with a direct A/B
    // test (user's own hypothesis, verified with hard numbers): minimized,
    // the .myButton click failed 24 of 28 attempts over 100+s and never
    // got past the very first step; focused/visible, the same flow cleared
    // every step and escaped in 73s with only 9 transient failures. Chrome
    // throttles a hidden/minimized tab's JS (Page Visibility API) — this
    // template's own decoy-overlay-clearing logic apparently depends on
    // that JS actually running, so minimizing it doesn't just fail to help,
    // it reliably breaks the whole resolver. No step here needs a *human*
    // to look at the window, but the window itself has to stay up.
  });

  try {
    const page = await browser.newPage();
    // Not minimized isn't automatically the same as visible/focused (a
    // freshly launched window can still land in the background depending
    // on the OS/window manager) — bringToFront() is what actually made the
    // difference in the A/B test that validated removing --start-minimized
    // above; without it this run got stuck the same way the minimized one
    // did.
    await page.bringToFront().catch(() => {});

    // Every .myButton click reliably pop-unders a new tab (this template's
    // own ad monetization) and Chrome hands THAT tab focus — so our actual
    // page immediately goes back to being the non-visible/throttled one
    // again, defeating the bringToFront() above within one click. Close
    // every popup the instant it opens and reclaim focus on our page, so
    // it stays the visible/active tab for the resolver's whole run instead
    // of just its first instant.
    browser.on('page', (popup) => {
      popup.close().catch(() => {});
      page.bringToFront().catch(() => {});
    });

    ctx.log?.(`[llGate] Fresh patchright instance resolving ${startUrl.slice(0, 60)}…`);
    await page.goto(startUrl, { waitUntil: 'load', timeout: 30000 }).catch(() => {});

    const deadline = Date.now() + timeoutMs;
    let lastUrl = page.url();
    while (Date.now() < deadline) {
      if (page.isClosed()) throw new Error('LL ad-gate page closed unexpectedly');
      const url = page.url();

      if (url && url !== 'about:blank' && !isLLAdGateUrl(url)) {
        ctx.log?.(`[llGate] Escaped ad-gate to ${url.slice(0, 60)}…`);
        return { finalUrl: url };
      }

      // Confirmed live: clicking through to the next step here is a real
      // page navigation (a "2nd visit"), not just DOM mutation on the same
      // page — checking/clicking immediately after landing means acting on
      // a page that hasn't actually finished settling yet (the button
      // click-decoy detection above can read stale/incomplete state), which
      // is a real cause of the scroll-down step getting missed entirely.
      // Give a fresh navigation a moment before doing anything else this
      // iteration.
      if (url !== lastUrl) {
        lastUrl = url;
        ctx.log?.(`[llGate] Landed on a new page (${url.slice(0, 60)}…) — letting it settle`);
        await page.waitForLoadState('load', { timeout: 10000 }).catch(() => {});
        await page.waitForTimeout(randomDelay(1200, 2200));
        continue;
      }

      const pageText = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
      if (isAntiAutomationWallPage(pageText)) {
        throw new Error(`LL ad-gate wall detected at ${url}`);
      }

      // Confirmed live: the LL template's own verify step can be gated
      // behind a real Google reCAPTCHA v2 "I'm not a robot" checkbox —
      // the .myButton click was retrying forever ("<div></div> intercepts
      // pointer events") because the recaptcha iframe/checkbox was
      // sitting unchecked in front of it, not because of an ordinary
      // ad-decoy overlay. Same free-pass technique already proven for the
      // main pipeline's captcha handling (tryAutoClickRecaptchaCheckbox) —
      // a real, trusted click on the checkbox, no injected script.
      const hasRecaptcha = await page
        .evaluate(() => !!document.querySelector('iframe[src*="recaptcha/api2/anchor"]'))
        .catch(() => false);
      if (hasRecaptcha) {
        ctx.log?.('[llGate] reCAPTCHA checkbox detected — attempting auto-click');
        const solved = await tryAutoClickRecaptchaCheckbox(page);
        ctx.log?.(`[llGate] reCAPTCHA checkbox ${solved ? 'passed (free pass, no challenge)' : 'clicked — waiting to see if a challenge appears'}`);
      }

      // Confirmed live: this template can show TWO .myButton instances at
      // once (e.g. one near the top, one further down after a scroll
      // step), and separately can present a "Scroll Down" step with no
      // real button to click yet at all. Scanning every instance up front
      // — instead of just the first DOM match — means the scroll-vs-click
      // decision below is based on what's actually usable right now, not
      // on whichever button happens to come first in the markup.
      const buttonState = await page
        .evaluate(() => {
          const buttons = Array.from(document.querySelectorAll('.myButton')).map((el) => {
            const rect = el.getBoundingClientRect();
            return {
              text: (el.textContent || '').trim(),
              visible: rect.width > 0 && rect.height > 0 && rect.top >= 0 && rect.bottom <= window.innerHeight,
            };
          });
          return {
            hasWb: !!document.getElementById('wb'),
            hasMyButton: buttons.length > 0,
            hasVisibleNonScrollButton: buttons.some((b) => b.text && !/scroll/i.test(b.text) && b.visible),
            hasScrollButton: buttons.some((b) => /scroll/i.test(b.text)),
          };
        })
        .catch(() => ({ hasWb: false, hasMyButton: false, hasVisibleNonScrollButton: false, hasScrollButton: false }));

      // Only actually scroll when there's nothing already clickable on
      // screen — a visible "Continue"/"Generate Link" instance always
      // takes priority over chasing a scroll-labeled one elsewhere on the
      // page. Real mouse wheel events (not JS scrollBy, which isn't a
      // trusted user gesture), in small increments, checking after each
      // one whether a different, genuinely on-screen button has appeared —
      // not just present somewhere in the DOM off-screen — rather than a
      // single fixed-size jump that might stop short of ever revealing it.
      if (!buttonState.hasVisibleNonScrollButton && !buttonState.hasWb && buttonState.hasScrollButton) {
        ctx.log?.('[llGate] "Scroll Down" step — scrolling until a clickable button comes into view');
        let revealed = false;
        for (let i = 0; i < 20 && Date.now() < deadline; i++) {
          await page.mouse.wheel(0, 250).catch(() => {});
          await page.waitForTimeout(randomDelay(200, 400));

          const state = await page
            .evaluate(() => {
              const buttons = Array.from(document.querySelectorAll('.myButton')).map((el) => {
                const rect = el.getBoundingClientRect();
                return {
                  text: (el.textContent || '').trim(),
                  visible: rect.width > 0 && rect.height > 0 && rect.top >= 0 && rect.bottom <= window.innerHeight,
                };
              });
              const atBottom = window.innerHeight + window.scrollY >= document.body.scrollHeight - 5;
              const found = buttons.find((b) => b.text && !/scroll/i.test(b.text) && b.visible);
              return { foundText: found?.text || null, atBottom };
            })
            .catch(() => ({ foundText: null, atBottom: false }));

          if (state.foundText) {
            ctx.log?.(`[llGate] "${state.foundText}" now in view after scrolling`);
            revealed = true;
            break;
          }
          if (state.atBottom) {
            ctx.log?.('[llGate] Reached the bottom of the page while scrolling for the button');
            break;
          }
        }
        if (!revealed) await page.waitForTimeout(randomDelay(400, 800));
        continue;
      }

      const sel = buttonState.hasWb ? '#wb' : (buttonState.hasMyButton ? '.myButton' : null);
      if (sel) {
        ctx.log?.(`[llGate] Waiting for ${sel} to clear (cursor genuinely a hand, not just present in the DOM)…`);
        const clicked = await clickWhenClear(page, ctx, sel, deadline);
        ctx.log?.(`[llGate] ${sel} ${clicked ? 'clicked' : 'never cleared before deadline — moving on'}`);
        // A little breathing room after a real click before checking again —
        // matches how a human actually interacts (not back-to-back at a
        // fixed 1000ms cadence every single tick), and gives the page time
        // to actually process the click before we look for the next state.
        await page.waitForTimeout(randomDelay(600, 1400));
      } else {
        await page.waitForTimeout(randomDelay(700, 1100));
      }
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
