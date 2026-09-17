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

const randomDelay = (minMs, maxMs) => minMs + Math.random() * (maxMs - minMs);

// Allowlist, not a blocklist — reported live: an "I'm not a robot"-
// labeled .myButton sitting next to the real target got clicked instead,
// and trying to enumerate every possible decoy/honeypot label (the
// reference project's own reverse-engineered notes on this exact gate,
// INTERCELESTIAL_ISSUES.md's "honeypot" section, describe deliberately-
// placed trap buttons styled to blend in with the real ones) is a losing
// battle — the site can add a new decoy text we've never seen at any
// time. Only the button texts actually confirmed live across this whole
// investigation ever need clicking; anything else — decoy, honeypot, or
// some future label we haven't seen — is never a valid target by
// construction, no enumeration needed. Shared between readButtonState's
// target selection and findClickableInstance's final click-time scan so
// neither can land on anything outside this set, at either step.
const REAL_BUTTON_TEXT_PATTERN = 'continue|generate link|get link|get verified link|verified link|click to verify';

// Deliberately NOT awaited by callers — closing a real Chrome process and
// recursively deleting its profile directory (cache, cookie DB, etc.) is
// genuinely slow (can run into multiple seconds, worse on Windows), and
// none of it needs to finish before the caller acts on an already-known
// result. Reported live: the main browser sat idle for a visible beat
// after "[llGate] Escaped ad-gate to ..." was logged before it actually
// navigated there — that gap was this cleanup blocking the function's
// return, not anything about the navigation itself.
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
 * Reads which .myButton instance (if any) is the real target — the first
 * one NOT labeled "scroll" — and whether it's currently on-screen, plus
 * whether a "Scroll Down" placeholder exists at all. Shared by the sweep
 * logic below and the main loop so both act on the exact same snapshot.
 *
 * Confirmed live: this template can render its button entirely inside an
 * iframe (diagnostic log showed `iframes=1` while `.myButton count=0` at
 * every scroll position — the button was never missing, it was just never
 * looked for in the right document). `page.evaluate()` only ever sees the
 * main frame, so this now runs the same detection in EVERY frame
 * (`page.frames()`, main frame included) and returns whichever frame
 * actually has a real target — that frame is carried on the result so
 * callers scroll/click inside it, not blindly against the main page.
 */
