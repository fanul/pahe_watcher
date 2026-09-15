{
  speedup: true,
  cleanOverlays: true,
  run: function() {
    try {
      // 1. oii.la / tpi.li
      if (/oii\.la|tpi\.li/.test(o)) {
        try {
          // Neutralize Anti-Adblock flags & modals (e.g. FuckAdBlock, SweetAlert, adblock killer overlays)
          window.fuckAdBlock = undefined;
          window.blockAdBlock = undefined;
          window.canRunAds = true;
          document.querySelectorAll('.swal2-container, .swal-overlay, #adb-modal, div[id*="adblock"], div[class*="adblock"], div[style*="z-index"][style*="fixed"]').forEach((el) => {
            if (!el.querySelector('.cf-turnstile, iframe[src*="turnstile"]')) {
              el.remove();
            }
          });
          if (document.body) {
            document.body.classList.remove('swal2-shown', 'swal2-height-auto', 'modal-open');
            document.body.style.overflow = 'auto';
          }
        } catch {}

        pullButton();

        // Step A: First page landing form with "Continue" or "Submit" button
        const landingForm = document.querySelector('form:not(.td-search-form):not(.go-link)');
        if (landingForm && !window.__formDone) {
          const btn = landingForm.querySelector('button, input[type="submit"]');
          if (btn) {
            window.__formDone = true;
            btn.removeAttribute('disabled');
            console.log('[pahe-auto] Clicking oii.la Continue button');
            btn.click();
          }
        }

        // Step B: Final get-link button redirect
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

      // 3. linegee.net — handles both script-based atob navigation and direct Continue buttons/forms
      if (/linegee\.net/.test(o)) {
        // Option A: Script-extracted atob query string navigation
        if (document.readyState === 'complete') {
          document.querySelectorAll('script').forEach((s) => {
            if (/location\.href.*atob/.test(s.textContent) && !window.__done) {
              const b64 = s.textContent.replace(/[\t\s]/g, '').replace(/^.*location.href.*atob\('(.*)'\).*/, '$1');
              window.__done = true;
              console.log('[pahe-auto] [linegee.net] Found atob redirect token. Navigating in 5s...');
              setTimeout(() => { window.location.href = window.location.href + atob(b64); }, 5000);
            }
          });
        }

        // Option B: Continue button / form click
        if (!window.__done) {
          const btn = document.querySelector('a.get-link:not(.disabled), a.btn-success[href], button#btn-main, form#go-link button, .btn-captcha');
          if (btn) {
            const rawHref = btn.href || btn.getAttribute('href');
            if (rawHref && /^https?:\/\//i.test(rawHref) && !rawHref.includes('linegee.net')) {
              window.__done = true;
              console.log('[pahe-auto] [linegee.net] Direct external Continue link ready: ' + rawHref);
              window.location.assign(rawHref);
            } else if (!window.__clickedLinegee) {
              window.__clickedLinegee = true;
              console.log('[pahe-auto] [linegee.net] Clicking Continue button');
              btn.removeAttribute('disabled');
              btn.click();
            }
          }
        }
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

      // 5. blogmystt.com and its white-labeled lookalike domains (same
      // "startButton/getnewlink" ad-gate template, just rotated to dodge
      // adblock host-lists — see ADBLOCK_GATE_HOSTS in userscript.js).
      if (/blogmystt\.com/.test(o) || adblockGateHosts.some((h) => o.includes(h))) {
        try {
          // The "myButton" ad-gate template (Click To Verify -> Continue ->
          // Get Link) replaces the DOM with a NEW .myButton element (random
          // class suffix) at each stage. A one-shot page-global flag only
          // ever clicks the first one it sees, so mark each button element
          // individually instead — otherwise the flow stalls after stage 1
          // and needs a manual click for "Continue".
          //
          // intercelestial.com/teknoasian.com are skipped here entirely:
          // that variant of the template checks event.isTrusted, and a
          // script-dispatched click here can never satisfy that — confirmed
          // live to trigger the "auto-click script detected" wall even when
          // it's the only synthetic click in an otherwise-real-clicked
          // sequence. bypass/index.js drives those two with real Playwright
          // clicks instead (see the LL ad-gate handling there); clicking
          // here too would race it and double-submit.
          if (!/intercelestial\.com|teknoasian\.com/.test(o)) {
            document.querySelectorAll('.myButton:not(.saynotoads)').forEach((btn) => {
              if (btn.dataset.paheClicked) return;
              btn.dataset.paheClicked = '1';
              console.log('[pahe-auto] Clicking .myButton: ' + btn.textContent.trim());
              btn.click();
            });
          }
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
