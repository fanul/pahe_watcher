{
  speedup: true,
  cleanOverlays: true,
  run: function() {
    try {
      // 1. oii.la / tpi.li
      if (/oii\.la|tpi\.li/.test(o)) {
        pullButton();
        const b = document.querySelector('.get-link:not(.disabled)');
        if (b && b.href && !window.__done) {
          window.__done = true;
          console.log('[pahe-auto] Redirecting to get-link: ' + b.href);
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
          console.log('[pahe-auto] Clicked #invisibleCaptchaShortlink on wordcounter.icu');
          c.click();
        }
        const g = document.querySelector('a.get-link[href]:not(.disabled)');
        if (g && !window.__d2) {
          window.__d2 = true;
          console.log('[pahe-auto] Redirecting to: ' + g.href + ' on wordcounter.icu');
          window.location.assign(g.href);
        }
      }

      // 5. blogmystt.com
      if (/blogmystt\.com/.test(o)) {
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
    } catch (err) {
      console.error('[pahe-auto] Error in fallback resolver: ' + err.message);
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
  }
}