async function readButtonState(page) {
  const detectInFrame = (frame) =>
    frame
    .evaluate((realPattern) => {
      const isRealLabel = (text) => new RegExp(realPattern, 'i').test(text);
      const buttons = Array.from(document.querySelectorAll('.myButton')).map((el) => {
        const rect = el.getBoundingClientRect();
        // Center point, not full bounding-box containment. Reported live:
        // a sweep that stops exactly where the button sits half-cut-off at
        // the viewport edge (nothing wrong — that can genuinely be the
        // true scroll extreme, or just where scrollY happened to land)
        // made this permanently report not-visible, since requiring the
        // WHOLE box inside [0, innerHeight] fails the moment either edge
        // is clipped — even though the button's clickable center is
        // already on-screen. findClickableInstance clicks at this exact
        // center point, so "is the center on-screen" is the actually
        // correct question, not "is the whole box on-screen".
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        return {
          text: (el.textContent || '').trim(),
          visible: rect.width > 0 && rect.height > 0 && cx >= 0 && cx <= window.innerWidth && cy >= 0 && cy <= window.innerHeight,
          // Diagnostic-only fields (top/scrollY) — cheap to compute, not
          // used by any decision logic, but lets a live log line show
          // exactly how the page shifted when the button count changes,
          // instead of guessing. See "diagnostic: .myButton count changed"
          // below for why this was added.
          top: Math.round(rect.top),
        };
      });
      // See REAL_BUTTON_TEXT_PATTERN's own comment above — only a
      // confirmed-legitimate label can ever be targetIndex, not "anything
      // except a few known-bad ones".
      const targetIndex = buttons.findIndex((b) => isRealLabel(b.text));
      // Reported live: the robot honeypot still got clicked even after the
      // .myButton allowlist landed — because #wb never went through it at
      // all. "It's a unique id selector" was wrongly treated as "therefore
      // safe": uniqueness only means there's one element with that id, not
      // that the site can't (temporarily, or as a trap) give the honeypot
      // that same id. #wb now has to pass the exact same allowlist check
      // as every .myButton instance — no more assumed-safe-by-construction
      // selector anywhere in this resolver.
      const wbEl = document.getElementById('wb');
      const wbText = wbEl ? (wbEl.textContent || '').trim() : '';
      return {
        hasWb: !!wbEl && isRealLabel(wbText),
        hasMyButton: buttons.length > 0,
        targetIndex,
        targetVisible: targetIndex >= 0 ? buttons[targetIndex].visible : false,
        // Viewport-relative top of the target button right now (negative =
        // above the viewport, needs scrolling UP; > innerHeight = below,
        // needs scrolling DOWN) — lets the caller sweep toward the button's
        // actual side instead of always trying "down" first regardless.
        targetTop: targetIndex >= 0 ? buttons[targetIndex].top : null,
        hasScrollButton: buttons.some((b) => /scroll/i.test(b.text)),
        buttonCount: buttons.length,
        scrollY: Math.round(window.scrollY),
        wbText,
        buttonsSummary: buttons.map((b, i) => `${i}:"${b.text.slice(0, 20)}"${b.visible ? '(vis)' : ''}@${b.top}`).join(', '),
        // Real hCaptcha/reCAPTCHA/Turnstile iframes always carry a src on
        // the provider's own domain — if a button-like element only ever
        // exists inside an iframe, none of the main-frame-only checks
        // above would ever see it, which would explain a "never detected
        // at any scroll position" failure that has nothing to do with
        // scrolling at all.
        iframeCount: document.querySelectorAll('iframe').length,
      };
    }, REAL_BUTTON_TEXT_PATTERN)
    .catch(() => null);

  const frames = page.frames();
  const results = await Promise.all(frames.map(detectInFrame));

  // First frame (main frame is always frames()[0]) that actually has a real,
  // allowlisted target wins — that's the frame every caller scrolls/clicks
  // in. If nothing anywhere has a real target yet, fall back to the main
  // frame's own (likely empty) snapshot so the diagnostic log below still
  // has sensible numbers, and default to the main frame for any downstream
  // scroll attempt (a no-op, same as before this iframe-awareness existed).
  let winner = null;
  let winnerFrame = null;
  for (let i = 0; i < frames.length; i++) {
    const r = results[i];
    if (r && (r.hasWb || r.targetIndex >= 0)) {
      winner = r;
      winnerFrame = frames[i];
      break;
    }
  }
  if (!winner) {
    winner = results[0] || {
      hasWb: false, hasMyButton: false, targetIndex: -1, targetVisible: false, hasScrollButton: false,
      buttonCount: 0, scrollY: -1, wbText: '', buttonsSummary: '', iframeCount: -1,
    };
    winnerFrame = page.mainFrame();
  }
  return { ...winner, frame: winnerFrame, frameCount: frames.length };
}

