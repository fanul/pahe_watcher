import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import AdmZip from 'adm-zip';
import { Store } from '../src/core/store.js';
import { buildBackupZip, restoreBackupZip } from '../src/core/backup.js';

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pahe-backup-test-'));
  const sqlitePath = path.join(dir, 'test.db');
  const jsonPath = path.join(dir, 'nonexistent-state.json');
  const store = new Store({ sqlitePath, jsonPath });
  return { store, dir, sqlitePath };
}

test('buildBackupZip produces a zip containing pahe.db and a manifest, with the post data intact', (t) => {
  const { store, dir } = tmpStore();
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  store.markPost({ id: 1, title: 'Backup Me', link: 'https://pahe.ink/backup-me', date: '2026-01-01', options: [] });
  store.setMeta('configOverrides', { watcher: { autoResolve: false } });

  const buffer = buildBackupZip({ store, runtime: { sheets: { serviceAccountKey: path.join(dir, 'nonexistent-key.json') } } });
  const zip = new AdmZip(buffer);

  assert.ok(zip.getEntry('pahe.db'), 'zip contains pahe.db');
  assert.ok(zip.getEntry('manifest.json'), 'zip contains manifest.json');

  const manifest = JSON.parse(zip.readAsText('manifest.json'));
  assert.equal(manifest.version, 1);
  assert.ok(manifest.exportedAt);

  // The zipped db is a real, independently-openable SQLite file with the same data.
  const snapshotPath = path.join(dir, 'snapshot.db');
  fs.writeFileSync(snapshotPath, zip.readFile('pahe.db'));
  const snapshotStore = new Store({ sqlitePath: snapshotPath, jsonPath: path.join(dir, 'nonexistent2.json') });
  const post = snapshotStore.getPost(1);
  assert.equal(post.title, 'Backup Me');
  assert.deepEqual(snapshotStore.getMeta('configOverrides'), { watcher: { autoResolve: false } });
  snapshotStore.close();
});

test('buildBackupZip includes the Sheets service-account key file when present', (t) => {
  const { store, dir } = tmpStore();
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  const keyPath = path.join(dir, 'credentials', 'google-service-account.json');
  fs.mkdirSync(path.dirname(keyPath), { recursive: true });
  fs.writeFileSync(keyPath, JSON.stringify({ client_email: 'svc@example.iam.gserviceaccount.com' }));

  const buffer = buildBackupZip({ store, runtime: { sheets: { serviceAccountKey: keyPath } } });
  const zip = new AdmZip(buffer);
  const entry = zip.getEntries().find((e) => e.entryName.startsWith('credentials/'));
  assert.ok(entry, 'zip contains the service-account key under credentials/');
  assert.match(zip.readAsText(entry), /svc@example\.iam\.gserviceaccount\.com/);
});

test('restoreBackupZip rejects a zip with no pahe.db entry', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pahe-backup-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const zip = new AdmZip();
  zip.addFile('not-a-db.txt', Buffer.from('nope'));
  assert.throws(
    () => restoreBackupZip(zip.toBuffer(), { sqlitePath: path.join(dir, 'restored.db') }),
    /pahe\.db/,
  );
});

test('restoreBackupZip writes the db to sqlitePath, clears stale -wal/-shm, and restores the key file', (t) => {
  const { store, dir } = tmpStore();
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  store.markPost({ id: 2, title: 'Restore Me', link: 'https://pahe.ink/restore-me', date: '2026-01-02', options: [] });

  const keyPath = path.join(dir, 'src-credentials', 'key.json');
  fs.mkdirSync(path.dirname(keyPath), { recursive: true });
  fs.writeFileSync(keyPath, JSON.stringify({ client_email: 'restore@example.com' }));

  const buffer = buildBackupZip({ store, runtime: { sheets: { serviceAccountKey: keyPath } } });

  const restoreDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pahe-backup-restore-'));
  t.after(() => fs.rmSync(restoreDir, { recursive: true, force: true }));
  const restoredDbPath = path.join(restoreDir, 'pahe.db');
  const restoredKeyPath = path.join(restoreDir, 'credentials', 'google-service-account.json');
  // Stale WAL/SHM from a "previous" db at the same path — must be cleared, not replayed.
  fs.writeFileSync(`${restoredDbPath}-wal`, 'stale-wal');
  fs.writeFileSync(`${restoredDbPath}-shm`, 'stale-shm');

  restoreBackupZip(buffer, { sqlitePath: restoredDbPath, serviceAccountKeyPath: restoredKeyPath });

  assert.ok(fs.existsSync(restoredDbPath));
  assert.ok(!fs.existsSync(`${restoredDbPath}-wal`), 'stale -wal removed');
  assert.ok(!fs.existsSync(`${restoredDbPath}-shm`), 'stale -shm removed');
  assert.match(fs.readFileSync(restoredKeyPath, 'utf8'), /restore@example\.com/);

  const restoredStore = new Store({ sqlitePath: restoredDbPath, jsonPath: path.join(restoreDir, 'nonexistent.json') });
  assert.equal(restoredStore.getPost(2).title, 'Restore Me');
  restoredStore.close();
});
