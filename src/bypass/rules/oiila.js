{
  speedup: false, // Server requires real wall-clock countdown time for /links/go validation
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

      // Helper to read current timer countdown value if present
      const getTimerValue = () => {
        const timerEl = document.querySelector('#timer, #counter, #countdown, .timer, .countdown, [id*="timer"], [class*="timer"]');
        if (!timerEl) return 0;
        const txt = (timerEl.textContent || '').trim();
        const num = parseInt(txt, 10);
        return isNaN(num) ? 0 : num;
      };

      // 2. Un-hide Get Link button (KEEP ONCLICK INTACT so AJAX token handler works)
      try {
        document.querySelectorAll('a.get-link, .get-link, #get-link a').forEach((el) => {
          if (el.style.display === 'none') el.style.display = 'inline-block';
          if (el.style.visibility === 'hidden') el.style.visibility = 'visible';
          if (el.style.opacity === '0') el.style.opacity = '1';
        });
      } catch {}

      // 3. Step 2 (Countdown Page & Get Link)
      const getLinkBtn = document.querySelector('a.get-link, .get-link, #get-link a');
      if (getLinkBtn) {
        const rawHref = getLinkBtn.href || getLinkBtn.getAttribute('href') || getLinkBtn.getAttribute('data-href') || '';
        const isExternalTarget = /^https?:\/\//i.test(rawHref) &&
                                 !rawHref.includes('oii.la') &&
                                 !rawHref.includes('tpi.li') &&
                                 !rawHref.includes('/links/go');

        // If the button ALREADY points directly to GDFlix / external URL, redirect immediately
        if (isExternalTarget && !window.__done) {
          window.__done = true;
          console.log('[pahe-auto] [oii.la] Direct external GDFlix link ready. Redirecting to: ' + rawHref);
          window.location.assign(rawHref);
          return;
        }

        // If link points to /links/go or # or internal URL, MUST WAIT FOR 10-SECOND TIMER TO COMPLETE
        const secondsRemaining = getTimerValue();
        const elapsedMs = Date.now() - startTime;
        const isCountdownFinished = (secondsRemaining <= 0) && (elapsedMs >= 10000);

        if (isCountdownFinished && !window.__clickedGetLink && !window.__done) {
          window.__clickedGetLink = true;
          console.log('[pahe-auto] [oii.la] 10s countdown completed (' + elapsedMs + 'ms elapsed). Triggering Get Link...');

          // Check if rawHref updated to external target right as timer finished
          const updatedHref = getLinkBtn.href || getLinkBtn.getAttribute('href') || '';
          if (/^https?:\/\//i.test(updatedHref) && !updatedHref.includes('oii.la') && !updatedHref.includes('/links/go')) {
            window.__done = true;
            console.log('[pahe-auto] [oii.la] External link updated after timer: ' + updatedHref);
            window.location.assign(updatedHref);
            return;
          }

          // Otherwise submit form#go-link or click getLinkBtn with handler intact
          const goForm = document.querySelector('form#go-link, form[action*="links/go"]');
          if (goForm) {
            console.log('[pahe-auto] [oii.la] Submitting form#go-link');
            formSubmit(goForm);
          } else {
            console.log('[pahe-auto] [oii.la] Clicking getLinkBtn with handler intact');
            getLinkBtn.click();
          }
        }
        return; // Stop here on Step 2 (do not run Step 1 landing form logic)
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
