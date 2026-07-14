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
  content_synced_at  TEXT
);

CREATE TABLE IF NOT EXISTS post_options (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id        INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  sort_order     INTEGER NOT NULL,
  provider       TEXT,
  provider_name  TEXT,
  quality        TEXT,
  quality_label  TEXT,
  size_label     TEXT,
  url            TEXT,
  host           TEXT
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

CREATE VIRTUAL TABLE IF NOT EXISTS posts_fts USING fts5(
  title, synopsis, content='posts', content_rowid='id'
);
CREATE TRIGGER IF NOT EXISTS posts_ai AFTER INSERT ON posts BEGIN
  INSERT INTO posts_fts(rowid, title, synopsis) VALUES (new.id, new.title, new.synopsis);
END;
CREATE TRIGGER IF NOT EXISTS posts_ad AFTER DELETE ON posts BEGIN
  INSERT INTO posts_fts(posts_fts, rowid, title, synopsis) VALUES('delete', old.id, old.title, old.synopsis);
END;
CREATE TRIGGER IF NOT EXISTS posts_au AFTER UPDATE ON posts BEGIN
  INSERT INTO posts_fts(posts_fts, rowid, title, synopsis) VALUES('delete', old.id, old.title, old.synopsis);
  INSERT INTO posts_fts(rowid, title, synopsis) VALUES (new.id, new.title, new.synopsis);
END;

CREATE TABLE IF NOT EXISTS post_embeddings (
  post_id      INTEGER PRIMARY KEY REFERENCES posts(id) ON DELETE CASCADE,
  model        TEXT,
  dims         INTEGER,
  embedding    BLOB,
  embedded_at  TEXT
);
`;

/** Apply the schema to an open node:sqlite DatabaseSync instance. Idempotent. */
export function applySchema(db) {
  db.exec(SCHEMA_SQL);
}

export default applySchema;
