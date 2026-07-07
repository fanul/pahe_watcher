# 🎬 pahe-watcher

Automated watcher for **pahe.ink**. It detects new movie posts, walks the
ad-shortener → GDFlix chain that guards each download link, extracts the final
**Google Drive** (or pixeldrain/direct) link, and logs it to a **Google Sheet** —
all controlled from a **web GUI**.

It automates the manual routine you do today:

> open pahe.ink → spot a new release → find the **GD** link → get bounced through
> ad sites → bypass the shorteners → solve a captcha → land on GDFlix → copy the
> Google Drive link.

The ad-chain bypass is a headless-browser port of the *Bypass Pahe Links*
Violentmonkey userscript (by NaeemBolchhi, GPL-3.0), driven by Playwright.

---

## How it works (pipeline)

```
pahe.ink (WordPress REST API)
   │  watcher polls /wp-json/wp/v2/posts
   ▼
new post ──► parser extracts download options (provider × quality)
   │            e.g. GD 1080p → https://teknoasian.com/?ht=…
   ▼
job queue ──► bypass engine (Playwright + injected userscript)
   │            teknoasian → intercelestial/oii.la/blogmystt/… → GDFlix
   │            (captcha solved via manual GUI or 2captcha)
   ▼
final link (drive.google.com / pixeldrain) ──► Google Sheet
```

Everything is observable and controllable from the web GUI (live log, job
queue, manual captcha button, settings).

---

## Quick start

```bash
# 1) install dependencies
npm install

# 2) download the Chromium browser Playwright drives
npm run install:browser

# 3) configure
cp .env.example .env
#   edit .env: GOOGLE_SHEET_ID, service-account key path, preferences, etc.

# 4) run (watcher + web GUI)
npm start
#   open http://localhost:8787
```

Other run modes:

```bash
npm run server      # web GUI only, watcher not auto-started
npm run watch:once  # single poll, resolve, then exit (good for cron/CI)
```

---

## Google Sheets setup

1. Create a Google Cloud project and enable the **Google Sheets API**.
2. Create a **Service Account** and download its JSON key.
3. Save the key to `./credentials/google-service-account.json`
   (or point `GOOGLE_SERVICE_ACCOUNT_KEY` at it).
4. Create a Google Sheet, copy its **ID** from the URL into `GOOGLE_SHEET_ID`.
5. **Share the sheet** with the service-account email (the `client_email` in the
   JSON) as **Editor**.

The header row is written automatically on first append. Columns:

`Resolved At · Title · Provider · Quality · Size · Final Link · Link Type · Post URL · Source URL`

Check the connection from the GUI (Settings shows the sheet) or:
`GET /api/sheets/test`.

---

## Captcha handling

The ad chain occasionally hits a captcha. Two strategies:

| Mode | `CAPTCHA_PROVIDER` | Notes |
|------|--------------------|-------|
| **Manual** | `manual` | Requires `BROWSER_MODE=headful`. When a captcha appears the GUI shows a banner; solve it in the browser window, click **“I solved it.”** |
| **2captcha** | `2captcha` | Set `TWOCAPTCHA_API_KEY`. Works headless. Solves reCAPTCHA v2 / hCaptcha / Turnstile. |
| **None** | `none` | Assume the injected userscript clears invisible captchas. |

The injected userscript already auto-clicks the invisible / countdown gates on
the known ad hosts, so many links resolve with no captcha at all.

---

## Web GUI

`http://localhost:8787` gives you:

- **Status pills** — watcher state, last poll, queue counts, sheets on/off.
- **New posts** — parsed download options as clickable chips (click to resolve a
  single link; **GD** links are highlighted green). “Resolve preferred” enqueues
  your configured provider/quality set.
- **Jobs** — live status, per-job progress log, the resolved final link, retry /
  cancel.
- **Live log** — streamed over WebSocket.
- **Captcha banner** — for manual solving.
- **Settings** — preferred providers/qualities, poll interval, auto-resolve,
  browser mode. Saved live and persisted.

Protect it with `GUI_TOKEN` (sent as `?token=…` / `x-gui-token` header).

---

## Configuration

All settings live in `.env` (overriding `config/default.json`). See
[.env.example](.env.example) for the full list. Key ones:

| Var | Meaning |
|-----|---------|
| `POLL_INTERVAL_SECONDS` | how often to check pahe.ink |
| `PREFERRED_PROVIDERS` | which link types to auto-resolve (`GD` = Google Drive) |
| `PREFERRED_QUALITIES` | e.g. `720p,1080p` |
| `BROWSER_MODE` | `headless` or `headful` |
| `CAPTCHA_PROVIDER` | `manual` / `2captcha` / `none` |
| `GOOGLE_SHEET_ID` | target spreadsheet |

Provider codes seen on pahe.ink: **GD** = GDFlix/Google Drive, **1F** = 1Fichier,
**MG** = Mega, **VF**, **TB**.

---

## Docker (prepared)

```bash
docker compose up -d --build
```

Uses the official Playwright image (Chromium preinstalled). State and the browser
profile persist in the `watcher-data` volume; mount your service-account key into
`/app/credentials`. See `docker-compose.yml` and
[ARCHITECTURE.md](ARCHITECTURE.md) for headful/manual-captcha-in-container notes.

---

## MCP server (next phase)

The same core is exposed as Model Context Protocol tools in
[`src/mcp/server.js`](src/mcp/server.js) (stub). Install
`@modelcontextprotocol/sdk`, uncomment the wiring, and run `npm run mcp`. Tools:
`watcher_poll`, `list_posts`, `list_jobs`, `resolve_link`, `resolve_post`,
`job_status`, `sheet_status`.

---

## Project layout

See [ARCHITECTURE.md](ARCHITECTURE.md) for the module map, data flow, and
extension points (swap the store for SQLite, add a resolver, add a captcha
provider, etc.).

---

## Legal / responsible use

This tool automates access to third-party sites and content. Use it only where
you have the right to do so, and respect the sites’ terms and applicable law. The
bypass logic derives from a GPL-3.0 userscript; this project is MIT-licensed for
its own code.
