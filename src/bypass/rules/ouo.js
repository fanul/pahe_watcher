{
  speedup: false,
  cleanOverlays: true,
  run: function() {
    try {
      const goForm = document.getElementById('go-link');
      if (goForm && !window.__done) {
        window.__done = true;
        console.log('[pahe-auto] [ouo.io] Page 2 detected. Submitting countdown form: #go-link');
        formSubmit(goForm);
        return;
      }
      const captchaForm = document.getElementById('form-captcha');
      if (captchaForm && !window.__done) {
        const cfres = document.querySelector('[name="cf-turnstile-response"]');
        if (cfres && cfres.value) {
          window.__done = true;
          console.log('[pahe-auto] [ouo.io] Page 1 solved. Submitting form: #form-captcha');
          formSubmit(captchaForm);
        }
      }
    } catch (err) {
      console.error('[pahe-auto] Error in ouo.io handler: ' + err.message);
    }
  }
}
