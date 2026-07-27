{
  speedup: false, // Keep normal timer speeds for captcha and countdown sync
  cleanOverlays: true,
  run: function() {
    try {
      // 1. Neutralize Anti-Adblock flags & modals (FuckAdBlock, SweetAlert, etc)
      try {
        window.fuckAdBlock = undefined;
        window.blockAdBlock = undefined;
        window.canRunAds = true;
        window.isAdblock = false;
        window.adBlockDetected = false;
        window.ab = false;
        document.querySelectorAll('.swal2-container, .swal-overlay, #adb-modal, div[id*="adblock"], div[class*="adblock"]').forEach((el) => {
          if (!el.querySelector('.cf-turnstile, .g-recaptcha, .h-captcha, iframe[src*="turnstile"], iframe[src*="recaptcha"], iframe[src*="hcaptcha"]')) {
            el.remove();
          }
        });
        if (document.body) {
          document.body.classList.remove('swal2-shown', 'swal2-height-auto', 'modal-open');
          document.body.style.overflow = 'auto';
        }
      } catch {}

      // 2. Un-hide & enable any Get Link button / link
      try {
        document.querySelectorAll('a.get-link, .get-link, #get-link a').forEach((el) => {
          el.removeAttribute('disabled');
          el.removeAttribute('onclick');
          el.classList.remove('disabled');
          if (el.style.display === 'none') el.style.display = 'inline-block';
          if (el.style.visibility === 'hidden') el.style.visibility = 'visible';
          if (el.style.opacity === '0') el.style.opacity = '1';
        });
      } catch {}

      // 3. Step 2 (Get Link redirect)
      const getLinkBtn = document.querySelector('a.get-link, .get-link, #get-link a');
      if (getLinkBtn && !window.__done) {
        const rawHref = getLinkBtn.href || getLinkBtn.getAttribute('href') || getLinkBtn.getAttribute('data-href');
        if (rawHref && rawHref !== '#' && /^https?:\/\//i.test(rawHref)) {
          window.__done = true;
          console.log('[pahe-auto] [oii.la] Get Link detected. Redirecting to: ' + rawHref);
          window.location.assign(rawHref);
          return;
        }
      }

      // 4. Step 1 (Captcha / Landing form with "Continue")
      // Wait at least 2500ms for Cloudflare Turnstile / captcha iframe to render into the DOM
      if (Date.now() - startTime < 2500) {
        return;
      }

      const captchaForm = document.querySelector('form#form-continue, form#form-captcha, form:not(.td-search-form):not(.go-link)');
      if (captchaForm && !window.__done) {
        const isSolved = isCaptchaSolved();
        const hasCaptchaWidget = document.querySelector('.g-recaptcha, .h-captcha, .cf-turnstile, iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="turnstile"]');

        if (!hasCaptchaWidget || isSolved) {
          window.__done = true;
          console.log('[pahe-auto] [oii.la] Page 1 captcha solved or ready. Submitting form...');
          setTimeout(() => {
            formSubmit(captchaForm);
          }, 500);
        } else {
          // If captcha widget is present but not solved yet, click verification button ONCE
          if (!window.__clickedHuman) {
            const buttons = document.querySelectorAll('button, input[type="button"], input[type="submit"]');
            for (const btn of buttons) {
              const text = (btn.textContent || btn.value || '').toLowerCase().trim();
              if ((text.includes('human') || text.includes('continue') || text.includes('verify') || text.includes('not a robot')) &&
                  btn.offsetParent !== null && !btn.disabled) {
                window.__clickedHuman = true;
                console.log('[pahe-auto] [oii.la] Page 1: Clicking verification button: ' + text);
                btn.removeAttribute('disabled');
                btn.click();
                break;
              }
            }
          }
        }
      }
    } catch (err) {
      console.error('[pahe-auto] Error in oii.la handler: ' + err.message);
    }
  }
}
