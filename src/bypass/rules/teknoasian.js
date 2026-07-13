{
  speedup: true,
  cleanOverlays: true,
  run: function() {
    if (document.readyState !== 'complete' && document.readyState !== 'interactive') return;
    try {
      const verify = document.querySelector('.humanVerify .verify');
      if (verify && window.__t1 !== true) {
        window.__t1 = true;
        console.log('[pahe-auto] [teknoasian] Clicking .humanVerify .verify');
        verify.scrollIntoView({ block: 'center' });
        verify.click();
      }
      const skip = document.querySelector('.Skipper > .skipcontent');
      if (skip && window.__t2 !== true) {
        window.__t2 = true;
        console.log('[pahe-auto] [teknoasian] Skipper button found. Clicking skip in 200ms.');
        setTimeout(() => skip.click(), 200);
      }
      const postnext = document.querySelector('.postnext');
      if (postnext && window.__t3 !== true) {
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
