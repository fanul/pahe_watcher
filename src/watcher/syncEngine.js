import { createLogger } from '../core/logger.js';
import { bus } from '../core/eventBus.js';
import { parseDownloadOptions, selectOptions, checkIsSeries, parsePostMetadata } from '../parser/postParser.js';

const log = createLogger('sync');

const CURSOR_META_KEY = 'sync.backfill.cursor';

const DEFAULT_CURSOR = {
  page: 1,
  direction: 'older',
  status: 'idle',
  totalPages: null,
  totalPosts: null,
  lastRunAt: null,
  lastError: null,
};

/**
 * Owns two decoupled sync primitives — cheap per-page listing, and full
 * per-post deep-sync (content fetch + parse) — reused by both the live poll
 * and the resumable historical backfill. See ARCHITECTURE.md.
 */
export class SyncEngine {
  constructor({ config, store, client, queue }) {
    this.config = config;
    this.store = store;
    this.client = client;
    this.queue = queue;
  }

  /**
   * Cheap discovery step for one WP REST page: upserts a shallow row
   * ({title, link, date}, no options/metadata) for any post not already
   * known. Already-known posts are left untouched — deep-sync is what
   * refreshes/enriches them, not a repeated listing pass.
   */
  async listingSyncPage(page, perPage, { direction } = {}) {
    log.info(`Listing page ${page} (direction: ${direction || 'default'})...`);
    const { posts, totalPosts, totalPages } = await this.client.getPostsPageMeta(page, perPage);
    let discovered = 0;

    this.store.transaction(() => {
      for (const post of posts) {
        if (this.store.hasSeenPost(post.id)) continue;
        discovered += 1;
        const entry = {
          id: post.id,
          title: post.title,
          link: post.link,
          date: post.date,
          seenAt: new Date().toISOString(),
          options: [],
          pageFound: direction ? page : undefined,
        };
        this.store.markPost(entry);
        bus.emit('post:new', entry);
      }
    });

    log.info(`Page ${page} listing sync complete: found ${posts.length} posts (${discovered} new to database).`);
    return { posts, discovered, totalPosts, totalPages };
  }

  /**
   * Full per-post sync: fetches content, parses download options + poster/
   * rating/synopsis/series metadata, and upserts the complete entry. Fine to
   * call standalone (e.g. from the deep-sync sweep) or right after a listing
   * pass discovered the post.
   */
  async deepSyncPost(postId) {
    const existing = this.store.getPost(postId);
    const titleLabel = existing ? existing.title : `ID ${postId}`;
    log.info(`Deep-syncing post: "${titleLabel}"...`);

    let options = [];
    let meta = { poster: '', rating: '', synopsis: '', year: null, genre: '', durationMinutes: null, director: '', creator: '', actors: '' };
    let full;
    try {
      full = await this.client.getPost(postId);
      options = parseDownloadOptions(full.contentHtml);
      meta = parsePostMetadata(full.contentHtml);
    } catch (err) {
      log.error(`Failed to deep-sync post "${titleLabel}"`, { id: postId, error: String(err) });
      return existing;
    }

    const isSeries = checkIsSeries(full.title, options);
    const entry = {
      id: postId,
      title: full.title,
      link: full.link,
      date: full.date,
      seenAt: existing?.seenAt || new Date().toISOString(),
      pageFound: existing?.pageFound,
      options,
      poster: meta.poster,
      rating: meta.rating,
      synopsis: meta.synopsis,
      isSeries,
      year: meta.year,
      genre: meta.genre,
      durationMinutes: meta.durationMinutes,
      director: meta.director,
      creator: meta.creator,
      actors: meta.actors,
    };
    this.store.markPost(entry);
    bus.emit('post:new', entry);
    log.info(`Deep-sync complete for: "${entry.title}" (parsed ${options.length} download options).`);
    return entry;
  }

