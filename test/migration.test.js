import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Store } from '../src/core/store.js';

const FIXTURE = {
  posts: {
    1001: {
      id: 1001, title: 'Migrated Movie One', link: 'https://pahe.ink/movie-one', date: '2026-06-01T00:00:00',
      seenAt: '2026-06-01T00:05:00', options: [
        { provider: 'GD', providerName: 'GDFlix', quality: '1080p', qualityLabel: '1080p x265', sizeLabel: '1.5 GB', url: 'https://x.com/1', host: 'x.com' },
      ],
      poster: '', rating: '8.0', synopsis: 'A migrated synopsis about dragons', isSeries: false,
    },
    1002: {
      id: 1002, title: 'Migrated Series Two', link: 'https://pahe.ink/series-two', date: '2026-06-02T00:00:00',
      seenAt: '2026-06-02T00:05:00', options: [], poster: '', rating: '', synopsis: '', isSeries: true,
    },
  },
  jobs: {
    'job-abc': {
      id: 'job-abc', status: 'done', attempts: 1, createdAt: '2026-06-01T01:00:00', updatedAt: '2026-06-01T01:05:00',
      logs: [{ ts: '2026-06-01T01:00:00', msg: 'started' }], result: { finalUrl: 'https://drive.google.com/migrated' }, error: null,
      postId: 1001, title: 'Migrated Movie One', postLink: 'https://pahe.ink/movie-one', provider: 'GD', quality: '1080p', url: 'https://x.com/1',
    },
  },
  meta: {
    lastPollAt: '2026-06-02T12:00:00Z',
    configOverrides: { watcher: { pollIntervalSeconds: 600 } },
  },
};

function setupFixtureDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pahe-migration-test-'));
  const jsonPath = path.join(dir, 'state.json');
  const sqlitePath = path.join(dir, 'test.db');
  fs.writeFileSync(jsonPath, JSON.stringify(FIXTURE, null, 2));
  return { dir, jsonPath, sqlitePath };
}

test('migrates posts, options, jobs, and meta from legacy state.json', (t) => {
  const { dir, jsonPath, sqlitePath } = setupFixtureDir();
  const store = new Store({ sqlitePath, jsonPath });
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  assert.equal(store.countPosts(), 2);
  assert.equal(store.countJobs(), 1);

  const post1001 = store.getPost(1001);
  assert.equal(post1001.title, 'Migrated Movie One');
  assert.equal(post1001.options.length, 1);
  assert.equal(post1001.options[0].url, 'https://x.com/1');
  assert.equal(post1001.synopsis, 'A migrated synopsis about dragons');

  const post1002 = store.getPost(1002);
  assert.deepEqual(post1002.options, []);
  assert.equal(post1002.isSeries, true);

  const job = store.getJob('job-abc');
  assert.equal(job.status, 'done');
  assert.deepEqual(job.result, { finalUrl: 'https://drive.google.com/migrated' });
  assert.deepEqual(job.logs, [{ ts: '2026-06-01T01:00:00', msg: 'started' }]);

  assert.equal(store.getMeta('lastPollAt'), '2026-06-02T12:00:00Z');
  assert.deepEqual(store.getMeta('configOverrides'), { watcher: { pollIntervalSeconds: 600 } });
});

test('renames state.json to .migrated (never deletes) after a successful import', (t) => {
  const { dir, jsonPath, sqlitePath } = setupFixtureDir();
  const store = new Store({ sqlitePath, jsonPath });
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  assert.equal(fs.existsSync(jsonPath), false);
  assert.equal(fs.existsSync(`${jsonPath}.migrated`), true);
  const migratedContent = JSON.parse(fs.readFileSync(`${jsonPath}.migrated`, 'utf8'));
  assert.deepEqual(migratedContent, FIXTURE);
});

test('is idempotent — a second Store construction against the same DB does not re-import', (t) => {
  const { dir, jsonPath, sqlitePath } = setupFixtureDir();
  const store1 = new Store({ sqlitePath, jsonPath });
  store1.close();

  // Plant a different (garbage) state.json at the same path — since migration
  // already completed (sentinel present), this must be ignored entirely.
  fs.writeFileSync(jsonPath, JSON.stringify({ posts: { 9999: { id: 9999, title: 'should not appear', link: 'l', date: 'd' } }, jobs: {}, meta: {} }));

  const store2 = new Store({ sqlitePath, jsonPath });
  t.after(() => { store2.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  assert.equal(store2.countPosts(), 2); // still just the original fixture's 2 posts
  assert.equal(store2.hasSeenPost(9999), false);
});

test('missing state.json is a safe no-op (fresh install), not an error', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pahe-migration-fresh-'));
  const jsonPath = path.join(dir, 'does-not-exist.json');
  const sqlitePath = path.join(dir, 'test.db');

  const store = new Store({ sqlitePath, jsonPath });
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  assert.equal(store.countPosts(), 0);
  assert.equal(store.countJobs(), 0);
});
