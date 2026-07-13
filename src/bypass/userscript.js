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
  const o = window.location.origin;
  const startTime = Date.now();

  console.log(`[pahe-auto] Userscript loaded on ${window.location.href}`);

  // ==========================================
  // DOMAIN-SPECIFIC BEHAVIOR RULES
  // ==========================================
  const DOMAIN_RULES = {
    // ------------------------------------------
    // SEGMENT 1: teknoasian.com (Speed up, clean overlays, auto verification clicks)
    // ------------------------------------------
    'teknoasian.com': {
      speedup: true,
      cleanOverlays: true,
      run: () => {
        if (document.readyState !== 'complete' && document.readyState !== 'interactive') return;
        try {
          const verify = document.querySelector('.humanVerify .verify');
          if (verify && window.__t1 !== true) {
            window.__t1 = true;
            console.log('[pahe-auto] [teknoasian] Clicking .humanVerify .verify');
            verify.scrollIntoView({ block: 'center' });
            verify.click();
          }
          const skip = document.querySelector('.Skipper > .skipcontent');
          if (skip && window.__t2 !== true) {
            window.__t2 = true;
            console.log('[pahe-auto] [teknoasian] Skipper button found. Clicking skip in 200ms.');
            setTimeout(() => skip.click(), 200);
          }
          const postnext = document.querySelector('.postnext');
          if (postnext && window.__t3 !== true) {
            window.__t3 = true;
            const form = postnext.closest('form');
            if (form) {
              console.log('[pahe-auto] [teknoasian] Submitting Skipper form in 150ms.');
              setTimeout(() => form.submit(), 150);
            }
          }
        } catch (err) {
          console.error(`[pahe-auto] Error in teknoasian handler: ${err.message}`);
        }
      }
    },

    // ------------------------------------------
    // SEGMENT 2: pahe.plus & old.pahe.plus (100% PLAIN, do NOT touch DOM, let user solve hCaptcha natively)
    // ------------------------------------------
    'pahe.plus': {
      speedup: false,
      cleanOverlays: false, // Keep DOM completely pristine to avoid triggering sensitive hCaptcha security blocks
      run: () => {
        console.log('[pahe-auto] [pahe.plus] Running in 100% plain mode. DOM is untouched.');
      }
    },
    'old.pahe.plus': {
      speedup: false,
      cleanOverlays: false,
      run: () => {
        console.log('[pahe-auto] [old.pahe.plus] Running in 100% plain mode. DOM is untouched.');
      }
    },

    // ------------------------------------------
    // SEGMENT 3: ouo.io & ouo.press (Cloudflare Turnstile, remove fake captcha ads, submit forms when solved)
    // ------------------------------------------
    'ouo.io': {
      speedup: false,
      cleanOverlays: true, // We must clean up fake yellow moving boxes
      run: () => {
        try {
          // Page 2: countdown / redirect
          const goForm = document.getElementById('go-link');
          if (goForm && !window.__done) {
            window.__done = true;
            console.log(`[pahe-auto] [ouo.io] Page 2 detected. Submitting countdown form: #go-link`);
            formSubmit(goForm);
            return;
          }

          // Page 1: "I'm a human" with Turnstile
          const captchaForm = document.getElementById('form-captcha');
          if (captchaForm && !window.__done) {
            const cfres = document.querySelector('[name="cf-turnstile-response"]');
            if (cfres && cfres.value) {
              window.__done = true;
              console.log(`[pahe-auto] [ouo.io] Page 1 solved (Turnstile token present). Submitting form: #form-captcha`);
              formSubmit(captchaForm);
            }
          }
        } catch (err) {
          console.error(`[pahe-auto] Error in ouo.io handler: ${err.message}`);
        }
      }
    },
    'ouo.press': {
      speedup: false,
      cleanOverlays: true,
      run: () => {
        // Reuse ouo.io handler
        DOMAIN_RULES['ouo.io'].run();
      }
    }
  };

  // Determine active rule matching current domain
  const getActiveRule = () => {
    for (const key of Object.keys(DOMAIN_RULES)) {
      if (site.includes(key)) return DOMAIN_RULES[key];
    }
    // DEFAULT/FALLBACK RULE (for other domains: oii.la, linegee.net, wordcounter.icu, etc.)
    return {
      speedup: true,
      cleanOverlays: true,
      run: () => {
        try {
          fallbackResolvers();
        } catch (err) {
          console.error(`[pahe-auto] Error in fallback resolver: ${err.message}`);
        }
      }
    };
  };

  const activeRule = getActiveRule();

  // ==========================================
  // TIMER SPEEDUP INITIATION
  // ==========================================
  const userExclusions = window.__paheSpeedUpExclusions || [];
  const shouldSpeedUp = activeRule.speedup && !userExclusions.some(s => site.includes(s));
  if (shouldSpeedUp) {
    try {
      const oT = window.setTimeout.bind(window);
      const oI = window.setInterval.bind(window);
      window.setTimeout = (cb, d, ...a) => oT(cb, (d || 0) / 50, ...a);
      window.setInterval = (cb, d, ...a) => oI(cb, (d || 0) / 50, ...a);
      console.log(`[pahe-auto] 50x Timer speedup enabled for ${site}`);
    } catch (err) {
      console.error(`[pahe-auto] Failed to initialize timer speedup: ${err.message}`);
    }
  } else {
    console.log(`[pahe-auto] Timer speedup disabled for ${site}`);
  }

  // ==========================================
  // RESOLVER UTILITIES & HELPERS
  // ==========================================
  function isCaptchaSolved() {
    try {
      const hres = document.querySelector('[name="h-captcha-response"]');
      const gres = document.querySelector('[name="g-recaptcha-response"]');
      const cfres = document.querySelector('[name="cf-turnstile-response"]');
      if (hres && hres.value) return true;
      if (gres && gres.value) return true;
      if (cfres && cfres.value) return true;
    } catch {}
    return false;
  }

  function formSubmit(form) {
    try {
      const submitBtn = form.querySelector('[type="submit"], button:not([type])');
      if (submitBtn) {
        submitBtn.removeAttribute('disabled');
        submitBtn.click();
        // Fallback: submit the form directly after 100ms if click didn't trigger navigation
        setTimeout(() => {
          try { form.submit(); } catch {}
        }, 100);
      } else {
        form.submit();
      }
    } catch {
      form.submit();
    }
  }

  function clearOnclickAds() {
    try {
      document.querySelectorAll('*[onclick*="window.open"]').forEach((n) => n.removeAttribute('onclick'));
      document.querySelectorAll('*[href*="https:///"]').forEach((n) => n.removeAttribute('href'));
    } catch {}
  }

  function fallbackResolvers() {
    // 1. oii.la / tpi.li
    if (/oii\.la|tpi\.li/.test(o)) {
      pullButton();
      const b = document.querySelector('.get-link:not(.disabled)');
      if (b && b.href && !window.__done) {
        window.__done = true;
        console.log(`[pahe-auto] Redirecting to get-link: ${b.href}`);
        window.location.assign(b.href);
      }
    }

    // 2. wp2hostt.com
    if (/wp2hostt\.com/.test(o)) {
      const b = document.querySelector('button#getlink');
      if (b && !window.__done) {
        window.__done = true;
        b.click();
      }
    }

    // 3. linegee.net
    if (/linegee\.net/.test(o) && document.readyState === 'complete') {
      document.querySelectorAll('script').forEach((s) => {
        if (/location\.href.*atob/.test(s.textContent) && !window.__done) {
          const b64 = s.textContent.replace(/[\t\s]/g, '').replace(/^.*location.href.*atob\('(.*)'\).*/, '$1');
          window.__done = true;
          setTimeout(() => { window.location.href = window.location.href + atob(b64); }, 200);
        }
      });
    }

    // 4. wordcounter.icu
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

    // 5. blogmystt.com
    if (/blogmystt\.com/.test(o)) {
      blogmysttAuto();
    }
  }

  function pullButton() {
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
    try {
      const gen = document.querySelector('#generater.ready, #lite-start-sora-a');
      if (gen && window.__c3 !== true) { window.__c3 = true; gen.click(); }
      const show = document.querySelector('#showlink.ready, #lite-end-sora-button, #getnewlink');
      if (show && window.__c4 !== true) { window.__c4 = true; show.click(); }
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

  // ==========================================
  // TICK ROUTINE (CORE LOOP)
  // ==========================================
  const tick = () => {
    // 1. Clean overlays if allowed for this domain
    if (activeRule.cleanOverlays) {
      removeAdOverlays();
    }

    // 2. Abort if captcha is unsolved (only for stealth domains like pahe or ouo)
    const isStealthDomain = /pahe\.plus|old\.pahe\.plus|ouo\.(io|press)/i.test(site);
    if (
      isStealthDomain &&
      (document.querySelector('input[name="action"][value="captcha"]') ||
       document.querySelector('.h-captcha, .g-recaptcha, #captchaShortlink, #captcha, #recaptcha, .cf-turnstile') ||
       window.hcaptcha || window.grecaptcha || window.turnstile) &&
      !isCaptchaSolved()
    ) {
      return;
    }

    // 3. Initial page load delay setting (safeguards initialization)
    const delayMs = window.__paheDelayMs || 1500;
    if (Date.now() - startTime < delayMs) return;

    // 4. Run active domain resolver routine
    clearOnclickAds();
    activeRule.run();
  };

  try { setInterval(tick, 30); } catch {}
  if (document.readyState !== 'loading') tick();
  document.addEventListener('readystatechange', tick);
  document.addEventListener('DOMContentLoaded', tick);
}

export default pageAutomation;
