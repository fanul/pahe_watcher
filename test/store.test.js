import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Store } from '../src/core/store.js';

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pahe-store-test-'));
  const sqlitePath = path.join(dir, 'test.db');
  const jsonPath = path.join(dir, 'nonexistent-state.json');
  const store = new Store({ sqlitePath, jsonPath });
  return { store, dir };
}

function cleanup(t, dir, store) {
  t.after(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

test('markPost + getPost round-trips shape and preserves option order', (t) => {
  const { store, dir } = tmpStore();
  cleanup(t, dir, store);

  const post = {
    id: 100,
    title: "The Butcher's Blade (2026)",
    link: 'https://pahe.ink/the-butchers-blade',
    date: '2026-07-07T12:37:49',
    options: [
      { provider: 'GD', providerName: 'GDFlix', quality: '720p', qualityLabel: '720p x264', sizeLabel: '750 MB', url: 'https://x.com/1', host: 'x.com' },
      { provider: 'GD', providerName: 'GDFlix', quality: '1080p', qualityLabel: '1080p x265', sizeLabel: '2.1 GB', url: 'https://x.com/2', host: 'x.com' },
    ],
    poster: 'https://example.com/poster.jpg',
    rating: '7.5',
    synopsis: 'A low-ranking constable faces persecution.',
    isSeries: false,
  };
  store.markPost(post);

  assert.equal(store.hasSeenPost(100), true);
  assert.equal(store.hasSeenPost(999), false);

  const fetched = store.getPost(100);
  assert.equal(fetched.options.length, 2);
  assert.equal(fetched.options[0].quality, '720p');
  assert.equal(fetched.options[1].quality, '1080p');
  assert.equal(fetched.isSeries, false);
  assert.equal(typeof fetched.isSeries, 'boolean');
});

test('markPost has full-replace semantics — a second call with fewer options drops the old ones', (t) => {
  const { store, dir } = tmpStore();
  cleanup(t, dir, store);

  const base = { id: 1, title: 't', link: 'l', date: 'd', options: [
    { provider: 'GD', url: 'a' }, { provider: 'GD', url: 'b' },
  ] };
  store.markPost(base);
  assert.equal(store.getPost(1).options.length, 2);

  store.markPost({ ...base, options: [base.options[0]] });
  assert.equal(store.getPost(1).options.length, 1);
});

test('listPosts sorts newest-date-first and joins options without N+1', (t) => {
  const { store, dir } = tmpStore();
  cleanup(t, dir, store);

  store.markPost({ id: 1, title: 'old', link: 'l', date: '2026-01-01', options: [] });
  store.markPost({ id: 2, title: 'new', link: 'l', date: '2026-06-01', options: [{ provider: 'GD', url: 'x' }] });

  const posts = store.listPosts();
  assert.equal(posts.length, 2);
  assert.equal(posts[0].id, 2); // newest first
  assert.equal(posts[0].options.length, 1);
  assert.equal(posts[1].options.length, 0);
});

test('jobs: upsert merges with existing, delete, list ordering', (t) => {
  const { store, dir } = tmpStore();
  cleanup(t, dir, store);

  store.upsertJob({
    id: 'job-1', status: 'queued', attempts: 0, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    logs: [], result: null, error: null, postId: 100, title: 'x', postLink: 'l', provider: 'GD', quality: '720p', url: 'https://x.com',
  });
  const merged = store.upsertJob({ id: 'job-1', status: 'done', result: { finalUrl: 'https://drive.google.com/x' } });
  assert.equal(merged.status, 'done');
  assert.equal(merged.title, 'x'); // preserved from first insert
  assert.deepEqual(merged.result, { finalUrl: 'https://drive.google.com/x' });

  assert.equal(store.listJobs().length, 1);
  assert.equal(store.deleteJob('job-1'), true);
  assert.equal(store.getJob('job-1'), null);
  assert.equal(store.deleteJob('job-1'), false); // already gone
});

test('meta: get/set with fallback, object values round-trip through JSON', (t) => {
  const { store, dir } = tmpStore();
  cleanup(t, dir, store);

  store.setMeta('lastPollAt', '2026-06-02T12:00:00Z');
  assert.equal(store.getMeta('lastPollAt'), '2026-06-02T12:00:00Z');
  assert.equal(store.getMeta('missing', 'fallback-val'), 'fallback-val');

  store.setMeta('configOverrides', { watcher: { pollIntervalSeconds: 600 } });
  assert.deepEqual(store.getMeta('configOverrides'), { watcher: { pollIntervalSeconds: 600 } });
});

test('transaction() rolls back on throw', (t) => {
  const { store, dir } = tmpStore();
  cleanup(t, dir, store);

  assert.throws(() => {
    store.transaction(() => {
      store.setMeta('willRollback', 'yes');
      throw new Error('boom');
    });
  }, /boom/);
  assert.equal(store.getMeta('willRollback', 'not-set'), 'not-set');
});

test('transaction() is reentrant — markPost (which opens its own transaction) works inside a caller transaction', (t) => {
  const { store, dir } = tmpStore();
  cleanup(t, dir, store);

  store.transaction(() => {
    store.markPost({ id: 1, title: 't', link: 'l', date: 'd', options: [] });
    store.markPost({ id: 2, title: 't2', link: 'l', date: 'd', options: [] });
  });
  assert.equal(store.countPosts(), 2);
});

test('searchPosts (FTS5) finds by title/synopsis and updates when the row is updated', (t) => {
  const { store, dir } = tmpStore();
  cleanup(t, dir, store);

  store.markPost({ id: 1, title: 'Original Zebra Title', link: 'l', date: 'd', synopsis: 'nothing special', options: [] });
  assert.equal(store.searchPosts('Zebra').length, 1);
  assert.equal(store.searchPosts('nonexistentword12345').length, 0);

  // FTS trigger must fire on UPDATE, not just INSERT
  store.markPost({ id: 1, title: 'Renamed Giraffe Title', link: 'l', date: 'd', synopsis: 'nothing special', options: [] });
  assert.equal(store.searchPosts('Zebra').length, 0);
  assert.equal(store.searchPosts('Giraffe').length, 1);
});

test('searchPosts respects limit and empty query returns nothing', (t) => {
  const { store, dir } = tmpStore();
  cleanup(t, dir, store);

  for (let i = 1; i <= 5; i++) {
    store.markPost({ id: i, title: `Dragon Movie ${i}`, link: 'l', date: 'd', synopsis: 'dragons everywhere', options: [] });
  }
  assert.equal(store.searchPosts('Dragon', { limit: 2 }).length, 2);
  assert.equal(store.searchPosts('').length, 0);
  assert.equal(store.searchPosts('   ').length, 0);
});

test('countPosts / countJobs / listUnsyncedPostIds / countUnsyncedPosts', (t) => {
  const { store, dir } = tmpStore();
  cleanup(t, dir, store);

  store.markPost({ id: 1, title: 't1', link: 'l', date: 'd', options: [] }); // shallow, unsynced
  store.markPost({ id: 2, title: 't2', link: 'l', date: 'd', options: [{ provider: 'GD', url: 'x' }] }); // has content
  assert.equal(store.countPosts(), 2);
  assert.equal(store.countUnsyncedPosts(), 1);
  assert.deepEqual(store.listUnsyncedPostIds(10), [1]);

  store.upsertJob({ id: 'j1', status: 'done', createdAt: 'd', updatedAt: 'd' });
  assert.equal(store.countJobs(), 1);
});
