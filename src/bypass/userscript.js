import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Read the separate rule files
const teknoasianRule = fs.readFileSync(path.join(__dirname, 'rules/teknoasian.js'), 'utf8');
const paheRule = fs.readFileSync(path.join(__dirname, 'rules/pahe.js'), 'utf8');
const ouoRule = fs.readFileSync(path.join(__dirname, 'rules/ouo.js'), 'utf8');
const oiilaRule = fs.readFileSync(path.join(__dirname, 'rules/oiila.js'), 'utf8');
const fallbackRule = fs.readFileSync(path.join(__dirname, 'rules/fallback.js'), 'utf8');

export const AD_HOSTS = [
  'teknoasian.com',
  'intercelestial.com',
  'linegee.net',
  'spacetica.com',
  'pahe.plus',
  'old.pahe.plus',
  'oii.la',
  'uii.io',
  // Confirmed live: same backend as oii.la — its landing page loads
  // //oii.la/webroot/cloud_theme/build/js/script.loader.js directly, and
  // serves the identical "cloud_theme" asset paths, form structure
  // (form#form-continue, "Please click on below captcha box"), and Google
  // AdSense-fetch-based "please disable Adblock" false-positive (see
  // browser.js's adsbygoogle.js route fake — the fetch to
  // pagead2.googlesyndication.com fails on networks that block Google ad
  // domains, which this site's own script wrongly reads as "adblock is on"
  // and hides the real captcha/Continue button behind a dead-end wall).
  'clksz.com',
  // Same family as clksz.com — confirmed live via identical cloud_theme
  // asset paths and the same rvpaste728.png banner ad.
  'srnky.com',
  'autoshieldd.com',
  'financeehelp.com',
  'cloudhostt.com',
  'selfhostt.com',
  'ssdhostting.com',
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

// The "startButton/getnewlink" ad-gate template — blogmystt.com's own DOM
// structure (#startButton, #getnewlink, #generater/#lite-start-sora-a,
// #showlink/#lite-end-sora-button), white-labeled across many rotating
// lookalike domains to dodge adblock host-lists. Every one of these uses the
// identical click-through automation as blogmystt.com — see fallback.js.
export const ADBLOCK_GATE_HOSTS = [
  'blogmystt.com',
  'autoshieldd.com',
  'financeehelp.com',
  'cloudhostt.com',
  'selfhostt.com',
  'ssdhostting.com',
  'wp2hostt.com',
  'intercelestial.com',
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
];

// Combine them into a single self-contained string to inject into pages
export function getInjectedAutomationScript(config = {}) {
  const injectOuo = config.bypass?.injectOuoScript !== false;
  const speedUpPahe = config.bypass?.speedUpPahe !== false;
  const removeOuoAds = config.bypass?.removeOuoAds !== false;
  return `
  (function() {
    'use strict';
    if (window.self !== window.top) return; // Only main document
    if (window.__paheAuto) return;
    window.__paheAuto = true;

    // Captured before the timer-speedup override (below) can touch
    // window.setInterval, so the click-decoy stripper always runs at a true
    // 100ms cadence regardless of a domain's speedup setting — it has to
    // outrun the page's own re-insertion interval, not the reverse.
    const rawSetInterval = window.setInterval.bind(window);

    const site = window.location.hostname.replace(/^www\\./, '');

    // ── Dedicated Flying/Floating Ads Cleaner for ouo.io ──
    const removeOuoAdsSetting = ${removeOuoAds};
    if (removeOuoAdsSetting && /ouo\\.(io|press)/i.test(site)) {
      try {
        const style = document.createElement('style');
        style.innerHTML = \`
          body > div[style*="position: fixed"], 
          body > div[style*="position: absolute"],
          body > iframe[style*="position: fixed"],
          body > iframe[style*="position: absolute"],
          body > a[style*="position: fixed"],
          body > a[style*="position: absolute"] {
            display: none !important;
            opacity: 0 !important;
            pointer-events: none !important;
            width: 0 !important;
            height: 0 !important;
          }
        \`;
        document.documentElement.appendChild(style);
      } catch {}

      const cleanOuoAds = () => {
        try {
          document.querySelectorAll('*').forEach((el) => {
            if (el.closest('#form-captcha') || el.closest('#form-go')) return;
            const style = window.getComputedStyle(el);
            if (style.position === 'fixed' || style.position === 'absolute') {
              if (el.querySelector('.cf-turnstile') || el.classList.contains('cf-turnstile')) return;
              el.style.display = 'none';
              el.remove();
            }
          });
        } catch {}
      };
      
      cleanOuoAds();
      document.addEventListener('DOMContentLoaded', cleanOuoAds);
      window.addEventListener('load', cleanOuoAds);
      setInterval(cleanOuoAds, 400);
    }

    // Check if ouo injection is disabled
    const injectOuo = ${injectOuo};
    if (!injectOuo && /ouo\\.(io|press)/i.test(site)) {
      console.log('[pahe-auto] Userscript injection is disabled for ouo.io');
      return;
    }

    const o = window.location.origin;
    const adblockGateHosts = ${JSON.stringify(ADBLOCK_GATE_HOSTS)};
    const startTime = Date.now();

    try {
      window.canRunAds = true;
      window.isAdblock = false;
      window.adBlockDetected = false;
      window.fuckAdBlock = undefined;
      window.blockAdBlock = undefined;
      window.ab = false;
    } catch {}

    // Shadow-DOM-aware anti-adblock wall purge. removeAdOverlays/
    // removeClickDecoyOverlays below only ever see the light DOM — some
    // anti-adblock walls deliberately render their markup inside a shadow
    // root specifically to dodge that kind of querySelector-based removal
    // (a technique seen in community userscripts for this same ad-chain).
    // Patching attachShadow lets us inspect shadow content the moment it's
    // created and hide the host if it looks like one of these walls, before
    // it ever paints. Runs via addInitScript (browser.js), i.e. before the
    // page's own scripts, so this is installed ahead of any attachShadow
    // call the page could make. Deliberately does NOT walk up and hide
    // ancestor elements (unlike the reference implementation this was
    // adapted from) — the existing removeAdOverlays/removeClickDecoyOverlays
    // interval tick already clears the surrounding full-page backdrop
    // wrapper on its own terms, so limiting this patch to "stop the shadow
    // content from rendering" keeps the blast radius small.
    try {
      const nativeAttachShadow = Element.prototype.attachShadow;
      const isCaptchaHost = (el) => {
        try {
          const attrStr = ((el.className || '') + ' ' + (el.id || '')).toLowerCase();
          return attrStr.includes('captcha') || attrStr.includes('turnstile') || attrStr.includes('hcaptcha');
        } catch { return false; }
      };
      Element.prototype.attachShadow = function (...args) {
        const root = nativeAttachShadow.apply(this, args);
        const host = this;
        const inspect = () => {
          try {
            if (isCaptchaHost(host)) return;
            const html = (root.innerHTML || '').toLowerCase();
            if (
              html.includes('antiadblock') ||
              html.includes('disable your adblocker') ||
              html.includes('adblocker detected') ||
              html.includes('adblock detected') ||
              html.includes('please disable your ad')
            ) {
              console.log('[pahe-auto] Shadow-DOM anti-adblock wall detected — hiding host element');
              try { host.style.setProperty('display', 'none', 'important'); } catch {}
              try { document.body && document.body.style.setProperty('overflow', 'auto', 'important'); } catch {}
              try { document.documentElement && document.documentElement.style.setProperty('overflow', 'auto', 'important'); } catch {}
            }
          } catch {}
        };
        try {
          const obs = new MutationObserver(inspect);
          obs.observe(root, { childList: true, subtree: true });
        } catch {}
        setTimeout(inspect, 0);
        return root;
      };
      console.log('[pahe-auto] Shadow-DOM anti-adblock guard installed');
    } catch (err) {
      console.error('[pahe-auto] Failed to install shadow-DOM anti-adblock guard: ' + err.message);
    }

    // innerHTML anti-adblock guard — a second, distinct anti-adblock-wall
    // mechanism (confirmed in the same community reference implementation
    // as the #continue fix above) that injects the wall's markup via a
    // direct .innerHTML assignment rather than a shadow root. Drops any
    // write containing "antiadblock" before it ever reaches the DOM;
    // everything else passes through untouched. Installed once (module
    // singleton guard), unconditionally, since the check itself is cheap
    // and narrow.
    try {
      if (!window.__paheInnerHTMLGuardInstalled) {
        window.__paheInnerHTMLGuardInstalled = true;
        const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');
        if (descriptor && descriptor.set) {
          Object.defineProperty(Element.prototype, 'innerHTML', {
            configurable: true,
            enumerable: descriptor.enumerable,
            get: descriptor.get,
            set: function (v) {
              if (typeof v === 'string' && v.toLowerCase().includes('antiadblock')) {
                console.log('[pahe-auto] Blocked innerHTML write containing "antiadblock"');
                return;
              }
              return descriptor.set.call(this, v);
            },
          });
          console.log('[pahe-auto] innerHTML anti-adblock guard installed');
        }
      }
    } catch (err) {
      console.error('[pahe-auto] Failed to install innerHTML anti-adblock guard: ' + err.message);
    }

    console.log('[pahe-auto] Injected on ' + window.location.href);

    // Helpers
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

    // Confirmed live (srnky.com): a form with an <input>/<button> named
    // "submit" shadows HTMLFormElement's own .submit method with that
    // element instead — form.submit() then throws "form.submit is not a
    // function", silently, since every call site here was wrapped in a
    // try/catch that itself called the same broken form.submit() again.
    // The form never actually submitted; from the outside this looked
    // exactly like a captcha/verification failure and bounced back to the
    // shortener instead. HTMLFormElement.prototype.submit.call(form) always
    // calls the real native method regardless of what's shadowing it.
    function safeFormSubmit(form) {
      try {
        HTMLFormElement.prototype.submit.call(form);
      } catch (err) {
        console.error('[pahe-auto] safeFormSubmit failed: ' + err.message);
      }
    }

    function formSubmit(form) {
      try {
        const submitBtn = form.querySelector('[type="submit"], button:not([type])');
        if (submitBtn) {
          submitBtn.removeAttribute('disabled');
          submitBtn.click();
          // Fallback: submit form directly after 100ms
          setTimeout(() => safeFormSubmit(form), 100);
        } else {
          safeFormSubmit(form);
        }
      } catch {
        safeFormSubmit(form);
      }
    }

    function clearOnclickAds() {
      try {
        document.querySelectorAll('*[onclick*="window.open"]').forEach((n) => n.removeAttribute('onclick'));
        document.querySelectorAll('*[href*="https:///"]').forEach((n) => n.removeAttribute('href'));
      } catch {}
    }

    // Ad-network "click decoy": a div, position:fixed, absurdly high z-index
    // (2147483647 = INT32_MAX — real UI essentially never hardcodes the
    // literal 32-bit signed max), sized and positioned to sit exactly on top
    // of a real interactive element (a button, or a 3rd-party captcha
    // checkbox iframe) so clicks land on the decoy instead — for ad revenue
    // and/or to make the real element look "unclickable". Confirmed live on
    // intercelestial.com (over the "Continue" button) and pahe.plus (over
    // the hCaptcha checkbox iframe). Re-inserted on an interval by the
    // page's own script (sometimes with a randomized data-* attribute or
    // placeholder content to dodge an "empty div" filter — seen live), so
    // this only keys on position+z-index, not emptiness, and instead
    // excludes anything that could plausibly be real UI: containing an
    // iframe (the decoy sits ON TOP of the real iframe, never wraps it) or
    // mentioning captcha/turnstile in its own attributes.
    function removeClickDecoyOverlays() {
      try {
        // Confirmed live via a real (non-automated) browser session on
        // srnky.com: document.elementFromPoint() at the "Continue" button's
        // own coordinates resolved to a decoy <div> with the same INT32_MAX
        // z-index signature, but position:absolute, not fixed — covering
        // the full document (0,0 to the page's full scroll height), not
        // just the viewport. position !== 'fixed' alone missed this
        // entirely. The z-index threshold here (>2 billion) is so far past
        // anything legitimate UI ever uses that broadening to absolute
        // doesn't meaningfully risk false positives.
        document.querySelectorAll('div').forEach((el) => {
          try {
            const style = window.getComputedStyle(el);
            if (style.position !== 'fixed' && style.position !== 'absolute') return;
            // parseInt('auto', 10) (a normal, legitimate default z-index)
            // is NaN, and NaN <= N is always false — a plain <= skip-check
            // alone silently treats "not a number" as "not too low" and
            // lets it through. isNaN() has to be checked explicitly, not
            // folded into the comparison.
            const z = parseInt(style.zIndex, 10);
            if (isNaN(z) || z <= 2000000000) return;
            if (el.querySelector('iframe')) return;
            const attrStr = ((el.className || '') + ' ' + (el.id || '')).toLowerCase();
            if (attrStr.includes('captcha') || attrStr.includes('turnstile')) return;
            el.remove();
          } catch {}
        });
        // Same decoy signature (fixed or absolute, INT32_MAX z-index,
        // full-page) but as a bare <iframe> sitting directly on <html>
        // instead of a div — confirmed live on srnky.com/clksz.com: a
        // src-less iframe at z-index 2147483647 covers the whole page and
        // intercepts every click, including on the real #continue button
        // underneath it (which is why it kept staying disabled/unclicked no
        // matter how long automation waited). A real captcha iframe
        // (hCaptcha/reCAPTCHA/Turnstile) always has a src pointing at the
        // provider's own domain — this decoy never does, which is what
        // tells them apart here instead of the class/id-based exclusion
        // used above.
        document.querySelectorAll('iframe').forEach((el) => {
          try {
            const style = window.getComputedStyle(el);
            if (style.position !== 'fixed' && style.position !== 'absolute') return;
            const z = parseInt(style.zIndex, 10); // see the div loop above for why isNaN must be explicit
            if (isNaN(z) || z <= 2000000000) return;
            if (el.getAttribute('src')) return;
            // Confirmed live: Cloudflare Turnstile's own legitimate
            // bootstrap iframe (invisible-mode) is also a src-less,
            // position:absolute iframe — but it's 0x0 (z-index: auto, so
            // the isNaN check above already excludes it in practice; this
            // is a second, independent guard so a decoy that happens to
            // share a real numeric z-index near this range still can't
            // delete something that isn't actually covering the page).
            const rect = el.getBoundingClientRect();
            if (rect.width < 50 || rect.height < 50) return;
            console.log('[pahe-auto] Removed full-page click-decoy iframe (src-less, z-index ' + style.zIndex + ')');
            el.remove();
          } catch {}
        });
      } catch {}
    }

    function removeAdOverlays() {
      try {
        const elements = document.querySelectorAll('div, a, span');
        elements.forEach((el) => {
          try {
            const attrStr = ((el.className || '') + ' ' + (el.id || '') + ' ' + (el.getAttribute('style') || '')).toLowerCase();
            
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

    // Rules loaded from separate files
    const DOMAIN_RULES = {
      'teknoasian.com': (${teknoasianRule}),
      'pahe.plus': (${paheRule}),
      'old.pahe.plus': (${paheRule}),
      'ouo.io': (${ouoRule}),
      'ouo.press': (${ouoRule}),
      'oii.la': (${oiilaRule}),
      'tpi.li': (${oiilaRule}),
      'clksz.com': (${oiilaRule}),
      'srnky.com': (${oiilaRule})
    };

    const getActiveRule = () => {
      for (const key of Object.keys(DOMAIN_RULES)) {
        if (site.includes(key)) return DOMAIN_RULES[key];
      }
      return (${fallbackRule});
    };

    const activeRule = getActiveRule();

    // Speedup
    const userExclusions = window.__paheSpeedUpExclusions || [];
    const activeSpeedUp = activeRule.speedup;
    const speedUpPaheSetting = ${speedUpPahe};
    const isPaheDomain = /pahe\\.plus|old\\.pahe\\.plus/i.test(site);
    const needsTimerOverride = activeSpeedUp || (isPaheDomain && speedUpPaheSetting);
    
    if (needsTimerOverride) {
      try {
        const oT = window.setTimeout.bind(window);
        const oI = window.setInterval.bind(window);
        
        window.setTimeout = (cb, d, ...a) => {
          let divisor = 1;
          const excluded = userExclusions.some(s => site.includes(s));
          const stack = new Error().stack || '';
          const isVerificationCaller = stack.includes('hcaptcha') || 
                                       stack.includes('recaptcha') || 
                                       stack.includes('turnstile') || 
                                       stack.includes('cloudflare');
          if ((activeSpeedUp && !excluded && !isVerificationCaller) || (isPaheDomain && speedUpPaheSetting && !isVerificationCaller)) {
            divisor = 50;
          }

          if (divisor > 1) {
            const wrappedCb = () => {
              if (document.readyState === 'loading') {
                document.addEventListener('DOMContentLoaded', () => {
                  try { cb(...a); } catch {}
                }, { once: true });
              } else {
                try { cb(...a); } catch {}
              }
            };
            return oT(wrappedCb, (d || 0) / divisor);
          }
          return oT(cb, d, ...a);
        };
        
        window.setInterval = (cb, d, ...a) => {
          let divisor = 1;
          const excluded = userExclusions.some(s => site.includes(s));
          const stack = new Error().stack || '';
          const isVerificationCaller = stack.includes('hcaptcha') || 
                                       stack.includes('recaptcha') || 
                                       stack.includes('turnstile') || 
                                       stack.includes('cloudflare');
          if ((activeSpeedUp && !excluded && !isVerificationCaller) || (isPaheDomain && speedUpPaheSetting && !isVerificationCaller)) {
            divisor = 50;
          }

          if (divisor > 1) {
            const wrappedCb = () => {
              if (document.readyState === 'loading') return;
              try { cb(...a); } catch {}
            };
            return oI(wrappedCb, (d || 0) / divisor);
          }
          return oI(cb, d, ...a);
        };
        console.log('[pahe-auto] Dynamic timer speedup interceptors installed');
      } catch (err) {
        console.error('[pahe-auto] Failed to install speedup: ' + err.message);
      }
    }

    try { rawSetInterval(removeClickDecoyOverlays, 100); } catch {}
    removeClickDecoyOverlays();

    const tick = () => {
      if (activeRule.cleanOverlays) removeAdOverlays();

      const isStealthDomain = /pahe\\.plus|old\\.pahe\\.plus|ouo\\.(io|press)/i.test(site);
      const hasGetLink = document.querySelector('a.get-link, a.btn-success, .get-link a');
      if (
        isStealthDomain &&
        !hasGetLink &&
        (document.querySelector('input[name="action"][value="captcha"]') ||
         document.querySelector('.h-captcha, .g-recaptcha, #captchaShortlink, #captcha, #recaptcha, .cf-turnstile') ||
         window.hcaptcha || window.grecaptcha || window.turnstile) &&
        !isCaptchaSolved()
      ) {
        return;
      }

      const delayMs = window.__paheDelayMs || 1500;
      const skipDelay = !!hasGetLink;
      if (!skipDelay && (Date.now() - startTime < delayMs)) return;

      clearOnclickAds();
      activeRule.run();
    };

    try { setInterval(tick, 500); } catch {}
    if (document.readyState !== 'loading') tick();
    document.addEventListener('readystatechange', tick);
    document.addEventListener('DOMContentLoaded', tick);
  })();
`;
}
