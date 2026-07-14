import fs from 'node:fs';

const SENTINEL_KEY = 'migration.jsonState.completedAt';

const JOB_COLUMN_FIELDS = new Set([
  'id', 'status', 'attempts', 'createdAt', 'updatedAt', 'postId', 'title',
  'postLink', 'provider', 'quality', 'qualityLabel', 'sizeLabel', 'url', 'logs', 'result', 'error',
]);

/**
 * One-time import of the legacy JSON store (`data/state.json`) into the new
 * SQLite database. Idempotent — checks a sentinel meta row so it only ever
 * runs once, even across restarts. Only renames the JSON file to
 * `.migrated` (never deletes it) once the import transaction has committed
 * successfully. Operates on the raw `db` handle directly (called from
 * Store's constructor, before Store's own prepared statements exist).
 */
export function migrateJsonStateIfNeeded(db, jsonPath, log) {
  const already = db.prepare('SELECT value FROM meta WHERE key = ?').get(SENTINEL_KEY);
  if (already) return;

  if (!jsonPath || !fs.existsSync(jsonPath)) {
    setSentinel(db, { source: 'no-file-found' });
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  } catch (err) {
    log?.error('Failed to read legacy state.json for migration — will retry next boot', { error: String(err) });
    return; // no sentinel written; retried next boot
  }

  const posts = parsed.posts || {};
  const jobs = parsed.jobs || {};
  const meta = parsed.meta || {};

  db.exec('BEGIN');
  try {
    const upsertPost = db.prepare(`
      INSERT INTO posts (id, title, link, date, seen_at, poster, rating, synopsis, is_series, page_found, content_synced_at)
      VALUES (@id, @title, @link, @date, @seen_at, @poster, @rating, @synopsis, @is_series, @page_found, @content_synced_at)
      ON CONFLICT(id) DO UPDATE SET
        title=excluded.title, link=excluded.link, date=excluded.date, seen_at=excluded.seen_at,
        poster=excluded.poster, rating=excluded.rating, synopsis=excluded.synopsis,
        is_series=excluded.is_series, page_found=excluded.page_found, content_synced_at=excluded.content_synced_at
    `);
    const insertOption = db.prepare(`
      INSERT INTO post_options (post_id, sort_order, provider, provider_name, quality, quality_label, size_label, url, host)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const post of Object.values(posts)) {
      const id = Number(post.id);
      const options = post.options || [];
      const seenAt = post.seenAt || new Date().toISOString();
      const hasContent = options.length > 0 || Boolean(post.synopsis);
      upsertPost.run({
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
      });
      options.forEach((opt, i) => {
        insertOption.run(
          id, i,
          opt.provider ?? null, opt.providerName ?? null, opt.quality ?? null,
          opt.qualityLabel ?? null, opt.sizeLabel ?? null, opt.url ?? null, opt.host ?? null,
        );
      });
    }

    const upsertJob = db.prepare(`
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
    `);
    for (const job of Object.values(jobs)) {
      const extra = {};
      for (const key of Object.keys(job)) {
        if (!JOB_COLUMN_FIELDS.has(key)) extra[key] = job[key];
      }
      upsertJob.run({
        id: job.id,
        status: job.status ?? null,
        attempts: job.attempts ?? 0,
        created_at: job.createdAt ?? new Date().toISOString(),
        updated_at: job.updatedAt ?? new Date().toISOString(),
        post_id: job.postId ?? null,
        title: job.title ?? null,
        post_link: job.postLink ?? null,
        provider: job.provider ?? null,
        quality: job.quality ?? null,
        quality_label: job.qualityLabel ?? null,
        size_label: job.sizeLabel ?? null,
        url: job.url ?? null,
        logs: JSON.stringify(job.logs ?? []),
        result: job.result === undefined ? null : JSON.stringify(job.result),
        error: job.error ?? null,
        payload_extra: Object.keys(extra).length ? JSON.stringify(extra) : null,
      });
    }

    const setMeta = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
    for (const [key, value] of Object.entries(meta)) {
      setMeta.run(key, JSON.stringify(value));
    }

    setSentinel(db, {
      source: 'state.json',
      postsImported: Object.keys(posts).length,
      jobsImported: Object.keys(jobs).length,
    });

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    log?.error('JSON state migration failed, will retry next boot', { error: String(err) });
    return; // no sentinel committed; retried next boot
  }

  log?.info('Migrated legacy state.json into SQLite', {
    posts: Object.keys(posts).length,
    jobs: Object.keys(jobs).length,
  });

  try {
    fs.renameSync(jsonPath, `${jsonPath}.migrated`);
  } catch (err) {
    log?.warn('Migration succeeded but could not rename state.json to .migrated', { error: String(err) });
  }
}

function setSentinel(db, extra) {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(
    SENTINEL_KEY,
    JSON.stringify({ completedAt: new Date().toISOString(), ...extra }),
  );
}

export default migrateJsonStateIfNeeded;