/**
 * Sweeps all the way to one end of the page (real, trusted mouse-wheel
 * events, not JS scrollTo/scrollBy) rather than a single computed jump.
 * Confirmed live: this template can shift which .myButton instance is the
 * real one unpredictably as earlier steps complete (content loading/
 * collapsing), so a "smart" scroll to one specific element isn't reliable
 * enough on its own — a full sweep to a page extreme is a fixed, always-
 * reachable reference point a human effectively falls back on too when a
 * page's layout misbehaves.
 *
 * Reported live: the button at the top still often never entered the
 * viewport — this page has scroll CONTAINERS NESTED inside it, not just
 * the top-level window. page.mouse.wheel() only scrolls whatever's under
 * the mouse's current position (wherever a previous click left it, not
 * necessarily over the real scrollable content), and tracking only
 * window.scrollY as the stopping signal means a nested container that's
 * still mid-scroll gets mistaken for "reached the end" the moment the
 * outer window (which may already be static) stops moving. Now
 * repositions the mouse over the viewport center before every tick so the
 * wheel event reliably lands on real content, and tracks the deepest
 * scrollTop found across EVERY scrollable element on the page (not just
 * window), so the loop only stops once nothing — at any nesting level —
 * is still moving.
 *
 * Reported live: a button sitting in the MIDDLE of the page was still
 * getting missed even with this sweep in place — because the caller only
 * ever checked readButtonState() AFTER the sweep finished, once it had
 * already run all the way to the extreme. A button that only renders (or
 * is only genuinely visible) while scrolled near its own position, and
 * disappears again once scrolled past, was never caught — the check
 * happened too late, at the wrong scroll position entirely. `checkFn`
 * (readButtonState, from the caller) now runs after EVERY tick, and the
 * sweep stops the instant it reports a real, visible target — instead of
 * always running the full 25-tick trip to the extreme first regardless.
 */
async function sweepToExtreme(page, direction, deadline, checkFn) {
  const deltaY = direction === 'down' ? 900 : -900;
  const viewport = page.viewportSize() || { width: 1366, height: 768 };
  const cx = Math.round(viewport.width / 2);
  const cy = Math.round(viewport.height / 2);
  let lastSignature = null;
  for (let i = 0; i < 25 && Date.now() < deadline; i++) {
    await page.mouse.move(cx, cy).catch(() => {});
    await page.mouse.wheel(0, deltaY).catch(() => {});
    // Best-effort supplementary nudge for any NESTED scrollable container
    // the trusted wheel event above might not have reached — deliberately
    // excludes <html>/<body> (the top-level scroll the wheel event above
    // already handles as a genuinely trusted gesture; forcing it via JS
    // too would just duplicate that, not add anything). Never the only
    // mechanism — the real wheel event still fires regardless — just
    // insurance for whichever inner element actually holds the button.
    await page
      .evaluate((d) => {
        document.querySelectorAll('*').forEach((el) => {
          if (el === document.documentElement || el === document.body) return;
          if (el.scrollHeight - el.clientHeight > 10) {
            el.scrollTop = d === 'down' ? el.scrollHeight : 0;
          }
        });
      }, direction)
      .catch(() => {});
    await page.waitForTimeout(randomDelay(150, 300));

    if (checkFn) {
      const state = await checkFn();
      if (state && (state.hasWb || (state.targetIndex >= 0 && state.targetVisible))) {
        return state; // found mid-sweep — stop right here, don't keep scrolling past it
      }
    }

    const signature = await page
      .evaluate(() => {
        const tops = Array.from(document.querySelectorAll('*'))
          .filter((el) => el !== document.documentElement && el !== document.body && el.scrollHeight - el.clientHeight > 10)
          .map((el) => Math.round(el.scrollTop));
        return [Math.round(window.scrollY), ...tops].join(',');
      })
      .catch(() => null);
    if (signature === null) break;
    if (signature === lastSignature) break; // nothing, at any level, still moving
    lastSignature = signature;
  }
  return null;
}

/**
 * Confirmed live: this template can put TWO `.myButton` instances on the
 * page at once (e.g. one near the top, one further down after a "Scroll
 * Down" step) — `document.querySelector` would always grab whichever is
 * first in DOM order, even if that one is off-screen/behind the scroll
 * position and the OTHER instance is the one actually visible and
 * interactable right now. Scans every instance and returns the index of
 * whichever one is both on-screen and not covered by a decoy overlay (the
 * cursor would genuinely show a hand over it) — or -1 if none qualify yet.
 *
 * Takes a Frame, not necessarily the Page's main frame — readButtonState
 * may have found the real target inside an iframe (see its own comment),
 * and the click-time scan has to run in that same document or it would
 * always see zero elements, same bug as before.
 */
