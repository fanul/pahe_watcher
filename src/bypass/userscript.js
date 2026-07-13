import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Read the separate rule files
const teknoasianRule = fs.readFileSync(path.join(__dirname, 'rules/teknoasian.js'), 'utf8');
const paheRule = fs.readFileSync(path.join(__dirname, 'rules/pahe.js'), 'utf8');
const ouoRule = fs.readFileSync(path.join(__dirname, 'rules/ouo.js'), 'utf8');
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

    const site = window.location.hostname.replace(/^www\\./, '');

    // Check if ouo injection is disabled
    const injectOuo = ${injectOuo};
    if (!injectOuo && /ouo\\.(io|press)/i.test(site)) {
      console.log('[pahe-auto] Userscript injection is disabled for ouo.io');
      return;
    }

    const removeOuoAdsSetting = ${removeOuoAds};

    const o = window.location.origin;
    const startTime = Date.now();

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

    function formSubmit(form) {
      try {
        const submitBtn = form.querySelector('[type="submit"], button:not([type])');
        if (submitBtn) {
          submitBtn.removeAttribute('disabled');
          submitBtn.click();
          // Fallback: submit form directly after 100ms
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
      'ouo.press': (${ouoRule})
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
          if (activeSpeedUp && !excluded) {
            divisor = 50;
          } else if (isPaheDomain && speedUpPaheSetting) {
            const hasReadyText = document.body && (
              document.body.innerText.includes('almost ready') || 
              document.body.innerText.includes('almost') || 
              document.body.innerText.includes('ready')
            );
            if (isCaptchaSolved() || hasReadyText) {
              divisor = 50;
            }
          }
          return oT(cb, (d || 0) / divisor, ...a);
        };
        
        window.setInterval = (cb, d, ...a) => {
          let divisor = 1;
          const excluded = userExclusions.some(s => site.includes(s));
          if (activeSpeedUp && !excluded) {
            divisor = 50;
          } else if (isPaheDomain && speedUpPaheSetting) {
            const hasReadyText = document.body && (
              document.body.innerText.includes('almost ready') || 
              document.body.innerText.includes('almost') || 
              document.body.innerText.includes('ready')
            );
            if (isCaptchaSolved() || hasReadyText) {
              divisor = 50;
            }
          }
          return oI(cb, (d || 0) / divisor, ...a);
        };
        console.log('[pahe-auto] Dynamic timer speedup interceptors installed');
      } catch (err) {
        console.error('[pahe-auto] Failed to install speedup: ' + err.message);
      }
    }

    const tick = () => {
      if (activeRule.cleanOverlays) removeAdOverlays();

      const isStealthDomain = /pahe\\.plus|old\\.pahe\\.plus|ouo\\.(io|press)/i.test(site);
      if (
        isStealthDomain &&
        (document.querySelector('input[name="action"][value="captcha"]') ||
         document.querySelector('.h-captcha, .g-recaptcha, #captchaShortlink, #captcha, #recaptcha, .cf-turnstile') ||
         window.hcaptcha || window.grecaptcha || window.turnstile) &&
        !isCaptchaSolved()
      ) {
        return;
      }

      const delayMs = window.__paheDelayMs || 1500;
      if (Date.now() - startTime < delayMs) return;

      clearOnclickAds();
      activeRule.run();
    };

    try { setInterval(tick, 30); } catch {}
    if (document.readyState !== 'loading') tick();
    document.addEventListener('readystatechange', tick);
    document.addEventListener('DOMContentLoaded', tick);
  })();
`;
}
