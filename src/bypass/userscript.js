/**
 * In-page automation injected into every navigation of a bypass job.
 *
 * This is a headless-automation port of the "Bypass Pahe Links" Violentmonkey
 * userscript (by NaeemBolchhi, GPL-3.0). The original relies on CSS to bring
 * hidden buttons to the foreground so a human can tap them; here we instead
 * auto-click/redirect programmatically since there is no human in the loop.
 *
 * It is passed to Playwright's `addInitScript` and therefore runs at
 * document-start in the page's own context. It must be fully self-contained
 * (no Node closures) and defensive (every step wrapped in try/catch), because
 * these ad pages are hostile and change often.
 *
 * The captcha/gdflix handling is done from Node (see resolvers/), not here.
 */

export const AD_HOSTS = [
  'teknoasian.com',
  'intercelestial.com',
  'linegee.net',
  'spacetica.com',
  'pahe.plus',
  'old.pahe.plus',
  'oii.la',
  'uii.io',
  'wp2hostt.com',
  'wordcounter.icu',
  'tpi.li',
  'blogmystt.com',
  'hosttbuzz.com',
  'policiesreview.com',
  'healthylifez.com',
  'insurancemyst.com',
  'hostingbixby.com',
  'policiesbuzzz.com',
  'hostingzbuzz.com',
  'bixbyfortech.com',
  'serverguidez.com',
  'comparepolicyy.com',
  'cheaplann.com',
  'vpshostplans.com',
  'ensureguide.com',
  'fitnessplanss.com',
  'sharedwebs.com',
  'hostserverz.com',
  'cloudhostingz.com',
  'carensureplan.com',
  'playareaz.com',
  'fitnesstipz.com',
  'ensuretips.com',
  'softdevelopp.com',
  'vpzserver.com',
  'tophostdeal.com',
  'evensuregd.com',
  'bestensuree.com',
  'hostzteam.com',
  'devsoftwr.com',
  'zpserver.com',
  'ouo.io',
  'ouo.press',
];

/** The function injected into the page. Kept as a Function so Playwright can
 *  serialize it. Do not reference anything outside its own body. */
