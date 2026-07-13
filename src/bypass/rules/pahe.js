{
  speedup: false,
  cleanOverlays: true,
  run: function() {
    try {
      // Step 2: countdown / submit form via AJAX
      const goForm = document.getElementById('go-link');
      const formDataInput = document.querySelector('input[name="ad_form_data"]');
      const csrfInput = document.querySelector('input[name="_csrfToken"]');
      
      if (document.readyState === 'complete' && goForm && formDataInput && formDataInput.value && csrfInput && csrfInput.value && !window.__paheDone) {
        window.__paheDone = true;
        console.log('[pahe-auto] [pahe.plus] Step 2 detected. Initiating AJAX POST bypass...');
        
        const params = new URLSearchParams();
        for (const [key, val] of new FormData(goForm).entries()) {
          params.append(key, val);
        }
        
        const url = goForm.getAttribute('action') || '/links/go';
        
        fetch(url, {
          method: 'POST',
          body: params,
          headers: {
            'X-Requested-With': 'XMLHttpRequest',
            'Accept': 'application/json, text/javascript, */*; q=0.01'
          }
        })
        .then(res => res.json())
        .then(data => {
          if (data && data.url) {
            console.log('[pahe-auto] [pahe.plus] AJAX bypass success! Destination: ' + data.url);
            window.location.href = data.url;
          } else {
            console.error('[pahe-auto] [pahe.plus] AJAX bypass failed: ', data);
            window.__paheDone = false; // allow retry
          }
        })
        .catch(err => {
          console.error('[pahe-auto] [pahe.plus] AJAX bypass error: ' + err.message);
          window.__paheDone = false; // allow retry
        });
        return;
      }

      // Fallback: Find the get-link anchor (if already generated or direct)
      const getLinkBtn = document.querySelector('a.get-link, a.btn-success, .get-link a');
      if (getLinkBtn) {
        const href = getLinkBtn.getAttribute('href');
        if (href && (href.startsWith('http://') || href.startsWith('https://')) && !href.includes(window.location.hostname)) {
          console.log('[pahe-auto] [pahe.plus] Found destination link: ' + href + '. Redirecting directly!');
          window.location.href = href;
        }
      }
    } catch (err) {
      console.error('[pahe-auto] [pahe.plus] Error in pahe.plus handler: ' + err.message);
    }
  }
}
