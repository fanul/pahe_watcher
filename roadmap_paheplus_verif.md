# Roadmap: pahe.plus auto-continue after hCaptcha

## Current state (as of this session)

`https://pahe.plus/4ND0`-style shortlink pages now gate behind a real hCaptcha
(`#invisibleCaptchaShortlink`, see [pahe.js](src/bypass/rules/pahe.js)). The
checkbox itself was unclickable — a regenerating ad-network decoy overlay
(`position:fixed; z-index:2147483647`, empty div) sat exactly on top of the
hCaptcha iframe, eating every click (manual and automated alike). That part is
now fixed: `removeClickDecoyOverlays()` in
[userscript.js](src/bypass/userscript.js) strips it on a 100ms interval.

**What's still manual**: previously, once the hCaptcha was solved, the app
auto-clicked through to the final download link with no further interaction.
Right now the user still has to click through one or more "download" buttons
by hand after solving the captcha before reaching the next hop (confirmed
live: solving the captcha landed on a page requiring manual clicks, which
eventually reached ouo.io).

## Why (not yet root-caused)

Not yet investigated in depth. Working theory: `pahe.js`'s post-captcha
selectors (`a.get-link, a.btn-success, .get-link a` and the AJAX POST to
`#go-link` / `input[name="ad_form_data"]`) no longer match the current page's
DOM — the page structure downstream of the captcha may have changed the same
way teknoasian.com/intercelestial.com's ad-gate changed (see the "LL"
template work earlier in this session), or introduced its own new
intermediate step(s) that `pahe.js` doesn't know about yet.

## Next steps

1. After solving the hCaptcha once (manually), capture the resulting page's
   actual DOM (button ids/classes, whether it's the old `a.get-link` pattern,
   an AJAX form, or a new template) instead of guessing from the old
   selectors.
2. Update the `run()` logic in [pahe.js](src/bypass/rules/pahe.js) to match
   whatever's actually there now, following the same live-verify-before-code
   approach used for the intercelestial.com "LL" template fix.
3. Re-test end-to-end: hCaptcha solved manually → confirm the rest of the
   chain (down to GDFlix/Drive) now auto-advances with no further clicks.

Deferred for now — current behavior (manual captcha + a few manual button
clicks) is usable, just not as automated as before.
