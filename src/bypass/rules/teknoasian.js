{
  speedup: true,
  cleanOverlays: true,
  run: function() {
    if (document.readyState !== 'complete' && document.readyState !== 'interactive') return;
    try {
      // window.LLPayload (handled generically in the tick() loop, before
      // activeRule.run() is even called) now covers teknoasian.com's ad-gate
      // — see submitLLPayload() in userscript.js. What's left below is the
      // OLD pre-"LL template" markup, kept as a fallback for if that ever
      // reappears. NOTE: on the current template, `.humanVerify .verify`,
      // `.Skipper .skipcontent` and `.postnext` are a HIDDEN honeypot that
      // POSTs to /?ll_action=bot_ban — confirmed live on intercelestial.com
      // (same template). The visibility check below keeps this fallback from
      // walking into that trap: the honeypot copy is off-screen/invisible,
      // the real (old-template) buttons are not.
      const isReallyVisible = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return false;
        const style = window.getComputedStyle(el);
        if (style.opacity === '0' || style.visibility === 'hidden' || style.display === 'none') return false;
        if (r.left < -1000 || r.top < -1000) return false;
        return true;
      };

      const verify = document.querySelector('.humanVerify .verify');
      if (verify && isReallyVisible(verify) && window.__t1 !== true) {
        window.__t1 = true;
        console.log('[pahe-auto] [teknoasian] Clicking .humanVerify .verify');
        verify.scrollIntoView({ block: 'center' });
        verify.click();
      }
      const skip = document.querySelector('.Skipper > .skipcontent');
      if (skip && isReallyVisible(skip) && window.__t2 !== true) {
        window.__t2 = true;
        console.log('[pahe-auto] [teknoasian] Skipper button found. Clicking skip in 200ms.');
        setTimeout(() => skip.click(), 200);
      }
      const postnext = document.querySelector('.postnext');
      if (postnext && isReallyVisible(postnext) && window.__t3 !== true) {
        window.__t3 = true;
        const form = postnext.closest('form');
        if (form) {
          console.log('[pahe-auto] [teknoasian] Submitting Skipper form in 150ms.');
          setTimeout(() => form.submit(), 150);
        }
      }
    } catch (err) {
      console.error('[pahe-auto] Error in teknoasian handler: ' + err.message);
    }
  }
}
