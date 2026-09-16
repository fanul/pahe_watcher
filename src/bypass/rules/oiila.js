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
        // Confirmed live (srnky.com/clksz.com) via a Node-side DOM dump: the
        // "verify" button here (#continue / .btn-captcha — the same
        // element) is gated by a REAL Cloudflare Turnstile challenge — a
        // hidden cf-turnstile-response/visit_token field that only gets a
        // value once Turnstile actually passes. While gated, its onclick is
        // `window.open(adUrl)` (an ad decoy, not the real action); the
        // onclick clears a few seconds in, but the button itself stays
        // disabled until Turnstile solves. Force-removing `disabled` and
        // clicking it — what this used to do — submits the form before that
        // token exists, which the server reads as a bot submission and
        // bounces the job through an ad-redirect chain (hai8g.com →
        // advertisingcamps.com → taboola.com) every time. There is no
        // click-based workaround for that (real OR synthetic click — a
        // click on a still-gated button is premature either way); only
        // waiting for it to become naturally enabled is safe, matching a
        // community reference implementation for this exact template.
        const continueBtn = document.querySelector('#continue:not([disabled]), button.btn-captcha:not([disabled])');
        if (continueBtn) {
          console.log('[pahe-auto] [oii.la] Clicking #continue');
          continueBtn.click();
          window.__clickedHuman = true;
          window.__humanClickedAt = Date.now();
          return;
        }
        // A verify-looking button exists but is still disabled — keep
        // waiting indefinitely (next 500ms tick), never force it.
        if (document.querySelector('#continue, button.btn-captcha')) return;

        // Some pages in this family gate the form behind a differently-
        // labeled verify button with no Turnstile-style token to wait for
        // at all — safe to click as soon as it's visible AND already
        // enabled on its own (never force-enable — see above for why
        // that's actively harmful, not just unnecessary, on this template).
        if (!window.__clickedHuman) {
          const buttons = document.querySelectorAll('button, input[type="button"], input[type="submit"]');
          for (const btn of buttons) {
            const text = (btn.textContent || btn.value || '').toLowerCase().trim();
            const cls = (btn.className || '').toLowerCase();
            const looksLikeVerify = text.includes('human') || text.includes('continue') || text.includes('verify') ||
                                     text.includes('not a robot') || cls.includes('captcha');
            // NOT offsetParent !== null — confirmed live that's unreliable
            // here: offsetParent reads null for position:fixed elements in
            // most browsers even when they're genuinely visible on screen,
            // and this exact class of "click to verify" widget commonly
            // uses fixed positioning. getBoundingClientRect + computed
            // style is what actually reflects whether it's on screen.
            const rect = btn.getBoundingClientRect();
            const style = window.getComputedStyle(btn);
            const isVisible = rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
            if (looksLikeVerify && isVisible && !btn.disabled) {
              console.log('[pahe-auto] [oii.la] Page 1: Clicking verification button: ' + text);
              btn.click();
              window.__clickedHuman = true;
              window.__humanClickedAt = Date.now();
              return;
            }
          }
          // Bug fixed live: setting __clickedHuman=true here unconditionally
          // (whether or not a button was actually found) meant that if the
          // button hadn't rendered yet on this tick, the click was silently
          // skipped forever and the very next check fell straight through
          // to submitting the form unclicked — every single time, since
          // __clickedHuman was already (wrongly) marked done. Retry finding
          // the button for a few ticks (runs every 500ms) before concluding
          // there's genuinely nothing to click (as opposed to "found but
          // disabled", handled by the early return above).
          window.__humanClickAttempts = (window.__humanClickAttempts || 0) + 1;
          if (window.__humanClickAttempts < 8) return;
          window.__clickedHuman = true; // gave up looking — proceed as if there's nothing to click
        }

        // Confirmed live: clicking the verify button and submitting on the
        // very next 500ms tick still got bounced — the click likely fires
        // an async verification call server-side that hadn't finished yet.
        // Give it real wall-clock time to land before ever submitting.
        const sinceClick = window.__humanClickedAt ? Date.now() - window.__humanClickedAt : Infinity;
        if (sinceClick < 2500) return;

        const isSolved = isCaptchaSolved();
        const hasCaptchaWidget = document.querySelector('.g-recaptcha, .h-captcha, .cf-turnstile, iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="turnstile"]');

        if (!hasCaptchaWidget || isSolved) {
          window.__done = true;
          console.log('[pahe-auto] [oii.la] Page 1 captcha solved or ready. Submitting form...');
          setTimeout(() => {
            formSubmit(captchaForm);
          }, 500);
        }
      }
    } catch (err) {
      console.error('[pahe-auto] Error in oii.la handler: ' + err.message);
    }
  }
}