  /**
   * Direct replacement for the old Watcher.poll() body: newest N posts,
   * skip anything already seen, deep-sync (fetch+parse+store) whatever's
   * new, then auto-resolve per the existing preferred-provider/quality
   * config. Same return shape as before ({found}).
   */
  async runLivePoll() {
    const posts = await this.client.getLatestPosts(this.config.watcher.perPage);
    posts.sort((a, b) => (a.date > b.date ? 1 : -1)); // oldest-first

    let found = 0;
    for (const post of posts) {
      if (this.store.hasSeenPost(post.id)) continue;
      found += 1;
      log.info(`New post: ${post.title}`, { id: post.id });
      const entry = await this.deepSyncPost(post.id);
      await this._maybeAutoResolve(entry);
    }

    this.store.setMeta('lastPollAt', new Date().toISOString());
    bus.emit('watcher:tick', { at: new Date().toISOString(), checked: posts.length, found });
    log.info(`Poll complete: checked ${posts.length}, new ${found}`);
    return { found };
  }

  async _maybeAutoResolve(entry) {
    if (!entry) return;
    if (!this.config.watcher.autoResolve) {
      log.info('autoResolve disabled — leaving post for manual resolution', { id: entry.id });
      return;
    }
    if (entry.isSeries && this.config.watcher.onlyCompleteSeries && !/complete/i.test(entry.title)) {
      log.info('Skipping auto-resolve for in-progress series (does not contain "Complete" in title)', { id: entry.id, title: entry.title });
      return;
    }

    const selected = selectOptions(entry.options, {
      providers: this.config.watcher.preferredProviders,
      qualities: this.config.watcher.preferredQualities,
      codecs: this.config.watcher.preferredCodecs || ['x265', 'x264'],
      seriesType: this.config.watcher.preferredSeriesType || 'batch',
      isSeries: entry.isSeries,
    });
    if (selected.length === 0) {
      log.info('No matching download options to auto-resolve', { id: entry.id, total: entry.options.length });
      return;
    }

    for (const opt of selected) {
      this.queue.enqueue({
        postId: entry.id,
        title: entry.title,
        postLink: entry.link,
        provider: opt.provider,
        quality: opt.quality,
        qualityLabel: opt.qualityLabel,
        sizeLabel: opt.sizeLabel,
        url: opt.url,
      });
    }
    log.info(`Enqueued ${selected.length} bypass job(s)`, { id: entry.id });
  }

  /** Read the persisted backfill cursor (never throws; returns the default shape if unset). */
  getBackfillCursor() {
    return { ...DEFAULT_CURSOR, ...this.store.getMeta(CURSOR_META_KEY, {}) };
  }

  _setBackfillCursor(patch) {
    const cursor = { ...this.getBackfillCursor(), ...patch };
    this.store.setMeta(CURSOR_META_KEY, cursor);
    return cursor;
  }

  /** Explicit control: jump the cursor to a page and/or change direction without processing anything. */
  resetBackfillCursor({ page, direction } = {}) {
    const cursor = this.getBackfillCursor();
    return this._setBackfillCursor({
      page: page ?? cursor.page,
      direction: direction ?? cursor.direction,
      status: 'idle',
      lastError: null,
    });
  }

  setBackfillPaused(paused) {
    return this._setBackfillCursor({ status: paused ? 'paused' : 'idle' });
  }