export function pageAutomation() {
  'use strict';
  if (window.self !== window.top) return; // Only run in the main document context, ignore all iframes!
  if (window.__paheAuto) return;
  window.__paheAuto = true;

  const site = window.location.hostname.replace(/^www\./, '');
  console.log(`[pahe-auto] Userscript loaded on ${window.location.href}`);

  // ── speed up the countdown timers the ad pages use ──
  try {
    const noSpeed = ['oii.la', 'linegee.net', 'tpi.li', 'pahe.plus', 'ouo.io', 'ouo.press', 'teknoasian.com'];
    if (!noSpeed.some((s) => site.includes(s))) {
      const oT = window.setTimeout.bind(window);
      const oI = window.setInterval.bind(window);
      window.setTimeout = (cb, d, ...a) => oT(cb, (d || 0) / 50, ...a);
      window.setInterval = (cb, d, ...a) => oI(cb, (d || 0) / 50, ...a);
    } else {
      console.log(`[pahe-auto] Speedup disabled for domain: ${site}`);
    }
  } catch {}

  function clearOnclickAds() {
    try {
      document.querySelectorAll('*[onclick*="window.open"]').forEach((n) => n.removeAttribute('onclick'));
      document.querySelectorAll('*[href*="https:///"]').forEach((n) => n.removeAttribute('href'));
    } catch {}
  }

  // ── per-host auto-advance logic (ported from the userscript click funcs) ──
  function clickLinks() {
    try {
      const o = window.location.origin;
      if (/pahe\.plus|oii\.la|tpi\.li/.test(o)) {
        const b = document.querySelector('.get-link:not(.disabled)');
        if (b && b.href && !window.__done) {
          window.__done = true;
          window.location.assign(b.href);
        }
      } else if (/wp2hostt\.com/.test(o)) {
        const b = document.querySelector('button#getlink');
        if (b && !window.__done) { window.__done = true; b.click(); }
      } else if (/linegee\.net/.test(o) && document.readyState === 'complete') {
        document.querySelectorAll('script').forEach((s) => {
          if (/location\.href.*atob/.test(s.textContent) && !window.__done) {
            const b64 = s.textContent.replace(/[\t\s]/g, '').replace(/^.*location.href.*atob\('(.*)'\).*/, '$1');
            window.__done = true;
            setTimeout(() => { window.location.href = window.location.href + atob(b64); }, 200);
          }
        });
      } else if (/ouo\.(io|press)/.test(o)) {
        // Page 2: countdown / redirect
        const goForm = document.getElementById('go-link');
        if (goForm && !window.__done) {
          window.__done = true;
          console.log(`[pahe-auto] ouo.io Page 2 detected. Submitting form: #go-link`);
          formSubmit(goForm);
          return;
        }

        // Page 1: "I'm a human" with Turnstile
        const captchaForm = document.getElementById('form-captcha');
        if (captchaForm && !window.__done) {
          const cfres = document.querySelector('[name="cf-turnstile-response"]');
          if (cfres && cfres.value) {
            window.__done = true;
            console.log(`[pahe-auto] ouo.io Page 1 solved (Turnstile token present). Submitting form: #form-captcha`);
            formSubmit(captchaForm);
          }
        }
      }

      if (/wordcounter\.icu/.test(o) && document.readyState === 'complete') {
        const c = document.querySelector('#invisibleCaptchaShortlink');
        if (c && !window.__d1) {
          window.__d1 = true;
          console.log(`[pahe-auto] Clicked #invisibleCaptchaShortlink on wordcounter.icu`);
          c.click();
        }
        const g = document.querySelector('a.get-link[href]:not(.disabled)');
        if (g && !window.__d2) {
          window.__d2 = true;
          console.log(`[pahe-auto] Redirecting to: ${g.href} on wordcounter.icu`);
          window.location.assign(g.href);
        }
      }
    } catch (err) {
      console.error(`[pahe-auto] Error in clickLinks(): ${err.message}`);
    }
  }

  // Safe wrapper to submit form and simulate standard submit
  function formSubmit(form) {
    try {
      const submitBtn = form.querySelector('[type="submit"], button:not([type])');
      if (submitBtn) {
        submitBtn.removeAttribute('disabled');
        submitBtn.click();
      } else {
        form.submit();
      }
    } catch {
      form.submit();
    }
  }

  function pullButton() {
    if (site !== 'oii.la' && site !== 'tpi.li') return;
    try {
      const f = document.querySelector('form:not(.td-search-form):not(.go-link)');
      if (f && f.getAttribute('moved') !== 'true') {
        document.body.appendChild(f);
        f.setAttribute('moved', 'true');
        const btn = f.querySelector('button');
        if (btn) { btn.removeAttribute('onclick'); btn.removeAttribute('disabled'); }
      }
    } catch {}
    try {
      const l = document.querySelector('a.get-link[href]:not(.disabled)');
      if (l && l.getAttribute('moved') !== 'true') {
        document.body.appendChild(l);
        l.setAttribute('moved', 'true');
        l.removeAttribute('onclick');
        l.removeAttribute('disabled');
      }
    } catch {}
  }

  function blogmysttAuto() {
    try {
      const first = document.querySelector('a#startButton');
      const second = document.querySelector('button#getnewlink');
      if (first && window.__c1 !== true) { window.__c1 = true; first.click(); }
      if (second && window.__c2 !== true) { window.__c2 = true; second.click(); }
    } catch {}
    // sora-style shortlink buttons
    try {
      const gen = document.querySelector('#generater.ready, #lite-start-sora-a');
      if (gen && window.__c3 !== true) { window.__c3 = true; gen.click(); }
      const show = document.querySelector('#showlink.ready, #lite-end-sora-button, #getnewlink');
      if (show && window.__c4 !== true) { window.__c4 = true; show.click(); }
    } catch {}
  }

  function teknoasianAuto() {
    if (site !== 'teknoasian.com') return;
    if (document.readyState !== 'complete' && document.readyState !== 'interactive') return;
    try {
      const verify = document.querySelector('.humanVerify .verify');
      if (verify && window.__t1 !== true) {
        window.__t1 = true;
        verify.scrollIntoView({ block: 'center' });
        verify.click();
      }
      const skip = document.querySelector('.Skipper > .skipcontent');
      if (skip && window.__t2 !== true) {
        window.__t2 = true;
        setTimeout(() => skip.click(), 200);
      }
      const postnext = document.querySelector('.postnext');
      if (postnext && window.__t3 !== true) {
        window.__t3 = true;
        const form = postnext.closest('form');
        if (form) setTimeout(() => form.submit(), 150);
      }
    } catch {}
  }

  function removeAdOverlays() {
    try {
      const elements = document.querySelectorAll('div, a, span');
      elements.forEach((el) => {
        try {
          const attrStr = ((el.className || '') + ' ' + (el.id || '') + ' ' + (el.getAttribute('style') || '')).toLowerCase();
          
          // Detect and delete fake, moving ad captcha iframe containers (checking src/srcdoc)
          const iframe = el.querySelector('iframe');
          if (iframe) {
            const src = (iframe.src || '').toLowerCase();
            const srcdoc = (iframe.getAttribute('srcdoc') || '').toLowerCase();
            if (
              src.includes('pingelethal.cfd') || 
              srcdoc.includes('pingelethal.cfd') ||
              srcdoc.includes("i'm not a robot") ||
              srcdoc.includes("captcha_checkbox") ||
              srcdoc.includes("show content")
            ) {
              console.log('[pahe-auto] Detected and removed fake captcha ad overlay');
              el.style.display = 'none';
              el.remove();
              return;
            }
          }

          if (
            attrStr.includes('hcaptcha') || 
            attrStr.includes('recaptcha') || 
            attrStr.includes('turnstile') || 
            attrStr.includes('captcha')
          ) {
            return;
          }

          const style = window.getComputedStyle(el);
          if (
            (style.position === 'fixed' || style.position === 'absolute') &&
            parseInt(style.zIndex, 10) > 100 &&
            (style.width === '100%' || style.width.includes('100vw') || el.offsetWidth >= window.innerWidth * 0.9) &&
            (style.height === '100%' || style.height.includes('100vh') || el.offsetHeight >= window.innerHeight * 0.9)
          ) {
            const hasText = el.textContent.trim().length > 0;
            const hasInput = el.querySelector('input, button, select, textarea, iframe') !== null;
            if (!hasText && !hasInput) {
              el.style.display = 'none';
              el.remove();
            }
          }
        } catch {}
      });
    } catch {}
  }

  const startTime = Date.now();
  const tick = () => {
    // If the page has a captcha container AND we are on pahe.plus or ouo.io/ouo.press AND it is unsolved, abort completely to run plain
    const isStealthDomain = /pahe\.plus|old\.pahe\.plus|ouo\.(io|press)/i.test(window.location.hostname);
    if (
      isStealthDomain &&
      (document.querySelector('input[name="action"][value="captcha"]') ||
       document.querySelector('.h-captcha, .g-recaptcha, #captchaShortlink, #captcha, #recaptcha, .cf-turnstile') ||
       window.hcaptcha || window.grecaptcha || window.turnstile) &&
      !isCaptchaSolved()
    ) {
      return;
    }

    // Continuously delete full-screen click-jacking overlays so users can click links/checkboxes
    removeAdOverlays();

    // 1. Initial page load delay setting (safeguards initialization)
    const delayMs = window.__paheDelayMs || 1500;
    if (Date.now() - startTime < delayMs) return;

    clearOnclickAds();
    clickLinks();
    pullButton();
    blogmysttAuto();
    teknoasianAuto();
  };

  // run frequently; pages redraw buttons unpredictably
  try { setInterval(tick, 30); } catch {}
  if (document.readyState !== 'loading') tick();
  document.addEventListener('readystatechange', tick);
  document.addEventListener('DOMContentLoaded', tick);
}

export default pageAutomation;
