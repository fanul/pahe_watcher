# Architecture

pahe-watcher is built as **decoupled core modules** wired together by a small app
context. The core has **no knowledge of transport** (HTTP, MCP, CLI). This is
what makes the web GUI, the planned MCP server, and cron/CLI runs all thin layers
over the same engine.

```
                         ┌───────────────────────────────┐
   transports  ─────────►│  app context (src/app.js)      │
   ┌──────────┐          │  runtime config + module wiring │
   │ Web GUI  │──REST/WS─┤                                 │
   │ MCP srv  │──tools───┤   watcher  parser  queue        │
   │ CLI/cron │──flags───┤   bypass   sheets  store        │
   └──────────┘          └───────────────────────────────┘
```

## Module map

| Module | File | Responsibility |
|--------|------|----------------|
| **config** | `src/config/index.js` | Layered config: `config/default.json` ← env (`.env`). Frozen. |
| **logger** | `src/core/logger.js` | Namespaced leveled logging; every line also emitted on the bus for the GUI. |
| **eventBus** | `src/core/eventBus.js` | Central `EventEmitter` decoupling modules from the live UI. |
| **store** | `src/core/store.js` | JSON-file persistence (posts, jobs, meta). Atomic writes, debounced. **Swappable.** |
| **paheClient** | `src/watcher/paheClient.js` | pahe.ink WP REST API client (posts + content). |
| **postParser** | `src/parser/postParser.js` | Extracts download options (provider × quality × url) from post HTML. |
| **watcher** | `src/watcher/watcher.js` | Poll loop → detect new posts → parse → persist → enqueue. |
| **jobQueue** | `src/queue/jobQueue.js` | Concurrency-limited queue with retries; transport-agnostic processor. |
| **bypass** | `src/bypass/*` | Playwright browser + injected userscript + captcha + GDFlix resolver. |
| **sheets** | `src/sheets/sheetsClient.js` | Google Sheets append sink. |
| **server** | `src/server/*` | Express REST API + WebSocket + static GUI. |
| **mcp** | `src/mcp/server.js` | MCP tool surface (stub, next phase). |

## Data flow (one new movie)

1. **watcher.poll()** calls `PaheClient.getLatestPosts()` (WP REST API).
2. Unseen post → `PaheClient.getPost(id)` → `parseDownloadOptions(html)` yields
   `{ provider, quality, sizeLabel, url }[]`. Persisted via `store.markPost`.
   `post:new` emitted.
3. If `autoResolve`, `selectOptions()` filters by preferred providers/qualities
   and `queue.enqueue()`s one job per option.
4. Queue worker runs the **processor** (defined in `app.js`):
   - `bypass.resolve(job, ctx)` opens a page at the entry URL; the injected
     userscript auto-advances the ad hosts; the engine watches for a **GDFlix**
     page and runs `resolveGdflix()`, or a final host directly. Captchas are
     handled by the configured solver.
   - Returns `{ finalUrl, linkType }`.
   - `sheets.appendResolved(row)` writes it to the Sheet.
5. GUI updates live from bus events over WebSocket.

## Key design choices

- **Bus-driven UI.** Modules never call the server; they `bus.emit(...)`. The
  server rebroadcasts to WebSocket clients. Add a new live widget without
  touching core logic.
- **Runtime config overlay.** `app.js` deep-clones the frozen config into a
  mutable `runtime`. The GUI PATCHes a subset (preferences, interval, browser
  mode); overrides persist in `store` meta and re-apply on restart.
- **Injected userscript, not reimplemented.** `bypass/userscript.js` ports the
  battle-tested click/redirect logic from the Violentmonkey script and runs it
  via `page.addInitScript` at document-start on every navigation.
- **Resolver registry.** `bypass/resolvers/` isolates site-specific extraction.
  GDFlix is implemented; add `resolvers/<host>.js` and branch in
  `bypass/index.js` for new final hosts.

## Extension points

| Want to… | Do this |
|----------|---------|
| Use SQLite/Postgres instead of JSON | Implement the `Store` surface (`hasSeenPost`, `markPost`, `upsertJob`, `listJobs`, `get/setMeta`) and swap it in `app.js`. |
| Add a captcha provider | Add `bypass/captcha/<name>.js` with `solve(page, ctx)`; register in `captcha/index.js`. |
| Support a new final host | Add a resolver + `FINAL_HOST_RE`/branch in `bypass/index.js`. |
| Add a new download provider | It already parses any short anchor code; add a friendly name in `PROVIDER_NAMES`. |
| Notify (Telegram/Discord) on resolve | Subscribe to `sheet:appended` / `job:updated` on the bus. |

## MCP surface (next phase)

`src/mcp/server.js` reuses `createApp()` and declares tools that map 1:1 to core
operations: `watcher_poll`, `list_posts`, `list_jobs`, `resolve_link`,
`resolve_post`, `job_status`, `sheet_status`. The SDK wiring is written and
commented; install `@modelcontextprotocol/sdk` and enable it. Because it shares
the app context, an MCP client and the web GUI can drive the **same** running
instance.

## Docker & manual captcha in containers

The default image runs headless — pair it with `CAPTCHA_PROVIDER=2captcha` for
fully unattended operation.

For **manual** captcha solving inside Docker you need a visible browser. Planned
approach (sketched in `docker-compose.yml`): run with `BROWSER_MODE=headful`
under a lightweight X server + **noVNC** sidecar so the operator can solve
captchas from a browser tab, while the GUI’s captcha banner coordinates timing.
This is deferred to the Docker phase.

## Testing

- `test/parser.test.js` covers the post parser (the most logic-heavy pure
  module) using `node --test`.
- The watcher, queue, store, and API are exercised by booting the server and
  polling live pahe.ink (see README run modes). The bypass engine is best
  validated interactively in headful mode against a live link.
