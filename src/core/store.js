import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createLogger } from './logger.js';
import { applySchema } from './db/schema.js';
import { migrateJsonStateIfNeeded } from './db/migrateJsonState.js';
import { parseSeasonRangeFromTitle } from '../parser/postParser.js';
import { isMetadataComplete } from '../parser/metadata/index.js';

const log = createLogger('store');

// Job fields that map to real columns; anything else round-trips through payload_extra.
const JOB_COLUMN_FIELDS = [
  'id', 'status', 'attempts', 'createdAt', 'updatedAt', 'postId', 'title',
  'postLink', 'provider', 'quality', 'qualityLabel', 'sizeLabel', 'url', 'logs', 'result', 'error',
];
const JOB_FIELD_TO_COLUMN = {
  id: 'id', status: 'status', attempts: 'attempts', createdAt: 'created_at', updatedAt: 'updated_at',
  postId: 'post_id', title: 'title', postLink: 'post_link', provider: 'provider', quality: 'quality',
  qualityLabel: 'quality_label', sizeLabel: 'size_label', url: 'url', logs: 'logs', result: 'result', error: 'error',
};

// Whitelisted ORDER BY clauses for queryPosts's `sort` param — never
// string-interpolated from the caller directly, to avoid SQL injection.
const SORT_CLAUSES = {
  date_desc: 'posts.date DESC',
  date_asc: 'posts.date ASC',
  rating_desc: 'CAST(posts.rating AS REAL) DESC NULLS LAST',
  rating_asc: 'CAST(posts.rating AS REAL) ASC NULLS LAST',
  year_desc: 'posts.year DESC NULLS LAST',
  year_asc: 'posts.year ASC NULLS LAST',
  title_asc: 'posts.title COLLATE NOCASE ASC',
  title_desc: 'posts.title COLLATE NOCASE DESC',
};

/**
 * SQLite-backed persistence (node:sqlite, built into Node 22+). Same public
 * surface as the original JSON-file store — hasSeenPost/getPost/markPost/
 * listPosts/upsertJob/deleteJob/getJob/listJobs/getMeta/setMeta/flushNow —
 * so callers (watcher, jobQueue, api routes, MCP tools) need no changes.
 * See ARCHITECTURE.md for the schema and the migration-from-JSON path.
 */
