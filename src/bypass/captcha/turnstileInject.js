/**
 * Page-context function: inject a solved captcha token into the page and trigger
 * the site's callback so the guarded form becomes submittable.
 *
 * Passed to Playwright's page.evaluate(injectTurnstileToken, { token, kind }).
 * Must be self-contained (no outer references).
 *
 * For Cloudflare Turnstile (ouo.io) the important bits are:
 *   1) populate every `cf-turnstile-response` field (input OR textarea; create it
 *      inside the widget's form if the site hasn't rendered one yet), and
 *   2) fire the widget's `data-callback` if the site registered one, plus
 *      dispatch input/change events so any listeners react.
 */
export function injectTurnstileToken({ token, kind }) {
  const setField = (name, container = document) => {
    let els = container.querySelectorAll(`[name="${name}"]`);
    if (els.length === 0 && name === 'cf-turnstile-response') {
      // Some sites only create the hidden field after a real solve; make one.
      const widget = document.querySelector('.cf-turnstile') || document.querySelector('[data-sitekey]');
      const form = widget?.closest('form') || document.querySelector('form');
      if (form) {
        const inp = document.createElement('input');
        inp.type = 'hidden';
        inp.name = name;
        form.appendChild(inp);
        els = form.querySelectorAll(`[name="${name}"]`);
      }
    }
    els.forEach((el) => {
      el.value = token;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
  };

  try {
    if (kind === 'turnstile') {
      setField('cf-turnstile-response');
      setField('g-recaptcha-response'); // Turnstile compat mode sometimes uses this
      // Invoke the widget's registered callback, if any.
      const widget = document.querySelector('.cf-turnstile[data-callback], [data-callback]');
      const cbName = widget?.getAttribute('data-callback');
      if (cbName && typeof window[cbName] === 'function') {
        try { window[cbName](token); } catch {}
      }
    } else if (kind === 'hcaptcha') {
      setField('h-captcha-response');
      setField('g-recaptcha-response');
    } else {
      setField('g-recaptcha-response');
      // reCAPTCHA v2 callback discovery
      try {
        const cfg = window.___grecaptcha_cfg;
        if (cfg && cfg.clients) {
          Object.values(cfg.clients).forEach((client) => {
            Object.values(client).forEach((v) => {
              if (v && typeof v === 'object') {
                Object.values(v).forEach((inner) => {
                  if (inner && typeof inner.callback === 'function') {
                    try { inner.callback(token); } catch {}
                  }
                });
              }
            });
          });
        }
      } catch {}
    }
  } catch (e) {
    // best-effort; the site's poller may pick up the field value anyway
  }
}

export default injectTurnstileToken;
