import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createLogger } from './logger.js';
import { applySchema } from './db/schema.js';
import { migrateJsonStateIfNeeded } from './db/migrateJsonState.js';

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

    this._stmt = {
      hasSeenPost: this.db.prepare('SELECT 1 FROM posts WHERE id = ?'),
      getPost: this.db.prepare('SELECT * FROM posts WHERE id = ?'),
      getPostOptions: this.db.prepare('SELECT * FROM post_options WHERE post_id = ? ORDER BY sort_order'),
      allPosts: this.db.prepare('SELECT * FROM posts ORDER BY date DESC'),
      allPostOptions: this.db.prepare('SELECT * FROM post_options ORDER BY post_id, sort_order'),
      deletePostOptions: this.db.prepare('DELETE FROM post_options WHERE post_id = ?'),
      insertOption: this.db.prepare(
        `INSERT INTO post_options (post_id, sort_order, provider, provider_name, quality, quality_label, size_label, url, host)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      upsertPost: this.db.prepare(`
        INSERT INTO posts (id, title, link, date, seen_at, poster, rating, synopsis, is_series, page_found, content_synced_at,
                            year, genre, duration_minutes, director, creator, actors)
        VALUES (@id, @title, @link, @date, @seen_at, @poster, @rating, @synopsis, @is_series, @page_found, @content_synced_at,
                @year, @genre, @duration_minutes, @director, @creator, @actors)
        ON CONFLICT(id) DO UPDATE SET
          title=excluded.title, link=excluded.link, date=excluded.date, seen_at=excluded.seen_at,
          poster=excluded.poster, rating=excluded.rating, synopsis=excluded.synopsis,
          is_series=excluded.is_series, page_found=excluded.page_found, content_synced_at=excluded.content_synced_at,
          year=excluded.year, genre=excluded.genre, duration_minutes=excluded.duration_minutes,
          director=excluded.director, creator=excluded.creator, actors=excluded.actors
      `),
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
      missingExtendedMetadataIds: this.db.prepare(
        'SELECT id FROM posts WHERE content_synced_at IS NOT NULL AND year IS NULL AND genre IS NULL ORDER BY id ASC LIMIT ?',
      ),
      countMissingExtendedMetadata: this.db.prepare(
        'SELECT COUNT(*) AS n FROM posts WHERE content_synced_at IS NOT NULL AND year IS NULL AND genre IS NULL',
      ),
      distinctYears: this.db.prepare('SELECT DISTINCT year FROM posts WHERE year IS NOT NULL ORDER BY year DESC'),
      distinctGenres: this.db.prepare("SELECT DISTINCT genre FROM posts WHERE genre IS NOT NULL AND genre != ''"),
    };

    log.info('SQLite store ready', { path: sqlitePath, posts: this.countPosts(), jobs: this.countJobs() });
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
      });
      this._stmt.deletePostOptions.run(id);
      options.forEach((opt, i) => {
        this._stmt.insertOption.run(
          id, i,
          opt.provider ?? null, opt.providerName ?? null, opt.quality ?? null,
          opt.qualityLabel ?? null, opt.sizeLabel ?? null, opt.url ?? null, opt.host ?? null,
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
    genre = 'all', year = 'all', duration = 'all', sort = 'date_desc',
  } = {}) {
    const { joinSql, whereSql, params } = this._buildPostsFilter({ search, type, provider, quality, codec, genre, year, duration });
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
        .prepare(`SELECT * FROM post_options WHERE post_id IN (${placeholders}) ORDER BY post_id, sort_order`)
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

  _buildPostsFilter({ search, type, provider, quality, codec, genre = 'all', year = 'all', duration = 'all' }) {
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
      where.push('posts.genre LIKE ?');
      params.push(`%${genre}%`);
    }

    if (year && year !== 'all') {
      where.push('posts.year = ?');
      params.push(Number(year));
    }

    if (duration === 'short') where.push('posts.duration_minutes IS NOT NULL AND posts.duration_minutes < 90');
    else if (duration === 'medium') where.push('posts.duration_minutes BETWEEN 90 AND 150');
    else if (duration === 'long') where.push('posts.duration_minutes IS NOT NULL AND posts.duration_minutes > 150');

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
      hasDeadJob: row.has_dead_job === undefined ? undefined : Boolean(row.has_dead_job),
      options: options ?? this._stmt.getPostOptions.all(row.id).map((r) => this._hydrateOption(r)),
    };
  }

  _hydrateOption(row) {
    return {
      provider: row.provider,
      providerName: row.provider_name,
      quality: row.quality,
      qualityLabel: row.quality_label,
      sizeLabel: row.size_label,
      url: row.url,
      host: row.host,
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
