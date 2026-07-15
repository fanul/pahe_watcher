/**
 * SQLite schema for the local pahe.ink post/job archive.
 *
 * `posts.id` is the WP post id used directly as SQLite's rowid alias — this
 * is required for the FTS5 `content_rowid` trick below, and means every
 * upsert-as-update on `posts` naturally fires the sync trigger, including
 * from any future ad-hoc SQL (e.g. MCP tools), with no special-case code.
 *
 * `post_embeddings` is a plain table, not a `vec0` virtual table — it
 * reserves the shape for real vector search later (via the `sqlite-vec`
 * loadable extension, which `node:sqlite`'s `db.loadExtension` supports) but
 * requires no extension to be loaded today, since no embedding provider is
 * wired up yet. See ARCHITECTURE.md for the activation steps.
 */
export const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS posts (
  id                 INTEGER PRIMARY KEY,
  title              TEXT NOT NULL,
  link               TEXT NOT NULL,
  date               TEXT NOT NULL,
  seen_at            TEXT NOT NULL,
  poster             TEXT,
  rating             TEXT,
  synopsis           TEXT,
  is_series          INTEGER,
  page_found         INTEGER,
  content_synced_at  TEXT,
  year               INTEGER,
  genre              TEXT,
  duration_minutes   INTEGER,
  director           TEXT,
  creator            TEXT,
  actors             TEXT,
  metadata_complete  INTEGER
);

CREATE TABLE IF NOT EXISTS post_options (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id        INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  sort_order     INTEGER NOT NULL,
  provider       TEXT,
  provider_name  TEXT,
  quality        TEXT,
  quality_label  TEXT,
  season         INTEGER,
  size_label     TEXT,
  url            TEXT,
  host           TEXT,
  dead_reported_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_post_options_post_id ON post_options(post_id);

CREATE TABLE IF NOT EXISTS jobs (
  id             TEXT PRIMARY KEY,
  status         TEXT NOT NULL,
  attempts       INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  post_id        INTEGER,
  title          TEXT,
  post_link      TEXT,
  provider       TEXT,
  quality        TEXT,
  quality_label  TEXT,
  size_label     TEXT,
  url            TEXT,
  logs           TEXT,
  result         TEXT,
  error          TEXT,
  payload_extra  TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON jobs(created_at);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);

CREATE TABLE IF NOT EXISTS meta (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS post_embeddings (
  post_id      INTEGER PRIMARY KEY REFERENCES posts(id) ON DELETE CASCADE,
  model        TEXT,
  dims         INTEGER,
  embedding    BLOB,
  embedded_at  TEXT
);
`;

/**
 * Columns added to `posts` after the initial release. Applied via idempotent
 * ALTER TABLE for pre-existing databases (fresh installs already get them from
 * SCHEMA_SQL's CREATE TABLE above — PRAGMA table_info finds nothing missing).
 */
const NEW_POST_COLUMNS = {
  year: 'INTEGER',
  genre: 'TEXT',
  duration_minutes: 'INTEGER',
  director: 'TEXT',
  creator: 'TEXT',
  actors: 'TEXT',
  metadata_complete: 'INTEGER',
  // Manual override: the user has confirmed pahe.ink's own page for this
  // post never had this metadata (not a parser gap) — excludes it from the
  // batch "Resync incomplete metadata" sweep so it isn't refetched forever.
  metadata_source_incomplete: 'INTEGER',
};

function migratePostsColumns(db) {
  const existing = new Set(db.prepare('PRAGMA table_info(posts)').all().map((r) => r.name));
  for (const [col, type] of Object.entries(NEW_POST_COLUMNS)) {
    if (!existing.has(col)) {
      db.exec(`ALTER TABLE posts ADD COLUMN ${col} ${type}`);
    }
  }
}

/** Columns added to `post_options` after the initial release — same idempotent ALTER TABLE pattern. */
const NEW_POST_OPTION_COLUMNS = {
  season: 'INTEGER',
  dead_reported_at: 'TEXT',
};

function migratePostOptionsColumns(db) {
  const existing = new Set(db.prepare('PRAGMA table_info(post_options)').all().map((r) => r.name));
  for (const [col, type] of Object.entries(NEW_POST_OPTION_COLUMNS)) {
    if (!existing.has(col)) {
      db.exec(`ALTER TABLE post_options ADD COLUMN ${col} ${type}`);
    }
  }
}

/**
 * `posts_fts` columns. Kept as a single source of truth for the CREATE TABLE,
 * the three sync triggers, and the rebuild-migration's repopulate INSERT.
 */
const FTS_COLUMNS = ['title', 'synopsis', 'director', 'creator', 'actors'];

function ftsSql() {
  const cols = FTS_COLUMNS.join(', ');
  const newVals = FTS_COLUMNS.map((c) => `new.${c}`).join(', ');
  const oldVals = FTS_COLUMNS.map((c) => `old.${c}`).join(', ');
  return `
    CREATE VIRTUAL TABLE IF NOT EXISTS posts_fts USING fts5(
      ${cols}, content='posts', content_rowid='id'
    );
    CREATE TRIGGER IF NOT EXISTS posts_ai AFTER INSERT ON posts BEGIN
      INSERT INTO posts_fts(rowid, ${cols}) VALUES (new.id, ${newVals});
    END;
    CREATE TRIGGER IF NOT EXISTS posts_ad AFTER DELETE ON posts BEGIN
      INSERT INTO posts_fts(posts_fts, rowid, ${cols}) VALUES('delete', old.id, ${oldVals});
    END;
    CREATE TRIGGER IF NOT EXISTS posts_au AFTER UPDATE ON posts BEGIN
      INSERT INTO posts_fts(posts_fts, rowid, ${cols}) VALUES('delete', old.id, ${oldVals});
      INSERT INTO posts_fts(rowid, ${cols}) VALUES (new.id, ${newVals});
    END;
  `;
}

/**
 * FTS5 virtual tables can't ALTER ADD COLUMN, so a pre-existing `posts_fts`
 * from before director/creator/actors were indexed gets dropped (with its
 * sync triggers) and rebuilt from the current `posts` table in one shot.
 * No-op once the table already has the current column set.
 */
function migratePostsFts(db) {
  const existingCols = db.prepare('PRAGMA table_info(posts_fts)').all().map((r) => r.name);
  const isCurrent = existingCols.length > 0 && FTS_COLUMNS.every((c) => existingCols.includes(c));
  if (isCurrent) return;

  if (existingCols.length > 0) {
    db.exec(`
      DROP TRIGGER IF EXISTS posts_ai;
      DROP TRIGGER IF EXISTS posts_ad;
      DROP TRIGGER IF EXISTS posts_au;
      DROP TABLE IF EXISTS posts_fts;
    `);
  }
  db.exec(ftsSql());
  if (existingCols.length > 0) {
    const cols = FTS_COLUMNS.join(', ');
    db.exec(`INSERT INTO posts_fts(rowid, ${cols}) SELECT id, ${cols} FROM posts`);
  }
}

/** Apply the schema to an open node:sqlite DatabaseSync instance. Idempotent. */
export function applySchema(db) {
  db.exec(SCHEMA_SQL);
  migratePostsColumns(db);
  migratePostOptionsColumns(db);
  migratePostsFts(db);
}

export default applySchema;
