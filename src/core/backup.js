import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';

const MANIFEST_VERSION = 1;

/**
 * Builds a downloadable zip snapshot of everything needed to fully restore
 * this instance: the SQLite database (posts, jobs, and every runtime config
 * override — they all live in the `meta` table) plus the Google Sheets
 * service-account key file, if one has been uploaded. Uses SQLite's own
 * VACUUM INTO to take a consistent snapshot without pausing the live app or
 * touching the real db/-wal/-shm files directly.
 */
export function buildBackupZip({ store, runtime }) {
  const zip = new AdmZip();
  const tmpDbPath = path.join(os.tmpdir(), `pahe-backup-${Date.now()}-${process.pid}.db`);
  fs.rmSync(tmpDbPath, { force: true });
  try {
    store.db.exec(`VACUUM INTO '${tmpDbPath.replace(/'/g, "''")}'`);
    zip.addLocalFile(tmpDbPath, '', 'pahe.db');
  } finally {
    fs.rmSync(tmpDbPath, { force: true });
  }

  const keyPath = runtime.sheets?.serviceAccountKey;
  if (keyPath && fs.existsSync(keyPath)) {
    zip.addLocalFile(keyPath, 'credentials', path.basename(keyPath));
  }

  zip.addFile('manifest.json', Buffer.from(JSON.stringify({
    version: MANIFEST_VERSION,
    exportedAt: new Date().toISOString(),
  }, null, 2)));

  return zip.toBuffer();
}

/**
 * Validates an uploaded zip and replaces the live database file (and, if
 * present, the Sheets service-account key) on disk. Does NOT touch the
 * running Store — node:sqlite holds an open file handle on the old db, so
 * the caller must close it and restart the process afterward for the
 * replacement to take effect.
 */
export function restoreBackupZip(buffer, { sqlitePath, serviceAccountKeyPath }) {
  const zip = new AdmZip(buffer);
  const dbEntry = zip.getEntry('pahe.db');
  if (!dbEntry) throw new Error('Zip does not contain a pahe.db — not a valid pahe-watcher backup');

  fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });
  fs.writeFileSync(sqlitePath, zip.readFile(dbEntry));
  // Stale WAL/SHM from the previous db would otherwise get replayed against
  // the freshly-restored file on next open and corrupt it.
  for (const ext of ['-wal', '-shm']) {
    fs.rmSync(sqlitePath + ext, { force: true });
  }

  const keyEntry = zip.getEntries().find((e) => !e.isDirectory && e.entryName.startsWith('credentials/'));
  if (keyEntry && serviceAccountKeyPath) {
    fs.mkdirSync(path.dirname(serviceAccountKeyPath), { recursive: true });
    fs.writeFileSync(serviceAccountKeyPath, zip.readFile(keyEntry));
  }
}

export default { buildBackupZip, restoreBackupZip };