export class Store {
  constructor({ sqlitePath, jsonPath }) {
    this.sqlitePath = sqlitePath;
    this.jsonPath = jsonPath;
    this._txDepth = 0;
    fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });
    this.db = new DatabaseSync(sqlitePath);
    applySchema(this.db);
    migrateJsonStateIfNeeded(this.db, jsonPath, log);
    this._backfillMetadataCompleteFlag();

    this._stmt = {
      hasSeenPost: this.db.prepare('SELECT 1 FROM posts WHERE id = ?'),
      getPost: this.db.prepare('SELECT * FROM posts WHERE id = ?'),
      getPostOptions: this.db.prepare(`
        SELECT po.*,
          (SELECT result FROM jobs WHERE jobs.url = po.url AND jobs.status = 'done' ORDER BY created_at DESC LIMIT 1) AS job_result
        FROM post_options po
        WHERE po.post_id = ?
        ORDER BY po.sort_order
      `),
      allPosts: this.db.prepare('SELECT * FROM posts ORDER BY date DESC'),
      allPostOptions: this.db.prepare('SELECT * FROM post_options ORDER BY post_id, sort_order'),
      deletePostOptions: this.db.prepare('DELETE FROM post_options WHERE post_id = ?'),
      insertOption: this.db.prepare(
        `INSERT INTO post_options (post_id, sort_order, provider, provider_name, quality, quality_label, season, size_label, url, host, dead_reported_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      existingReportedUrls: this.db.prepare(
        'SELECT url, dead_reported_at FROM post_options WHERE post_id = ? AND dead_reported_at IS NOT NULL',
      ),
      markOptionReported: this.db.prepare(
        'UPDATE post_options SET dead_reported_at = ? WHERE post_id = ? AND url = ?',
      ),
      // Jobs carry postLink, not always a reliable postId (manually-created jobs
      // often leave postId unset) — resolve the post via its link instead.
      markOptionReportedByLink: this.db.prepare(
        'UPDATE post_options SET dead_reported_at = ? WHERE url = ? AND post_id = (SELECT id FROM posts WHERE link = ?)',
      ),
      // metadata_source_incomplete is deliberately NOT in the ON CONFLICT SET
      // list — it's a durable manual annotation (like dead_reported_at),
      // never touched by a resync's full upsert. Only markPostSourceIncomplete
      // changes it. New rows always start unflagged (NULL).
      upsertPost: this.db.prepare(`
        INSERT INTO posts (id, title, link, date, seen_at, poster, rating, synopsis, is_series, page_found, content_synced_at,
                            year, genre, duration_minutes, director, creator, actors, metadata_complete, metadata_source_incomplete)
        VALUES (@id, @title, @link, @date, @seen_at, @poster, @rating, @synopsis, @is_series, @page_found, @content_synced_at,
                @year, @genre, @duration_minutes, @director, @creator, @actors, @metadata_complete, NULL)
        ON CONFLICT(id) DO UPDATE SET
          title=excluded.title, link=excluded.link, date=excluded.date, seen_at=excluded.seen_at,
          poster=excluded.poster, rating=excluded.rating, synopsis=excluded.synopsis,
          is_series=excluded.is_series, page_found=excluded.page_found, content_synced_at=excluded.content_synced_at,
          year=excluded.year, genre=excluded.genre, duration_minutes=excluded.duration_minutes,
          director=excluded.director, creator=excluded.creator, actors=excluded.actors,
          metadata_complete=excluded.metadata_complete
      `),
      markPostSourceIncomplete: this.db.prepare('UPDATE posts SET metadata_source_incomplete = ? WHERE id = ?'),
      countPosts: this.db.prepare('SELECT COUNT(*) AS n FROM posts'),
      countJobs: this.db.prepare('SELECT COUNT(*) AS n FROM jobs'),
      getJob: this.db.prepare('SELECT * FROM jobs WHERE id = ?'),
      allJobs: this.db.prepare('SELECT * FROM jobs ORDER BY created_at DESC'),
      deleteJob: this.db.prepare('DELETE FROM jobs WHERE id = ?'),
      getMeta: this.db.prepare('SELECT value FROM meta WHERE key = ?'),
      setMeta: this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'),
      searchPosts: this.db.prepare(`
        SELECT posts.* FROM posts_fts
        JOIN posts ON posts.id = posts_fts.rowid
        WHERE posts_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `),
      unsyncedPostIds: this.db.prepare('SELECT id FROM posts WHERE content_synced_at IS NULL ORDER BY id ASC LIMIT ?'),
      countUnsyncedPosts: this.db.prepare('SELECT COUNT(*) AS n FROM posts WHERE content_synced_at IS NULL'),
      // Two independent reasons a post lands in this sweep:
      //  1. IMDb metadata (poster/rating/synopsis/etc.) is incomplete — excludes
      //     metadata_source_incomplete=1 rows, since the user has confirmed
      //     pahe.ink's own page never had that data (re-fetching it forever
      //     would be pointless churn).
      //  2. At least one download option has no resolvable quality — always a
      //     parser/layout gap, never a legitimate "source doesn't have it"
      //     case (pahe.ink always shows *some* quality heading), so this one
      //     is NOT excluded by metadata_source_incomplete.
      missingExtendedMetadataIds: this.db.prepare(`
        SELECT id FROM posts WHERE content_synced_at IS NOT NULL AND (
          ((metadata_complete IS NULL OR metadata_complete = 0) AND (metadata_source_incomplete IS NULL OR metadata_source_incomplete = 0))
          OR EXISTS (SELECT 1 FROM post_options po WHERE po.post_id = posts.id AND po.quality IS NULL)
        ) ORDER BY id ASC LIMIT ?
      `),
      countMissingExtendedMetadata: this.db.prepare(`
        SELECT COUNT(*) AS n FROM posts WHERE content_synced_at IS NOT NULL AND (
          ((metadata_complete IS NULL OR metadata_complete = 0) AND (metadata_source_incomplete IS NULL OR metadata_source_incomplete = 0))
          OR EXISTS (SELECT 1 FROM post_options po WHERE po.post_id = posts.id AND po.quality IS NULL)
        )
      `),
      distinctYears: this.db.prepare('SELECT DISTINCT year FROM posts WHERE year IS NOT NULL ORDER BY year DESC'),
      distinctGenres: this.db.prepare("SELECT DISTINCT genre FROM posts WHERE genre IS NOT NULL AND genre != ''"),
      // LEFT JOIN (not INNER) so series posts with no season-tagged options
      // yet — either never re-synced since the `season` column was added, or
      // genuinely have none — still appear, with max_season NULL. That NULL
      // is treated as "not yet confirmed complete" by _computeStaleSeriesIds.
      seriesWithSeasons: this.db.prepare(`
        SELECT posts.id, posts.title, MAX(po.season) AS max_season
        FROM posts
        LEFT JOIN post_options po ON po.post_id = posts.id
        WHERE posts.is_series = 1
        GROUP BY posts.id
        ORDER BY posts.id ASC
      `),
    };

    log.info('SQLite store ready', { path: sqlitePath, posts: this.countPosts(), jobs: this.countJobs() });
  }

  /**
   * One-time (per row) retroactive computation of `metadata_complete` for
   * posts synced before that column existed. Those rows already have their
   * poster/rating/synopsis/year/genre/director/creator/actors columns
   * populated by whatever parser version synced them — this just runs
   * isMetadataComplete() against data already on disk, no live re-fetch
   * needed. Naturally idempotent: once a row is set to 0/1 it's never NULL
   * again (unless deepSyncPost recomputes it fresh), so this is a no-op scan
   * on every startup after the first.
   */
  _backfillMetadataCompleteFlag() {
    const rows = this.db.prepare(`
      SELECT id, poster, rating, synopsis, year, genre, duration_minutes, director, creator, actors
      FROM posts WHERE metadata_complete IS NULL
    `).all();
    if (rows.length === 0) return;

    const update = this.db.prepare('UPDATE posts SET metadata_complete = ? WHERE id = ?');
    this.transaction(() => {
      for (const row of rows) {
        const complete = isMetadataComplete({
          poster: row.poster || '', rating: row.rating || '', synopsis: row.synopsis || '',
          year: row.year, genre: row.genre || '', durationMinutes: row.duration_minutes,
          director: row.director || '', creator: row.creator || '', actors: row.actors || '',
        });
        update.run(complete ? 1 : 0, row.id);
      }
    });
    log.info(`Backfilled metadata_complete for ${rows.length} already-synced post(s)`);
  }

  /**
   * Run `fn` inside a transaction; rolls back on throw. Reentrant — SQLite
   * has no nested transactions, so a call while one is already open (e.g.
   * markPost() called from inside a caller's own transaction()) just runs
   * fn() inline; only the outermost call actually issues BEGIN/COMMIT.
   */
  transaction(fn) {
    if (this._txDepth > 0) {
      this._txDepth += 1;
      try {
        return fn();
      } finally {
        this._txDepth -= 1;
      }
    }
    this._txDepth = 1;
    this.db.exec('BEGIN');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    } finally {
      this._txDepth = 0;
    }
  }

  close() {
    this.db.close();
  }

  /** Kept for API parity with the old JSON store's shutdown hook; ensures the WAL is durable. */
  flushNow() {
    try {
      this.db.exec('PRAGMA wal_checkpoint(FULL)');
    } catch (err) {
      log.error('WAL checkpoint failed', { error: String(err) });
    }
  }

  // ── posts ──
  hasSeenPost(id) {
    return Boolean(this._stmt.hasSeenPost.get(Number(id)));
  }

  getPost(id) {
    const row = this._stmt.getPost.get(Number(id));
    if (!row) return null;
    return this._hydratePost(row);
  }

  markPost(post) {
    const id = Number(post.id);
    const seenAt = post.seenAt || new Date().toISOString();
    const options = post.options || [];
    const hasContent = options.length > 0 || Boolean(post.synopsis);

    this.transaction(() => {
      this._stmt.upsertPost.run({
        id,
        title: post.title ?? '',
        link: post.link ?? '',
        date: post.date ?? seenAt,
        seen_at: seenAt,
        poster: post.poster ?? null,
        rating: post.rating ?? null,
        synopsis: post.synopsis ?? null,
        is_series: post.isSeries === undefined || post.isSeries === null ? null : (post.isSeries ? 1 : 0),
        page_found: post.pageFound ?? null,
        content_synced_at: hasContent ? seenAt : null,
        year: post.year ?? null,
        genre: post.genre || null,
        duration_minutes: post.durationMinutes ?? null,
        director: post.director || null,
        creator: post.creator || null,
        actors: post.actors || null,
        metadata_complete: post.metadataComplete === undefined ? null : (post.metadataComplete ? 1 : 0),
      });

      // dead_reported_at is a durable manual annotation tied to a specific
      // link, not sync-derived state — preserve it across the full-replace
      // below (shortener URLs stay stable across resyncs of the same content).
      const preservedReports = new Map();
      for (const row of this._stmt.existingReportedUrls.all(id)) {
        preservedReports.set(row.url, row.dead_reported_at);
      }

      this._stmt.deletePostOptions.run(id);
      options.forEach((opt, i) => {
        this._stmt.insertOption.run(
          id, i,
          opt.provider ?? null, opt.providerName ?? null, opt.quality ?? null,
          opt.qualityLabel ?? null, opt.season ?? null, opt.sizeLabel ?? null, opt.url ?? null, opt.host ?? null,
          preservedReports.get(opt.url) ?? null,
        );
      });
    });
  }

  listPosts() {
    const posts = this._stmt.allPosts.all();
    const allOptions = this._stmt.allPostOptions.all();
    const optionsByPost = new Map();
    for (const row of allOptions) {
      const list = optionsByPost.get(row.post_id) || [];
      list.push(this._hydrateOption(row));
      optionsByPost.set(row.post_id, list);
    }
    return posts.map((row) => this._hydratePost(row, optionsByPost.get(row.id) || []));
  }

  countPosts() {
    return this._stmt.countPosts.get().n;
  }

  /** Full-text search over title + synopsis (FTS5). Returns posts in the same shape as listPosts/getPost. */
  searchPosts(query, { limit = 25 } = {}) {
    if (!query || !query.trim()) return [];
    const rows = this._stmt.searchPosts.all(query, limit);
    return rows.map((row) => this._hydratePost(row));
  }

  /**
   * Paginated + filtered posts for the GUI list, so the frontend never has to
   * load the whole (potentially catalog-sized) table at once. Replicates the
   * filter semantics the GUI previously applied client-side in JS:
   *   - search: every whitespace-separated word must match title or synopsis
   *     (implemented as an FTS5 MATCH — matches whole words, not arbitrary
   *     substrings within a word, which is the one intentional behavior
   *     difference from the old client-side substring search).
   *   - type: 'movie' | 'series' | 'all'.
   *   - provider/quality/codec: a post matches only if a SINGLE download
   *     option satisfies all three together (not "has a GD option" AND
   *     separately "has a 1080p option") — same as the old matchingOpts
   *     filter.
   *   - codec 'x264' means "not x265/hevc/10bit-flagged", matching the old
   *     client's isX265-based exclusion, not a literal "x264" substring
   *     requirement.
   * `sort` picks an ORDER BY from a fixed whitelist (see SORT_CLAUSES) —
   * never string-interpolated from the caller, to avoid SQL injection.
   * Returns { items, total } — items shaped like listPosts()/getPost(), plus
   * a derived `hasDeadJob` boolean (true if any job resolving one of this
   * post's options is confirmed dead — see JobStatus.DEAD).
   */
  queryPosts({
    limit = 24, offset = 0, search = '', type = 'all', provider = 'all', quality = 'all', codec = 'all',
    genre = 'all', year = 'all', duration = 'all', rating = 'all', sort = 'date_desc',
    metadataComplete = 'all', deadLink = 'all',
  } = {}) {
    const { joinSql, whereSql, params } = this._buildPostsFilter({ search, type, provider, quality, codec, genre, year, duration, rating, metadataComplete, deadLink });
    const orderSql = SORT_CLAUSES[sort] || SORT_CLAUSES.date_desc;

    const total = this.db.prepare(`SELECT COUNT(*) AS n FROM posts ${joinSql} ${whereSql}`).get(...params).n;

    const rows = this.db.prepare(`
      SELECT posts.*,
        EXISTS (SELECT 1 FROM jobs WHERE jobs.post_link = posts.link AND jobs.status = 'dead') AS has_dead_job
      FROM posts ${joinSql} ${whereSql}
      ORDER BY ${orderSql}
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset);

    const ids = rows.map((r) => r.id);
    const optionsByPost = new Map();
    if (ids.length) {
      const placeholders = ids.map(() => '?').join(',');
      const optRows = this.db
        .prepare(`
          SELECT po.*,
            (SELECT result FROM jobs WHERE jobs.url = po.url AND jobs.status = 'done' ORDER BY created_at DESC LIMIT 1) AS job_result
          FROM post_options po
          WHERE po.post_id IN (${placeholders})
          ORDER BY po.post_id, po.sort_order
        `)
        .all(...ids);
      for (const row of optRows) {
        const list = optionsByPost.get(row.post_id) || [];
        list.push(this._hydrateOption(row));
        optionsByPost.set(row.post_id, list);
      }
    }

    const items = rows.map((row) => this._hydratePost(row, optionsByPost.get(row.id) || []));
    return { items, total };
  }

  _buildPostsFilter({ search, type, provider, quality, codec, genre = 'all', year = 'all', duration = 'all', rating = 'all', metadataComplete = 'all', deadLink = 'all' }) {
    const joins = [];
    const where = [];
    const params = [];

    if (search && search.trim()) {
      const ftsQuery = search.trim().split(/\s+/).filter(Boolean)
        .map((w) => `"${w.replace(/"/g, '""')}"`).join(' ');
      joins.push('JOIN posts_fts ON posts_fts.rowid = posts.id');
      where.push('posts_fts MATCH ?');
      params.push(ftsQuery);
    }

    if (type === 'movie') where.push('posts.is_series = 0');
    else if (type === 'series') where.push('posts.is_series = 1');

    if (genre && genre !== 'all') {
      const parts = genre.split(',').map(g => g.trim()).filter(Boolean);
      for (const part of parts) {
        where.push('posts.genre LIKE ?');
        params.push(`%${part}%`);
      }
    }

    if (rating && rating !== 'all') {
      where.push('posts.rating IS NOT NULL AND CAST(posts.rating AS REAL) >= ?');
      params.push(Number(rating));
    }

    if (year && year !== 'all') {
      where.push('posts.year = ?');
      params.push(Number(year));
    }

    if (duration === 'short') where.push('posts.duration_minutes IS NOT NULL AND posts.duration_minutes < 90');
    else if (duration === 'medium') where.push('posts.duration_minutes BETWEEN 90 AND 150');
    else if (duration === 'long') where.push('posts.duration_minutes IS NOT NULL AND posts.duration_minutes > 150');

    if (metadataComplete === 'complete') where.push('posts.metadata_complete = 1');
    else if (metadataComplete === 'incomplete') {
      // "Incomplete" means still-pending/eligible for resync — a post the
      // user has manually flagged as source-incomplete has its own bucket
      // below and is deliberately excluded here.
      where.push('(posts.metadata_complete IS NULL OR posts.metadata_complete = 0)');
      where.push('(posts.metadata_source_incomplete IS NULL OR posts.metadata_source_incomplete = 0)');
    } else if (metadataComplete === 'source-incomplete') {
      where.push('posts.metadata_source_incomplete = 1');
    }

    if (deadLink === 'dead') {
      where.push("EXISTS (SELECT 1 FROM jobs WHERE jobs.post_link = posts.link AND jobs.status = 'dead')");
    } else if (deadLink === 'not-dead') {
      where.push("NOT EXISTS (SELECT 1 FROM jobs WHERE jobs.post_link = posts.link AND jobs.status = 'dead')");
    }

    const hasLinkFilters = (provider && provider !== 'all') || (quality && quality !== 'all') || (codec && codec !== 'all');
    if (hasLinkFilters) {
      const optConds = ['po.post_id = posts.id'];
      const optParams = [];
      if (provider && provider !== 'all') { optConds.push('po.provider = ?'); optParams.push(provider); }
      if (quality && quality !== 'all') { optConds.push('po.quality = ?'); optParams.push(quality); }
      if (codec === 'x265') {
        optConds.push("(po.quality_label LIKE '%x265%' OR po.quality_label LIKE '%hevc%' OR po.quality_label LIKE '%10bit%')");
      } else if (codec === 'x264') {
        optConds.push("NOT (po.quality_label LIKE '%x265%' OR po.quality_label LIKE '%hevc%' OR po.quality_label LIKE '%10bit%')");
      }
      where.push(`EXISTS (SELECT 1 FROM post_options po WHERE ${optConds.join(' AND ')})`);
      params.push(...optParams);
    }

    return {
      joinSql: joins.join(' '),
      whereSql: where.length ? `WHERE ${where.join(' AND ')}` : '',
      params,
    };
  }

  /** Post ids whose content (options/metadata) hasn't been deep-synced yet. */
  listUnsyncedPostIds(limit = 20) {
    return this._stmt.unsyncedPostIds.all(limit).map((r) => r.id);
  }

  countUnsyncedPosts() {
    return this._stmt.countUnsyncedPosts.get().n;
  }

  /** Post ids that have been deep-synced but predate the extended-metadata parser (year/genre/etc). */
  listPostsMissingExtendedMetadata(limit = 20) {
    return this._stmt.missingExtendedMetadataIds.all(limit).map((r) => r.id);
  }

  countPostsMissingExtendedMetadata() {
    return this._stmt.countMissingExtendedMetadata.get().n;
  }

  /** Manually flags (or unflags) a post as "source incomplete" — the user has confirmed pahe.ink's own page never had this metadata, so it's excluded from the batch metadata-backfill sweep. */
  markPostSourceIncomplete(postId, flag) {
    this._stmt.markPostSourceIncomplete.run(flag ? 1 : 0, Number(postId));
  }

  /** Marks a specific download option as having had a dead-link report submitted for it. */
  markOptionReported(postId, url) {
    this._stmt.markOptionReported.run(new Date().toISOString(), Number(postId), url);
  }

  /** Same as markOptionReported, but resolves the post via its link — for job-centric callers that don't reliably carry a postId. Returns true if a matching post_options row was found and updated. */
  markOptionReportedByLink(postLink, url) {
    const result = this._stmt.markOptionReportedByLink.run(new Date().toISOString(), url, postLink);
    return result.changes > 0;
  }

  /**
   * Series posts whose title claims a multi-season range (e.g. "Season 1-7")
   * that goes further than the highest season actually found among their
   * stored options — i.e. pahe.ink added a newer season to the post's page
   * after we last deep-synced it, OR the post has never been (re-)synced
   * since the `season` column was introduced (max_season NULL counts as
   * "not yet confirmed complete", so it's included too). Detected purely
   * from already-stored data (title + post_options.season), no live fetch.
   * Titles with a single season ("Season 3") are skipped — nothing to
   * compare, since a single-season post's options never carry `season`.
   */
  _computeStaleSeriesIds() {
    const staleIds = [];
    for (const row of this._stmt.seriesWithSeasons.all()) {
      const range = parseSeasonRangeFromTitle(row.title);
      if (!range || range.min === range.max) continue;
      if (row.max_season == null || row.max_season < range.max) staleIds.push(row.id);
    }
    return staleIds;
  }

  listStaleSeriesPostIds(limit = 20) {
    return this._computeStaleSeriesIds().slice(0, limit);
  }

  countStaleSeries() {
    return this._computeStaleSeriesIds().length;
  }

  /** Distinct genre/year values present in the archive, for populating filter dropdowns. */
  getPostFacets() {
    const years = this._stmt.distinctYears.all().map((r) => r.year);
    const genreSet = new Set();
    for (const row of this._stmt.distinctGenres.all()) {
      for (const g of row.genre.split(',')) {
        const trimmed = g.trim();
        if (trimmed) genreSet.add(trimmed);
      }
    }
    return { years, genres: [...genreSet].sort((a, b) => a.localeCompare(b)) };
  }

  _hydratePost(row, options) {
    return {
      id: row.id,
      title: row.title,
      link: row.link,
      date: row.date,
      seenAt: row.seen_at,
      poster: row.poster || '',
      rating: row.rating || '',
      synopsis: row.synopsis || '',
      isSeries: row.is_series === null ? null : Boolean(row.is_series),
      pageFound: row.page_found ?? undefined,
      year: row.year ?? null,
      genre: row.genre || '',
      durationMinutes: row.duration_minutes ?? null,
      director: row.director || '',
      creator: row.creator || '',
      actors: row.actors || '',
      metadataComplete: Boolean(row.metadata_complete),
      metadataSourceIncomplete: Boolean(row.metadata_source_incomplete),
      hasDeadJob: row.has_dead_job === undefined ? undefined : Boolean(row.has_dead_job),
      options: options ?? this._stmt.getPostOptions.all(row.id).map((r) => this._hydrateOption(r)),
    };
  }

  _hydrateOption(row) {
    let resolvedUrl = null;
    let resolvedLinkType = null;
    if (row.job_result) {
      try {
        const res = JSON.parse(row.job_result);
        resolvedUrl = res.finalUrl;
        resolvedLinkType = res.linkType;
      } catch (e) {}
    }
    return {
      provider: row.provider,
      providerName: row.provider_name,
      quality: row.quality,
      qualityLabel: row.quality_label,
      season: row.season ?? null,
      sizeLabel: row.size_label,
      url: row.url,
      host: row.host,
      resolvedUrl,
      resolvedLinkType,
      deadReportedAt: row.dead_reported_at ?? null,
    };
  }

  // ── jobs ──
  upsertJob(job) {
    const existing = job.id ? this.getJob(job.id) : null;
    const merged = { ...existing, ...job };

    const extra = {};
    for (const key of Object.keys(merged)) {
      if (!JOB_COLUMN_FIELDS.includes(key)) extra[key] = merged[key];
    }

    this.db.prepare(`
      INSERT INTO jobs (id, status, attempts, created_at, updated_at, post_id, title, post_link, provider,
                         quality, quality_label, size_label, url, logs, result, error, payload_extra)
      VALUES (@id, @status, @attempts, @created_at, @updated_at, @post_id, @title, @post_link, @provider,
              @quality, @quality_label, @size_label, @url, @logs, @result, @error, @payload_extra)
      ON CONFLICT(id) DO UPDATE SET
        status=excluded.status, attempts=excluded.attempts, updated_at=excluded.updated_at,
        post_id=excluded.post_id, title=excluded.title, post_link=excluded.post_link, provider=excluded.provider,
        quality=excluded.quality, quality_label=excluded.quality_label, size_label=excluded.size_label,
        url=excluded.url, logs=excluded.logs, result=excluded.result, error=excluded.error,
        payload_extra=excluded.payload_extra
    `).run({
      id: merged.id,
      status: merged.status ?? null,
      attempts: merged.attempts ?? 0,
      created_at: merged.createdAt ?? new Date().toISOString(),
      updated_at: merged.updatedAt ?? new Date().toISOString(),
      post_id: merged.postId ?? null,
      title: merged.title ?? null,
      post_link: merged.postLink ?? null,
      provider: merged.provider ?? null,
      quality: merged.quality ?? null,
      quality_label: merged.qualityLabel ?? null,
      size_label: merged.sizeLabel ?? null,
      url: merged.url ?? null,
      logs: JSON.stringify(merged.logs ?? []),
      result: merged.result === undefined ? null : JSON.stringify(merged.result),
      error: merged.error ?? null,
      payload_extra: Object.keys(extra).length ? JSON.stringify(extra) : null,
    });

    return this.getJob(merged.id);
  }

  deleteJob(id) {
    const res = this._stmt.deleteJob.run(id);
    return res.changes > 0;
  }

  getJob(id) {
    const row = this._stmt.getJob.get(id);
    if (!row) return null;
    return this._hydrateJob(row);
  }

  listJobs() {
    return this._stmt.allJobs.all().map((row) => this._hydrateJob(row));
  }

  countJobs() {
    return this._stmt.countJobs.get().n;
  }

  /** Paginated jobs for the GUI list. Returns { items, total }. */
  queryJobs({ limit = 30, offset = 0 } = {}) {
    const total = this.countJobs();
    const rows = this.db.prepare('SELECT * FROM jobs ORDER BY created_at DESC LIMIT ? OFFSET ?').all(limit, offset);
    return { items: rows.map((row) => this._hydrateJob(row)), total };
  }

  _hydrateJob(row) {
    const extra = row.payload_extra ? JSON.parse(row.payload_extra) : {};
    return {
      ...extra,
      id: row.id,
      status: row.status,
      attempts: row.attempts,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      postId: row.post_id ?? undefined,
      title: row.title ?? undefined,
      postLink: row.post_link ?? undefined,
      provider: row.provider ?? undefined,
      quality: row.quality ?? undefined,
      qualityLabel: row.quality_label ?? undefined,
      sizeLabel: row.size_label ?? undefined,
      url: row.url ?? undefined,
      logs: row.logs ? JSON.parse(row.logs) : [],
      result: row.result ? JSON.parse(row.result) : null,
      error: row.error ?? null,
    };
  }

  // ── meta ──
  getMeta(key, fallback = null) {
    const row = this._stmt.getMeta.get(key);
    if (!row) return fallback;
    try {
      return JSON.parse(row.value);
    } catch {
      return row.value;
    }
  }

  setMeta(key, value) {
    this._stmt.setMeta.run(key, JSON.stringify(value));
  }
}

export default Store;
