{
  speedup: false, // Turnstile requires normal timer speed to prevent crashes
  cleanOverlays: true,
  run: function() {
    try {
      // Clean flying ads if enabled in settings
      if (typeof removeOuoAdsSetting !== 'undefined' && removeOuoAdsSetting) {
        document.querySelectorAll('div, a, iframe, span').forEach((el) => {
          if (el.closest('#form-captcha') || el.closest('#form-go')) return;
          const style = window.getComputedStyle(el);
          if (style.position === 'fixed' || style.position === 'absolute') {
            if (el.querySelector('.cf-turnstile') || el.classList.contains('cf-turnstile')) return;
            console.log('[pahe-auto] [ouo.io] Removed flying/floating ad element');
            el.style.display = 'none';
            el.remove();
          }
        });
      }

      // Page 2: countdown / redirect
      const goForm = document.getElementById('form-go');
      if (goForm && !window.__done) {
        window.__done = true;
        console.log('[pahe-auto] [ouo.io] Page 2 detected. Submitting countdown form: #form-go');
        formSubmit(goForm);
        return;
      }

      // Page 1: "I'm a human" with Turnstile
      const captchaForm = document.getElementById('form-captcha');
      if (captchaForm && !window.__done) {
        const cfres = document.querySelector('[name="cf-turnstile-response"]');
        if (cfres && cfres.value) {
          window.__done = true;
          console.log('[pahe-auto] [ouo.io] Page 1 solved. Waiting 1000ms for Cloudflare sync...');
          setTimeout(() => {
            console.log('[pahe-auto] [ouo.io] Submitting form: #form-captcha');
            formSubmit(captchaForm);
          }, 1000);
        } else {
          // Fallback: click human verification button if it needs manual click triggers
          const buttons = document.querySelectorAll('button, input[type="button"], input[type="submit"]');
          for (const btn of buttons) {
            const text = (btn.textContent || btn.value || '').toLowerCase().trim();
            if ((text.includes('human') || text.includes('verify') || text.includes('not a robot')) &&
                btn.offsetParent !== null && !btn.disabled && !window.__clickedHuman) {
              window.__clickedHuman = true;
              console.log('[pahe-auto] [ouo.io] Page 1: Clicking human verification button: ' + text);
              btn.click();
              break;
            }
          }
        }
      }
    } catch (err) {
      console.error('[pahe-auto] Error in ouo.io handler: ' + err.message);
    }
  }
}
