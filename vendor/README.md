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