async function findClickableInstance(frame, selector, allowTextPattern) {
  return frame
    .evaluate(({ sel, allowPattern }) => {
      // See REAL_BUTTON_TEXT_PATTERN's comment — a decoy that's on-screen
      // and genuinely uncovered still needs to be filtered out by TEXT
      // here, since this scan otherwise has no other way to tell it apart
      // from the real target (both pass every positional/overlay check).
      // Allowlist, not a blocklist: only a confirmed-legitimate label ever
      // qualifies, so a decoy/honeypot text we've never seen before is
      // rejected by construction rather than needing to be enumerated.
      const allow = allowPattern ? new RegExp(allowPattern, 'i') : null;
      const els = Array.from(document.querySelectorAll(sel));
      for (let i = 0; i < els.length; i++) {
        const el = els[i];
        if (allow && !allow.test((el.textContent || '').trim())) continue;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        // Center point, not full bounding-box containment — see
        // readButtonState's matching comment. A button half-clipped at the
        // viewport edge (a real, ordinary scroll position, not a bug) has
        // an on-screen center and IS genuinely clickable there; requiring
        // the whole box inside the viewport rejected it for no real reason.
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        if (cx < 0 || cx > window.innerWidth || cy < 0 || cy > window.innerHeight) continue; // center off-screen
        const top = document.elementFromPoint(cx, cy);
        if (!top) continue;
        if (top === el || el.contains(top) || window.getComputedStyle(top).cursor === 'pointer') {
          return i;
        }
      }
      return -1;
    }, { sel: selector, allowPattern: allowTextPattern || null })
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
 *
 * `page` is still needed here purely for `waitForTimeout` (Frame has no
 * equivalent) — the actual scan/click runs against `frame`, which may be an
 * iframe, not the page's main frame.
 */
async function clickWhenClear(page, frame, ctx, selector, deadline, allowTextPattern) {
  while (Date.now() < deadline) {
    const idx = await findClickableInstance(frame, selector, allowTextPattern);
    if (idx >= 0) {
      const clicked = await frame
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

// TEMPORARY diagnostic — reported live: a full sweep (top, bottom, direct
// scroll) still finds nothing, AND nothing is visually present on screen
// either, not just off-screen/unscrolled-to. The iframe-awareness added to
// readButtonState above was a guess about WHERE the button might be, not a
// confirmed answer — an iframe present on the page doesn't necessarily mean
// it holds real gate content (could just as easily be an ad tracking pixel,
// 0x0 or off-screen by design). This dumps what's ACTUALLY rendered in
// every frame — visible body text and every iframe's src/size/visibility —
// so the next occurrence shows the real page state instead of another
// guess. Remove once the real cause here is confirmed.
async function dumpFrameDiagnostics(page, ctx) {
  for (const frame of page.frames()) {
    const info = await frame
      .evaluate(() => ({
        bodyText: (document.body?.innerText || '').trim().slice(0, 200),
        iframes: Array.from(document.querySelectorAll('iframe')).map((f) => ({
          src: (f.getAttribute('src') || '').slice(0, 80),
          w: f.offsetWidth,
          h: f.offsetHeight,
        })),
      }))
      .catch(() => null);
    if (!info) {
      ctx.log?.(`[llGate][diag] frame ${frame.url().slice(0, 60)} — evaluate failed (detached/cross-origin?)`);
      continue;
    }
    ctx.log?.(
      `[llGate][diag] frame ${frame.url().slice(0, 60)} bodyText="${info.bodyText.replace(/\s+/g, ' ')}" iframes=${JSON.stringify(info.iframes)}`,
    );
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
    // NOT --start-minimized — launches visible, then gets explicitly
    // minimized below via CDP after bringToFront(). Requested despite the
    // acknowledged risk: an earlier direct A/B test found the window
    // minimized AT ANY POINT during this flow — not just at launch — is
    // enough to reproduce the failure (24 of 28 attempts, never past the
    // first step), since Chrome throttles a hidden/minimized tab's JS
    // (Page Visibility API) and this template's own decoy-overlay-clearing
    // logic appears to depend on that JS running continuously throughout,
    // not just at startup. If failures return to that pattern, minimizing
    // below is the first thing to revert.
  });

  try {
    const page = await browser.newPage();

    // Confirmed via the community reference project's own reverse-engineered
    // detection doc (INTERCELESTIAL_ISSUES.md, "dns-probes"/"decision-matrix"):
    // the gate fetches 5 real Google/Amazon ad-network URLs and treats ≥2
    // failures as a block signal (path C) — logged there as fired exactly
    // this way via ERR_BLOCKED_BY_CLIENT. This network independently blocks
    // Google ad domains at the DNS/network level (confirmed earlier this
    // session via the same pagead2.googlesyndication.com fetch failing even
    // in a real, non-automated browser) — so this isolated resolver's own
    // requests to these URLs fail for a reason that has nothing to do with
    // automation, and reads to the gate as "adblocker/bot". browser.js's
    // newPage() already fakes the one of these five the main pipeline needs
    // (adsbygoogle.js); this resolver runs its own separate raw patchright
    // context and never got that fix, so all five stay faked here.
    const AD_PROBE_URLS = [
      '**://pagead2.googlesyndication.com/pagead/show_ads.js*',
      '**://securepubads.g.doubleclick.net/tag/js/gpt.js*',
      '**://www.googletagservices.com/tag/js/gpt.js*',
      '**://s.amazon-adsystem.com/aax2/apstag.js*',
      '**://www.googleadservices.com/pagead/conversion_async.js*',
    ];
    for (const pattern of AD_PROBE_URLS) {
      await page.route(pattern, (route) =>
        route.fulfill({ status: 200, contentType: 'application/javascript', body: '' }),
      ).catch(() => {});
    }

    // Confirmed live (both the original A/B test and every minimize
    // variant tried since — start-minimized, show-then-immediately-
    // minimize, show-for-5s-then-minimize): this gate genuinely needs the
    // window focused and visible for the ENTIRE run, not just at launch or
    // for an initial settle window. Minimizing it at any point reliably
    // breaks the site's own decoy-clearing logic (Chrome throttles a
    // hidden/minimized tab's JS via the Page Visibility API), so this
    // stays fully visible throughout — no minimizeWindow() call anywhere
    // in this resolver. bringToFront() is what actually made the
    // difference in the original A/B test; without it this run got stuck
    // the same way a minimized one did.
    await page.bringToFront().catch(() => {});

    // Every .myButton click reliably pop-unders a new tab (this template's
    // own ad monetization) and Chrome hands THAT tab focus — so our actual
    // page immediately goes back to being the non-visible/throttled one
    // again, defeating the bringToFront() above within one click. Close
    // every popup the instant it opens and reclaim focus on our page, so
    // it stays the visible/active tab for the resolver's whole run instead
    // of just its first instant.
    browser.on('page', (popup) => {
      // Requested: this was closing popups with zero record of what they
      // were. window.open(url)-style popups (confirmed this template's own
      // pattern) usually already have their URL by the time this event
      // fires; log whatever's available immediately, then close — closing
      // is never delayed waiting on this.
      const popupUrl = (() => { try { return popup.url(); } catch { return null; } })();
      ctx.log?.(`[llGate] Closing popup: ${popupUrl && popupUrl !== 'about:blank' ? popupUrl.slice(0, 80) : '(url not yet available)'}`);
      popup.close().catch(() => {});
      page.bringToFront().catch(() => {});
    });

    ctx.log?.(`[llGate] Fresh patchright instance resolving ${startUrl.slice(0, 60)}…`);
    await page.goto(startUrl, { waitUntil: 'load', timeout: 30000 }).catch(() => {});

    const deadline = Date.now() + timeoutMs;
    let lastUrl = page.url();
    // TEMPORARY diagnostic — investigating a reported live case where the
    // button was never detected at any scroll position (top/middle/
    // bottom) on a second intercelestial.com landing, with the hypothesis
    // that the page adds a NEW .myButton above the existing one(s) and
    // shifts things in a way targetIndex/scrollHeight don't handle. Only
    // logs when the button count actually changes, so this stays cheap
    // and doesn't spam every 500ms tick. Remove once the real cause here
    // is identified.
    let lastLoggedButtonCount = -1;
    let loggedRecaptchaPresence = false;
    let loggedFrameDiag = false;
    while (Date.now() < deadline) {
      if (page.isClosed()) throw new Error('LL ad-gate page closed unexpectedly');
      const url = page.url();

      if (url && url !== 'about:blank' && !isLLAdGateUrl(url)) {
        ctx.log?.(`[llGate] Escaped ad-gate to ${url.slice(0, 60)}…`);
        cleanupInBackground(browser, profileDir);
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

      // Reported live: intercelestial.com's own recaptcha-checkbox-border
      // element got clicked and that was actively wrong here — disabled.
      // Detection kept (cheap, useful in the diagnostic log below) but the
      // auto-click is gone; this gate's own .myButton/#wb allowlist flow
      // is what actually needs to run undisturbed, not a checkbox click
      // that was never confirmed to help THIS specific gate and, per the
      // user, should never be touched at all here.
      const hasRecaptcha = await page
        .evaluate(() => !!document.querySelector('iframe[src*="recaptcha/api2/anchor"], .recaptcha-checkbox-border'))
        .catch(() => false);
      if (hasRecaptcha && !loggedRecaptchaPresence) {
        loggedRecaptchaPresence = true;
        ctx.log?.('[llGate] recaptcha-checkbox-border element present — deliberately not clicking it (see comment above)');
      }

      // Confirmed live: this template can show TWO .myButton instances at
      // once (e.g. one near the top, one further down after a scroll
      // step), and separately can present a "Scroll Down" step with no
      // real button to click yet at all. Scanning every instance up front
      // — instead of just the first DOM match — means the scroll-vs-click
      // decision below is based on what's actually usable right now, not
      // on whichever button happens to come first in the markup.
      let buttonState = await readButtonState(page);
      if (buttonState.buttonCount !== lastLoggedButtonCount) {
        lastLoggedButtonCount = buttonState.buttonCount;
        ctx.log?.(
          `[llGate][diag] .myButton count=${buttonState.buttonCount} iframes=${buttonState.iframeCount} frames=${buttonState.frameCount} scrollY=${buttonState.scrollY} targetIndex=${buttonState.targetIndex} targetVisible=${buttonState.targetVisible} wb="${buttonState.wbText}"(allowed=${buttonState.hasWb}) → [${buttonState.buttonsSummary}]`,
        );
      }

      // Primary: a real target already exists in the DOM (even off-screen)
      // — scroll directly to that exact element via Playwright's own
      // actionability scrolling. Deterministic for ANY position on the
      // page, not just the two extremes: confirmed live, a sweep-only
      // strategy (scroll to the bottom, then the top) misses a target that
      // sits in the MIDDLE of a page taller than one viewport, since
      // neither extreme ever shows it — that was a real gap, not a timing
      // fluke.
      if (!buttonState.hasWb && buttonState.targetIndex >= 0 && !buttonState.targetVisible) {
        // Reported live: for a button currently ABOVE the viewport,
        // Playwright's own scrollIntoViewIfNeeded() (the "precise"
        // placement used in the else-branch below) doesn't reliably leave
        // it actually visible — it does the minimal scroll needed, which
        // can land the button right at the edge of the viewport instead of
        // clearly on-screen. A full scroll to the page's true top extreme
        // is simpler and unambiguous for this specific direction, so
        // prefer that over "precise" placement whenever the button is
        // above the viewport. Below-viewport targets keep the precise
        // scroll (see this block's own earlier comment: a full sweep to
        // the bottom extreme can overshoot past a target sitting in the
        // MIDDLE of a page taller than one viewport — that risk doesn't
        // apply the same way scrolling up toward a near-top button).
        if (buttonState.targetTop != null && buttonState.targetTop < 0) {
          ctx.log?.('[llGate] Target button is above the viewport — scrolling all the way to the top');
          await sweepToExtreme(page, 'up', deadline);
          buttonState = await readButtonState(page);
        } else {
          ctx.log?.('[llGate] Target button is off-screen — scrolling directly to it');
          // The target may live inside an iframe — get that <iframe>
          // element itself on-screen in the main page first, or its own
          // internal scrollIntoViewIfNeeded can succeed while the iframe
          // box itself is still off-screen in the parent document.
          if (buttonState.frame !== page.mainFrame()) {
            const frameEl = await buttonState.frame.frameElement().catch(() => null);
            await frameEl?.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
          }
          await buttonState.frame.locator('.myButton').nth(buttonState.targetIndex).scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
          await page.waitForTimeout(randomDelay(200, 400));
          buttonState = await readButtonState(page);
        }
      }

      // Reported live: right after Cloudflare's own interstitial clears (no
      // URL change happens for that transition, so the "landed on a new
      // page" settle-wait above never fires for it), the real button is
      // often already on-screen near the top the instant real content
      // renders — but a check that lands mid-transition can transiently
      // miss it entirely (targetIndex still -1, no position signal to
      // sweep toward yet), and the page was left scrolled wherever the
      // interstitial happened to leave it, not necessarily the top. Cheap,
      // near-instant check first: jump straight to the top and recheck —
      // resolves the common case immediately without ever touching the
      // slower, further-displacing sweep loop below.
      if (!buttonState.hasWb && buttonState.targetIndex < 0 && buttonState.scrollY > 0) {
        await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
        await page.waitForTimeout(randomDelay(200, 400));
        buttonState = await readButtonState(page);
      }

      // Fallback: either no real target exists in the DOM at all yet (a
      // page that lazy-reveals the next button only once scrolled), or
      // the direct scroll above still didn't leave it visible for some
      // reason — sweep both fixed extremes as a last resort. Reported
      // live: this template can also reshuffle which instance is the real
      // one unpredictably as earlier steps complete, which a single direct
      // scroll can race against; two fixed, always-reachable reference
      // points is what a human effectively falls back on too.
      //
      // Reported live: a button sitting near the TOP consistently failed to
      // ever land in the viewport — root cause was this always sweeping to
      // the BOTTOM first regardless of where the button actually is, then
      // sweeping back up; that round trip (through however much lazy-
      // loaded/reshuffled content the bottom sweep touches along the way)
      // isn't guaranteed to land back at true scrollY=0 the same way a
      // direct up-sweep from the current position does. `targetTop` (set
      // by the direct-scroll attempt's own readButtonState call above) is a
      // real, current signal for which side the button is actually on when
      // it's known at all — use it to sweep toward the button first, and
      // only fall back to the fixed down-then-up order when the button
      // isn't in the DOM yet at all (targetTop is null) and there's no
      // position signal to go on.
      if (!buttonState.hasWb && (buttonState.targetIndex < 0 || !buttonState.targetVisible)) {
        const sweepUpFirst = buttonState.targetTop != null && buttonState.targetTop < 0;
        const firstDir = sweepUpFirst ? 'up' : 'down';
        const secondDir = sweepUpFirst ? 'down' : 'up';
        // Reported live: sweeping UP and stopping the instant readButtonState
        // reports the target "visible" still landed it behind a sticky/
        // fixed header — targetVisible only checks the button's bounding
        // box against the viewport, not what's actually painted on top of
        // it, so a position a sticky bar covers can still read as
        // "visible". Scrolling up never needs the early-exit that helps
        // catch a MIDDLE-of-page target on the way down (there's no
        // equivalent "overshoot past it" risk going up toward a near-top
        // button) — so an upward sweep always runs the full trip to the
        // genuine top extreme, past wherever a sticky header settles,
        // instead of trusting an early "visible" reading that might be a
        // false positive.
        const checkFnFor = (dir) => (dir === 'up' ? undefined : () => readButtonState(page));

        ctx.log?.(`[llGate] Still not visible — sweeping to the ${firstDir === 'down' ? 'bottom' : 'top'} of the page`);
        const foundFirst = await sweepToExtreme(page, firstDir, deadline, checkFnFor(firstDir));
        buttonState = foundFirst || await readButtonState(page);

        if (!foundFirst && (buttonState.targetIndex < 0 || !buttonState.targetVisible)) {
          ctx.log?.(`[llGate] Not found at the ${firstDir === 'down' ? 'bottom' : 'top'} — sweeping to the ${secondDir === 'down' ? 'bottom' : 'top'} of the page`);
          const foundSecond = await sweepToExtreme(page, secondDir, deadline, checkFnFor(secondDir));
          buttonState = foundSecond || await readButtonState(page);
        }

        if (buttonState.targetIndex >= 0 && buttonState.targetVisible) {
          ctx.log?.('[llGate] Button now visible after sweeping');
        } else {
          ctx.log?.('[llGate] Still not visible after a full sweep — waiting for the page to change');
          if (!loggedFrameDiag) {
            loggedFrameDiag = true;
            await dumpFrameDiagnostics(page, ctx);
          }
          await page.waitForTimeout(randomDelay(500, 900));
          continue;
        }
      }

      const sel = buttonState.hasWb ? '#wb' : (buttonState.hasMyButton ? '.myButton' : null);
      if (sel) {
        // Reported live: when the target is already on-screen from the very
        // FIRST check (no scroll ever needed — confirmed right after
        // Cloudflare clears, the button can already be sitting near the
        // top), every scroll branch above is skipped entirely, so this
        // resolver used to go straight to clicking with ZERO prior
        // interaction of any kind — and the click just never took effect
        // until the user manually clicked or scrolled once first. Fixing
        // that needs SOME real interaction event first, but an earlier
        // version of this fix unconditionally scrolled all the way to the
        // page top before every click — wrong whenever the button is
        // actually further down the page (middle/bottom), since that
        // scrolls straight past it instead of near it. Only jump to the
        // true top when we're already near the top (scrollY close to 0) —
        // a full top-scroll there also settles any sticky/fixed header
        // that a tiny few-pixel nudge could leave half-activated, covering
        // the button. Anywhere else, a small net-zero wheel tick right in
        // place fires a genuine interaction event without relocating the
        // scroll position the earlier steps already got right.
        {
          const viewport = page.viewportSize() || { width: 1366, height: 768 };
          const cx = Math.round(viewport.width / 2);
          const cy = Math.round(viewport.height / 2);
          await page.mouse.move(cx, cy).catch(() => {});
          if (buttonState.scrollY != null && buttonState.scrollY < 50) {
            await page.mouse.wheel(0, -3000).catch(() => {});
            await page.waitForTimeout(150);
          } else {
            await page.mouse.wheel(0, 2).catch(() => {});
            await page.waitForTimeout(80);
            await page.mouse.wheel(0, -2).catch(() => {});
          }
        }
        // Requested: once a valid, on-screen target is confirmed, settle
        // for a full second before ever attempting the click — real wall-
        // clock time for whatever decoy-clearing/overlay JS the page runs
        // right after a button becomes visible to actually finish, rather
        // than racing it. clickWhenClear's own findClickableInstance check
        // still runs fresh after this wait, so a decoy that reappears
        // during it is still caught, not blindly clicked into.
        await page.waitForTimeout(1000);
        ctx.log?.(`[llGate] Waiting for ${sel} to clear (cursor genuinely a hand, not just present in the DOM)…`);
        // Always pass the allowlist, #wb included — "it's a unique id
        // selector" turned out NOT to mean "therefore safe" (see
        // REAL_BUTTON_TEXT_PATTERN's comment on readButtonState's hasWb
        // check above); defense in depth in case the element's text
        // changes between that check and this actual click.
        const clicked = await clickWhenClear(page, buttonState.frame, ctx, sel, deadline, REAL_BUTTON_TEXT_PATTERN);
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
  } catch (err) {
    cleanupInBackground(browser, profileDir);
    throw err;
  }
}

export default resolveLLAdGate;
