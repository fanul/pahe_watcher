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
| **store** | `src/core/store.js` | SQLite persistence (`node:sqlite`) for posts, options, jobs, meta, FTS5 search. Public surface is backing-store-agnostic — see Extension points below. |
| **db schema** | `src/core/db/schema.js` | Idempotent `CREATE TABLE IF NOT EXISTS` DDL, applied on every `Store` construction. |
| **db migration** | `src/core/db/migrateJsonState.js` | One-time import of the legacy `data/state.json` into SQLite; idempotent, renames the JSON file to `.migrated` after a successful commit. |
| **paheClient** | `src/watcher/paheClient.js` | pahe.ink WP REST API client (posts + content + real `X-WP-Total`/`X-WP-TotalPages` pagination headers). |
| **postParser** | `src/parser/postParser.js` | Extracts download options (provider × quality × url) from post HTML. |
| **syncEngine** | `src/watcher/syncEngine.js` | Owns the two sync primitives (cheap per-page listing, full per-post deep-sync) and their orchestration: live poll, resumable historical backfill, deep-sync sweep. |
| **watcher** | `src/watcher/watcher.js` | Thin façade: owns the poll-interval timer + the optional backfill-auto-run timer, delegates sync work to `syncEngine`. |
| **jobQueue** | `src/queue/jobQueue.js` | Concurrency-limited queue with retries; transport-agnostic processor. |
| **bypass** | `src/bypass/*` | Playwright browser + injected userscript + captcha + GDFlix resolver. |
| **sheets** | `src/sheets/sheetsClient.js` | Google Sheets append sink. |
| **server** | `src/server/*` | Express REST API + WebSocket + static GUI. |
| **mcp** | `src/mcp/server.js` | MCP tool surface (stub, next phase). |

## Data flow (one new movie)

1. **watcher.poll()** delegates to `syncEngine.runLivePoll()`, which calls
   `PaheClient.getLatestPosts()` (WP REST API, newest N).
2. Unseen post → `syncEngine.deepSyncPost(id)` → `PaheClient.getPost(id)` →
   `parseDownloadOptions(html)` + `parsePostMetadata(html)` yields
   `{ provider, quality, sizeLabel, url }[]` + poster/rating/synopsis.
   Persisted via `store.markPost` (upserts `posts` + fully replaces
   `post_options`). `post:new` emitted.
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

## Local sync & the resumable historical backfill

The live poll above only ever looks at page 1 (the newest posts). Everything
else — walking the rest of pahe.ink's catalog into local storage — goes
through `syncEngine`'s two decoupled primitives:

- **`listingSyncPage(page, perPage)`** — cheap: one WP REST page fetch, upserts
  a shallow `{title, link, date}` row per post not already known.
  `content_synced_at` stays `NULL`.
- **`deepSyncPost(postId)`** — expensive: fetches full content, parses
  options + metadata, sets `content_synced_at`.

`runBackfillBatch({batchSize, direction, deepSync})` processes up to
`batchSize` pages starting from a cursor persisted in the `meta` table
(`sync.backfill.cursor`), then **stops and returns** — never the whole catalog
in one call. The next call resumes from that cursor. This is deliberate: the
old one-shot crawl always restarted at page 1 and blocked until the full
`maxPages` range finished. `sweepDeepSync({batchSize})` is the fully decoupled
catch-up step — it deep-syncs whatever's still shallow
(`content_synced_at IS NULL`), regardless of how those rows were discovered,
so a fast full-catalog listing pass and content backfill can run on separate
schedules.

Controlled via `config.sync.*` (`config/default.json`, env vars, Settings UI
→ "Local Sync"), or per-call via the `/sync/*` API routes / the `sync_backfill`
MCP tool. `pahe.ink`'s real `X-WP-Total`/`X-WP-TotalPages` response headers
(read in `PaheClient.getPostsPageMeta`) tell the cursor when it's reached the
end, instead of inferring it from an empty page.

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
| Swap SQLite for Postgres/another store | Implement the `Store` surface (`hasSeenPost`, `getPost`, `markPost`, `listPosts`, `upsertJob`, `deleteJob`, `getJob`, `listJobs`, `get/setMeta`, `transaction`, `searchPosts`, `countPosts`/`countJobs`) and swap it in `app.js`. |
| Add real vector/semantic search | `post_embeddings` (plain table, `post_id`/`model`/`dims`/`embedding`/`embedded_at`) already reserves the shape. Pick an embedding provider, populate that table on `deepSyncPost`, then either query it manually (cosine similarity in JS is fine at this scale) or load the `sqlite-vec` extension (`db.loadExtension()` — `node:sqlite`'s `DatabaseSync` supports it) and migrate to a `vec0` virtual table for indexed KNN search. Not wired up yet — FTS5 (`store.searchPosts`) covers text search today. |
| Add a captcha provider | Add `bypass/captcha/<name>.js` with `solve(page, ctx)`; register in `captcha/index.js`. |
| Support a new final host | Add a resolver + `FINAL_HOST_RE`/branch in `bypass/index.js`. |
| Add a new download provider | It already parses any short anchor code; add a friendly name in `PROVIDER_NAMES`. |
| Notify (Telegram/Discord) on resolve | Subscribe to `sheet:appended` / `job:updated` on the bus. |
| Change historical sync behavior | `config.sync.*` (batch size, direction, deep-sync on/off, auto-run interval) — Settings UI, env vars, or per-call via `/sync/backfill/run` / `sync_backfill` MCP tool. |

## MCP surface (next phase)

`src/mcp/server.js` reuses `createApp()` and declares tools that map 1:1 to core
operations: `watcher_poll`, `list_posts`, `search_posts`, `sync_backfill`,
`list_jobs`, `resolve_link`, `resolve_post`, `job_status`, `sheet_status`. The
SDK wiring is written and commented; install `@modelcontextprotocol/sdk` and
enable it. Because it shares the app context, an MCP client and the web GUI
can drive the **same** running instance — `search_posts`/`sync_backfill` are
the concrete payoff of the SQLite migration: an agent can search the whole
locally-synced catalog and drive the historical backfill without ever hitting
pahe.ink directly itself.

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
- `test/store.test.js`, `test/migration.test.js`, `test/syncEngine.test.js`
  cover the SQLite store, the JSON→SQLite migration, and the sync engine's
  resumable-cursor/deep-sync-decoupling logic directly (no browser/mock-page
  dependency needed — this is pure DB/HTTP-shaped logic, unlike the
  bypass-engine tests below).
- The watcher, queue, store, and API are exercised by booting the server and
  polling live pahe.ink (see README run modes). The bypass engine is best
  validated interactively in headful mode against a live link.

## Requirements

Node **≥ 22.5.0** — `src/core/store.js` uses the built-in `node:sqlite`
module (`DatabaseSync`), which requires it. Startup prints an
`ExperimentalWarning: SQLite is an experimental feature` — expected, not a
bug. `docker/Dockerfile`'s pinned Playwright base image predates this
requirement and needs a version bump before the Docker path is exercised
again (tracked separately; Docker isn't currently in active use for this
project).
