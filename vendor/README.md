# vendor / third-party reference

## Bypass Pahe Links (userscript)

The ad-chain automation in [`src/bypass/userscript.js`](../src/bypass/userscript.js)
is a headless-automation **port** of the *Bypass Pahe Links* Violentmonkey
userscript.

- **Author:** NaeemBolchhi
- **License:** GPL-3.0-or-later
- **Source / updates:** https://greasyfork.org/scripts/443277
- **Homepage:** https://naeembolchhi.github.io/

The original script relies on injected CSS to bring hidden buttons to the
foreground so a **human** can tap them, and auto-clicks a few known gates. Our
port keeps the per-host click/redirect logic (`clickLinks`, `blogmysttAuto`,
`teknoasianAuto`, `pullButton`, `clearOnclickAds`) but drops the human-facing CSS
because the flow runs unattended in Playwright.

If a host's flow changes, update the matching function in
`src/bypass/userscript.js`; cross-check behavior against the upstream script.

The `@match` host list from the original is preserved as `AD_HOSTS` in that file
and as `SHORTENER_HOSTS` in the parser.

## FlareSolverr & ByParr

FlareSolverr and ByParr are third-party proxy-based solutions used to bypass Cloudflare Turnstile, challenge pages, and other bot detection systems.

- **FlareSolverr**: A proxy server to bypass Cloudflare protection. It uses Selenium with Chrome.
  - **Docker Image**: `flaresolverr/flaresolverr:latest`
  - **Default Port**: `8191`
- **ByParr**: An anti-detection bypass proxy acting as a drop-in replacement for FlareSolverr. It uses FastAPI and Firefox (Camoufox/nodriver).
  - **Docker Image**: `ghcr.io/thephaseless/byparr:latest`
  - **Default Port**: `8192` (mapped internally to `8191` to run side-by-side with FlareSolverr)

Both services are spawned automatically via Docker when starting the application with `npm start`, provided Docker is running on the host system. They can be selected as the active CAPTCHA/Cloudflare bypass provider in the GUI Settings panel.

> ⚠️ **Important limitation — ouo.io.** FlareSolverr and ByParr solve Cloudflare's
> **full-page "Under Attack" / IUAM interstitial** and return `cf_clearance`
> cookies. They do **not** solve an **in-form Turnstile widget** — which is
> exactly what ouo.io's page 1 (`#form-captcha`) uses. Its `cf-turnstile-response`
> token must be freshly minted client-side, and a cookie can't do that. So for
> ouo.io, use one of:
>
> 1. **Stealth auto-pass** — the `patchright` engine + real Chrome (`channel: chrome`)
>    often makes Turnstile issue the token on its own (provider `none`).
> 2. **Manual** — headful window, solve the checkbox yourself.
> 3. **A Turnstile-capable solver** — `2captcha` or `capsolver` (submits
>    sitekey + action, injects the token, the ouo rule then submits the form).
>
> See `src/bypass/browser.js` (engine), `resolveHeadless()` in
> `src/bypass/index.js` (mode coupling), and `src/bypass/captcha/turnstileInject.js`.

## Stealth engine (patchright)

The browser is driven by **patchright**, a drop-in undetected Playwright fork
that closes the `Runtime.enable` CDP leak Cloudflare uses to fingerprint
Playwright. It runs the user's real **Chrome** via `channel: "chrome"`. Configure
via `bypass.stealth.engine` (`patchright` | `playwright`) and
`bypass.stealth.chromeChannel` (`chrome` | `chromium`). Falls back to bundled
Chromium automatically if Chrome isn't installed.

