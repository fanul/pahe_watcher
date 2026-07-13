# Pahe Watcher — Milestone Journey

This document captures the milestones, accomplishments, and current challenges faced during the development of Pahe Watcher.

## Completed Milestones

### 1. Configuration & Google Sheets Integration
- Developed a web-driven settings panel in the Web GUI.
- Added support for filling/editing the Google Sheets Service Account JSON key content directly via Web GUI and storing it safely.
- Added spreadsheet ID and sheet tab parameters.

### 2. Comprehensive Queue Control & Web GUI Improvements
- Added inline **Retry Failed** and **Clear All** controls in the Web GUI Jobs panel.
- Added individual **Delete** controls for finished, failed, or cancelled jobs.
- Implemented manual link submission form allowing direct input of shortened URLs (pahe.plus, GDFlix, etc.) into the queue.

### 3. Configurable Browser Context & Automation Delay
- Created custom `bypass.initialPageDelaySeconds` to delay userscript execution during page load settling.
- Provided real-time adjustment of initial delay via Settings.
- Added page close hooks to instantly fail/retry jobs if Chromium is closed.

### 4. Advanced Captcha Stealth Configuration Checklist
- Designed 6 interactive stealth toggles in Web GUI:
  - **Disable Automation Flag**: Removes `--enable-automation` to prevent automated browser banners.
  - **Use Stealth User-Agent**: Spoofs browser context as Windows 10 Chrome.
  - **Mask Webdriver**: Intercepts and overrides `navigator.webdriver` on all frames/pages.
  - **Block Ads/Trackers**: Prevents loading of heavy click-jacking script networks (aborting non-document requests).
  - **Spoof Canvas Fingerprints**: Introduces minor noise to canvas image data reads.
  - **Disable Sandbox**: Controls `--no-sandbox` command-line flag.

### 5. Multi-Tab Context Tracking
- Rewrote the resolver to listen to the browser context `'page'` event.
- Tracks and hooks navigation listeners on any new tab, popup, or window opened in the session.
- Runs captcha solvers and monitors redirects on the active tab, closing obsolete tabs automatically upon completion.

---

## Current Challenge: Bypassing `ouo.io`

While we have made massive strides in multi-tab tracking, ad overlay removal, and Turnstile speedup fixes, we are **still stumbling on the `ouo.io` bypass**:
- **Fake Captcha Ads**: `ouo.io` aggressively embeds fake floating captcha frames inside iframes using `srcdoc` to hijack clicks. We have written a DOM cleanup parser to target and delete them.
- **Turnstile Captcha Verification**: On Page 1, it requires solving a Cloudflare Turnstile verification. If Turnstile is solved, the userscript automatically submits the form.
- **Redirection Chain Tab Issues**: Clicking submit on `pahe.plus` opens `ouo.io` in a new tab, which sometimes fails to propagate correctly under automation or triggers browser security errors. We are refining the automatic page/tab focus and Turnstile state mapping.