  /**
   * Resumable historical sync: processes up to `batchSize` WP REST pages
   * starting from the persisted cursor, then stops and returns — never the
   * whole catalog in one call. A later call with the same (or no) args
   * continues from where this one left off, rather than restarting at
   * page 1 every time.
   */
  async runBackfillBatch({ batchSize, direction, deepSync } = {}) {
    const cfg = this.config.sync || {};
    batchSize = batchSize ?? cfg.backfillBatchSize ?? 5;
    deepSync = deepSync ?? cfg.backfillDeepSync ?? true;

    let cursor = this.getBackfillCursor();
    if (direction && direction !== cursor.direction) {
      cursor = this._setBackfillCursor({ direction }); // change direction, keep current page
    }

    log.info(`Starting backfill batch: processing ${batchSize} pages (direction: ${cursor.direction}, deepSync: ${deepSync}, current page: ${cursor.page})...`);

    const perPage = this.config.watcher.perPage || 10;
    const step = cursor.direction === 'newer' ? -1 : 1;

    let pagesProcessed = 0;
    let postsListed = 0;
    let postsDeepSynced = 0;
    let page = cursor.page;
    let totalPages = cursor.totalPages;
    let totalPosts = cursor.totalPosts;
    const touched = [];

    try {
      while (pagesProcessed < batchSize) {
        if (page < 1) break;
        if (totalPages && page > totalPages) break;

        log.info(`Processing backfill page ${page} of batch (processed ${pagesProcessed}/${batchSize})...`);
        const result = await this.listingSyncPage(page, perPage, { direction: cursor.direction });
        totalPages = result.totalPages ?? totalPages;
        totalPosts = result.totalPosts ?? totalPosts;
        postsListed += result.discovered;

        if (result.posts.length === 0) {
          pagesProcessed += 1;
          break; // safety net even without a known totalPages
        }

        if (deepSync) {
          for (const p of result.posts) {
            const existing = this.store.getPost(p.id);
            if (existing?.options?.length > 0 || existing?.synopsis) {
              log.info(`Post "${existing.title || p.title}" already has options/synopsis. Skipping deep sync.`);
              continue;
            }
            const entry = await this.deepSyncPost(p.id);
            if (entry) {
              postsDeepSynced += 1;
              touched.push(entry);
            }
          }
        }

        pagesProcessed += 1;
        page += step;
      }

      cursor = this._setBackfillCursor({
        page, totalPages, totalPosts, status: 'idle', lastError: null, lastRunAt: new Date().toISOString(),
      });
    } catch (err) {
      cursor = this._setBackfillCursor({ status: 'error', lastError: String(err), lastRunAt: new Date().toISOString() });
      log.error('Backfill batch failed', { error: String(err), cursor });
      throw err;
    }

    const done = Boolean(totalPages && (cursor.direction === 'older' ? page > totalPages : page < 1));
    bus.emit('crawl:progress', { status: done ? 'done' : 'running', page: cursor.page, totalPages, totalPosts, pagesProcessed });
    log.info('Backfill batch complete', { pagesProcessed, postsListed, postsDeepSynced, page: cursor.page, totalPages });

    return { pagesProcessed, postsListed, postsDeepSynced, cursor, done, entries: touched };
  }

  /**
   * Decoupled catch-up: deep-syncs whichever posts are still shallow
   * (content_synced_at NULL), regardless of how they were discovered. Lets
   * a fast full-catalog listing pass run first, with content backfilled
   * separately/incrementally afterward.
   */
  async sweepDeepSync({ batchSize } = {}) {
    const cfg = this.config.sync || {};
    batchSize = batchSize ?? cfg.deepSyncSweepBatchSize ?? 20;

    const ids = this.store.listUnsyncedPostIds(batchSize);
    const entries = [];
    log.info(`Starting deep-sync sweep for up to ${batchSize} shallow posts (remaining unsynced: ${this.store.countUnsyncedPosts()})...`);
    for (const id of ids) {
      const entry = await this.deepSyncPost(id);
      if (entry) entries.push(entry);
    }
    const remaining = this.store.countUnsyncedPosts();
    log.info('Deep-sync sweep complete', { processed: entries.length, remaining });
    return { processed: entries.length, remaining, entries };
  }

  /**
   * Backfills year/genre/duration/director/creator/actors onto posts that
   * were already deep-synced under an older parser version that didn't
   * extract them. Distinct from sweepDeepSync: those posts already have
   * content_synced_at set (and are skipped by it), so a separate selection
   * (content_synced_at IS NOT NULL AND year/genre IS NULL) is needed. Reuses
   * deepSyncPost as-is — it already captures the new fields for any post it
   * touches, old or new.
   */
  async sweepMetadataBackfill({ batchSize } = {}) {
    const cfg = this.config.sync || {};
    batchSize = batchSize ?? cfg.metadataBackfillSweepBatchSize ?? 20;

    const ids = this.store.listPostsMissingExtendedMetadata(batchSize);
    const entries = [];
    log.info(`Starting metadata backfill sweep for up to ${batchSize} posts (remaining missing metadata: ${this.store.countPostsMissingExtendedMetadata()})...`);
    for (const id of ids) {
      const entry = await this.deepSyncPost(id);
      if (entry) entries.push(entry);
    }
    const remaining = this.store.countPostsMissingExtendedMetadata();
    log.info('Metadata backfill sweep complete', { processed: entries.length, remaining });
    return { processed: entries.length, remaining, entries };
  }
}

export default SyncEngine;
