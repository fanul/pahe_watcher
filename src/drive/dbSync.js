import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createLogger } from '../core/logger.js';

const log = createLogger('dbSync');

// Requested: a project-local ./temp directory rather than the OS tmp dir —
// easier to find and inspect by hand if a sync ever needs debugging.
// Cleaned up (files removed) after every sync, success or failure; the
// directory itself is left in place.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMP_DIR = path.resolve(__dirname, '..', '..', 'temp');

// One canonical file in the configured Drive folder, overwritten every
// sync (via DriveBackupClient#uploadOrReplace) — this is a two-way mirror
// of content, not a point-in-time backup, so there's no reason to keep old
// versions around the way the timestamped zip backups do.
export const SYNC_FILENAME = 'pahe-watcher-sync.db';

// Only "content" tables round-trip through Drive. Deliberately excludes:
//  - `meta`: holds every runtime config override, including PLAINTEXT
//    credentials (Google cookies, JDownloader password, Drive OAuth client
//    secret/refresh token). Syncing this would upload secrets to Drive and
//    overwrite one machine's settings with another's — neither is what
//    "sync my post/job history" means.
//  - `post_embeddings` / `shortlink_cache`: derived/local caches, not user
//    content — cheap to regenerate, not worth the sync complexity.
const SYNCED_TABLES = ['posts', 'post_options', 'jobs'];

/**
 * Exports just the synced tables (schema + data, no triggers/FTS/PRAGMAs)
 * into a fresh standalone SQLite file via ATTACH + CREATE TABLE AS SELECT —
 * a consistent snapshot without touching the live db's WAL/SHM files, and
 * without ever writing `meta` or anything else outside SYNCED_TABLES to
 * disk in a form that could leave this process.
 */
function buildExportFile(store) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
  const tmpPath = path.join(TEMP_DIR, `sync-export-${Date.now()}-${process.pid}.db`);
  fs.rmSync(tmpPath, { force: true });
  const escaped = tmpPath.replace(/'/g, "''");
  store.db.exec(`ATTACH DATABASE '${escaped}' AS sync_export`);
  try {
    for (const table of SYNCED_TABLES) {
      store.db.exec(`CREATE TABLE sync_export.${table} AS SELECT * FROM main.${table}`);
    }
  } finally {
    store.db.exec('DETACH DATABASE sync_export');
  }
  return tmpPath;
}

function columnsOf(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name);
}

/**
 * Presence-based merge for a table with a stable, collision-safe primary
 * key shared across both databases (posts.id is pahe.ink's own WordPress
 * post id — the same real post has the same id everywhere; jobs.id is a
 * UUID). A row missing locally gets copied in verbatim; a row that already
 * exists on both sides is left untouched — this fills gaps, it doesn't
 * arbitrate which side's edit of the same row "wins" (not what was asked
 * for, and not needed for how this app actually uses these tables).
 * Returns the set of ids that were newly inserted.
 */
function mergeByPrimaryKey(localDb, remoteDb, table, idCol = 'id') {
  const localIds = new Set(localDb.prepare(`SELECT ${idCol} AS id FROM ${table}`).all().map((r) => r.id));
  const remoteRows = remoteDb.prepare(`SELECT * FROM ${table}`).all();
  const cols = columnsOf(localDb, table);
  const insertStmt = localDb.prepare(
    `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
  );

  const inserted = new Set();
  for (const row of remoteRows) {
    if (localIds.has(row[idCol])) continue;
    insertStmt.run(...cols.map((c) => (c in row ? row[c] : null)));
    inserted.add(row[idCol]);
  }
  return inserted;
}

/**
 * post_options has no identity that's safe to merge by raw id — it's a
 * local AUTOINCREMENT counter, not a value shared meaningfully between two
 * independently-running databases (two unrelated rows on each side can
 * legitimately share the same numeric id). Instead of risking a PK
 * collision or silently dropping real rows on a false "already present"
 * match, this only ever copies options belonging to a post that was JUST
 * pulled in by mergeByPrimaryKey above (newlyPulledPostIds) — inserted
 * with a fresh, locally-assigned id (the `id` column is left out of the
 * INSERT on purpose). Posts that already existed on both sides keep
 * whatever options they already have locally; those stay accurate via this
 * app's own normal deep-sync/watcher cycle, not this sync feature.
 */
function copyOptionsForNewPosts(localDb, remoteDb, newlyPulledPostIds) {
  if (newlyPulledPostIds.size === 0) return 0;
  const cols = columnsOf(localDb, 'post_options').filter((c) => c !== 'id');
  const insertStmt = localDb.prepare(
    `INSERT INTO post_options (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
  );
  const remoteRows = remoteDb.prepare('SELECT * FROM post_options').all();
  let copied = 0;
  for (const row of remoteRows) {
    if (!newlyPulledPostIds.has(row.post_id)) continue;
    insertStmt.run(...cols.map((c) => (c in row ? row[c] : null)));
    copied += 1;
  }
  return copied;
}

/**
 * Two-way content sync against the configured Google Drive folder — pulls
 * whatever's on Drive but missing locally into the live database, then
 * pushes the resulting (now-merged) local content back to Drive, so both
 * ends end up with the union of what either side had. Safe to call
 * repeatedly / on a machine that's never synced before (first run just
 * pushes everything local, since there's nothing to pull yet).
 *
 * @param {object} deps
 * @param {import('../core/store.js').Store} deps.store
 * @param {import('./driveBackupClient.js').DriveBackupClient} deps.driveBackup
 * @returns {Promise<{pulled: {posts:number, jobs:number, postOptions:number}, uploaded: boolean}>}
 */
export async function syncDatabaseWithDrive({ store, driveBackup }) {
  if (!driveBackup?.enabled) {
    throw new Error('Drive backup is not configured yet (Settings → Backup & Restore).');
  }

  const pulled = { posts: 0, jobs: 0, postOptions: 0 };
  const remoteBuffer = await driveBackup.downloadByName(SYNC_FILENAME);

  if (remoteBuffer) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
    const tmpRemotePath = path.join(TEMP_DIR, `sync-remote-${Date.now()}-${process.pid}.db`);
    fs.writeFileSync(tmpRemotePath, remoteBuffer);
    try {
      const remoteDb = new DatabaseSync(tmpRemotePath, { readOnly: true });
      try {
        const newPostIds = mergeByPrimaryKey(store.db, remoteDb, 'posts', 'id');
        pulled.posts = newPostIds.size;
        pulled.postOptions = copyOptionsForNewPosts(store.db, remoteDb, newPostIds);
        pulled.jobs = mergeByPrimaryKey(store.db, remoteDb, 'jobs', 'id').size;
      } finally {
        remoteDb.close();
      }
    } finally {
      fs.rmSync(tmpRemotePath, { force: true });
    }
  } else {
    log.info('No existing sync file on Drive yet — this will be the first push.');
  }

  const exportPath = buildExportFile(store);
  try {
    const buffer = fs.readFileSync(exportPath);
    await driveBackup.uploadOrReplace(buffer, SYNC_FILENAME);
  } finally {
    fs.rmSync(exportPath, { force: true });
  }

  log.info('Database sync with Drive complete', pulled);
  return { pulled, uploaded: true };
}

export default syncDatabaseWithDrive;
