import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Store } from '../src/core/store.js';
import { SyncEngine } from '../src/watcher/syncEngine.js';

/** A fake WP catalog + client, shaped like PaheClient but fully in-memory. */
function makeFakeCatalog(count = 25) {
  const posts = Array.from({ length: count }, (_, i) => ({
    id: 1000 - i, // higher id = newer
    date: `2026-01-${String(count - i).padStart(2, '0')}T00:00:00`,
    link: `https://pahe.ink/post-${1000 - i}`,
    title: `Movie ${1000 - i}`,
  }));
  const content = {};
  for (const p of posts) {
    content[p.id] = `<p><b>720p x264</b> | 500 MB<br><a href="https://teknoasian.com/?ht=x${p.id}">GD</a></p><div class="imdbwp__teaser">Synopsis for ${p.title}</div>`;
  }
  const client = {
    async getPostsPageMeta(page, perPage) {
      const start = (page - 1) * perPage;
      return { posts: posts.slice(start, start + perPage), totalPosts: posts.length, totalPages: Math.ceil(posts.length / perPage) };
    },
    async getLatestPosts(perPage) {
      return posts.slice(0, perPage);
    },
    async getPost(id) {
      const p = posts.find((x) => x.id === id);
      return { id, date: p.date, link: p.link, title: p.title, contentHtml: content[id] };
    },
  };
  return { posts, client };
}

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pahe-sync-test-'));
  const store = new Store({ sqlitePath: path.join(dir, 'test.db'), jsonPath: path.join(dir, 'no.json') });
  return { store, dir };
}

const BASE_CONFIG = {
  watcher: {
    perPage: 10, autoResolve: true, onlyCompleteSeries: true,
    preferredProviders: ['GD'], preferredQualities: ['720p'],
    preferredCodecs: ['x265', 'x264'], preferredSeriesType: 'batch',
  },
  sync: { backfillBatchSize: 2, backfillDeepSync: true, deepSyncSweepBatchSize: 5 },
};

function fakeQueue() {
  const enqueued = [];
  return { enqueued, enqueue(payload) { enqueued.push(payload); return { id: `job-${enqueued.length}`, ...payload }; } };
}

test('runBackfillBatch advances the cursor by exactly batchSize pages and persists it', async (t) => {
  const { store, dir } = tmpStore();
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const { client } = makeFakeCatalog(25);
  const engine = new SyncEngine({ config: BASE_CONFIG, store, client, queue: fakeQueue() });

  const r1 = await engine.runBackfillBatch({});
  assert.equal(r1.pagesProcessed, 2);
  assert.equal(r1.postsListed, 20);
  assert.equal(r1.postsDeepSynced, 20);
  assert.equal(r1.cursor.page, 3);
  assert.equal(r1.cursor.totalPages, 3);
  assert.equal(r1.cursor.totalPosts, 25);
});

test('a second runBackfillBatch call resumes from the cursor, not page 1', async (t) => {
  const { store, dir } = tmpStore();
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const { client } = makeFakeCatalog(25);
  const engine = new SyncEngine({ config: BASE_CONFIG, store, client, queue: fakeQueue() });

  const r1 = await engine.runBackfillBatch({});
  const r2 = await engine.runBackfillBatch({});
  assert.notEqual(r1.cursor.page, r2.cursor.page);
  assert.equal(r1.cursor.page, 3);
  assert.equal(r2.cursor.page, 4); // page 3 (5 remaining posts) processed, then done
  assert.equal(store.countPosts(), 25);
});

test('resetBackfillCursor jumps the cursor without processing anything', async (t) => {
  const { store, dir } = tmpStore();
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const { client } = makeFakeCatalog(25);
  const engine = new SyncEngine({ config: BASE_CONFIG, store, client, queue: fakeQueue() });

  await engine.runBackfillBatch({});
  engine.resetBackfillCursor({ page: 1 });
  assert.equal(engine.getBackfillCursor().page, 1);
  assert.equal(store.countPosts(), 20); // unchanged — reset doesn't undo prior syncs
});

test('direction override changes cursor travel direction without resetting page', async (t) => {
  const { store, dir } = tmpStore();
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const { client } = makeFakeCatalog(25);
  const engine = new SyncEngine({ config: BASE_CONFIG, store, client, queue: fakeQueue() });

  engine.resetBackfillCursor({ page: 2 });
  const r = await engine.runBackfillBatch({ direction: 'newer', batchSize: 1 });
  assert.equal(r.cursor.direction, 'newer');
  assert.equal(r.cursor.page, 1); // walked from page 2 toward page 1, not reset to 1 then processed
});

test('deepSync:false leaves rows shallow (listing-only)', async (t) => {
  const { store, dir } = tmpStore();
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const { posts, client } = makeFakeCatalog(25);
  const engine = new SyncEngine({ config: BASE_CONFIG, store, client, queue: fakeQueue() });

  const r = await engine.runBackfillBatch({ deepSync: false, batchSize: 1 });
  assert.equal(r.postsDeepSynced, 0);
  assert.equal(r.postsListed, 10);
  assert.equal(store.getPost(posts[0].id).options.length, 0);
  assert.equal(store.countUnsyncedPosts(), 10);
});

test('sweepDeepSync picks up exactly the shallow rows left by a listing-only backfill', async (t) => {
  const { store, dir } = tmpStore();
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const { posts, client } = makeFakeCatalog(25);
  const engine = new SyncEngine({ config: BASE_CONFIG, store, client, queue: fakeQueue() });

  await engine.runBackfillBatch({ deepSync: false, batchSize: 1 }); // 10 shallow rows
  const sweep1 = await engine.sweepDeepSync({}); // batchSize default 5
  assert.equal(sweep1.processed, 5);
  assert.equal(sweep1.remaining, 5);

  const sweep2 = await engine.sweepDeepSync({});
  assert.equal(sweep2.processed, 5);
  assert.equal(sweep2.remaining, 0);

  for (const p of posts.slice(0, 10)) {
    assert.ok(store.getPost(p.id).options.length > 0, `post ${p.id} should be deep-synced`);
  }
});

test('runLivePoll reproduces skip-seen, auto-resolve, and onlyCompleteSeries behavior', async (t) => {
  const { store, dir } = tmpStore();
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const { client } = makeFakeCatalog(25);
  const queue = fakeQueue();
  const engine = new SyncEngine({ config: BASE_CONFIG, store, client, queue });

  const poll1 = await engine.runLivePoll();
  assert.equal(poll1.found, 10); // perPage
  assert.equal(queue.enqueued.length, 10); // all match GD/720p, none are series

  const poll2 = await engine.runLivePoll();
  assert.equal(poll2.found, 0); // all already seen
  assert.equal(store.getMeta('lastPollAt') !== null, true);
});

test('sweepMetadataBackfill fills in year/genre/director for posts synced under an older parser', async (t) => {
  const { store, dir } = tmpStore();
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  // Two posts already deep-synced (have options/synopsis, so content_synced_at is set)
  // but predate the extended-metadata parser — no year/genre/etc yet.
  store.markPost({
    id: 1, title: 'Backrooms', link: 'https://pahe.ink/backrooms', date: '2026-01-01', synopsis: 'old synopsis',
    options: [{ provider: 'GD', quality: '1080p', url: 'https://teknoasian.com/?ht=a' }],
  });
  store.markPost({
    id: 2, title: 'Never Synced', link: 'https://pahe.ink/never-synced', date: '2026-01-02', options: [],
  });

  const richHtml = `
    <div class="imdbwp__thumb"><img class="imdbwp__img" src="https://example.com/poster.jpg"></div>
    <div class="imdbwp__header"><span class="imdbwp__title">Backrooms</span> (2026)</p>
    <div class="imdbwp__meta"><span>110 min</span>|<span>Horror, Sci-Fi</span>|<span>29 May 2026</span></div>
    <div class="imdbwp__belt"><span class="imdbwp__star">7.0</span></div>
    <div class="imdbwp__teaser">Refreshed synopsis</div>
    <div class="imdbwp__footer"><strong>Director:</strong> <span>Kane Parsons</span><br /><strong>Actors:</strong> <span>Someone Actor</span></div>
  `;
  const client = {
    async getPost(id) {
      return { id, date: '2026-01-01T00:00:00', link: 'https://pahe.ink/backrooms', title: 'Backrooms', contentHtml: richHtml };
    },
  };
  const engine = new SyncEngine({ config: BASE_CONFIG, store, client, queue: fakeQueue() });

  assert.deepEqual(store.listPostsMissingExtendedMetadata(10), [1]); // post 2 was never deep-synced — not this sweep's job
  assert.equal(store.countPostsMissingExtendedMetadata(), 1);

  const result = await engine.sweepMetadataBackfill({ batchSize: 10 });
  assert.equal(result.processed, 1);
  assert.equal(result.remaining, 0);

  const post = store.getPost(1);
  assert.equal(post.year, 2026);
  assert.equal(post.genre, 'Horror, Sci-Fi');
  assert.equal(post.durationMinutes, 110);
  assert.equal(post.director, 'Kane Parsons');
  assert.equal(post.metadataComplete, true);
  assert.deepEqual(store.listPostsMissingExtendedMetadata(10), []);
});

test('deepSyncPost does not mark a post complete when its IMDb metadata parsed fine but every download option came out with no resolvable quality', async (t) => {
  const { store, dir } = tmpStore();
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  // Fully-populated imdbwp block (metadata-wise this alone would be
  // "complete"), but the download-options section uses a layout the parser
  // can't extract quality from (an unrecognized heading right before the
  // anchors) — regression guard for a real case where a resynced post kept
  // showing "unknown · x264 · N/A" chips despite losing its incomplete-
  // metadata badge.
  const html = `
    <div class="imdbwp__thumb"><img class="imdbwp__img" src="https://example.com/poster.jpg"></div>
    <div class="imdbwp__header"><span class="imdbwp__title">Mystery Layout</span> (2026)</p>
    <div class="imdbwp__meta"><span>110 min</span>|<span>Horror, Sci-Fi</span>|<span>29 May 2026</span></div>
    <div class="imdbwp__belt"><span class="imdbwp__star">7.0</span></div>
    <div class="imdbwp__teaser">A synopsis</div>
    <div class="imdbwp__footer"><strong>Director:</strong> <span>Someone</span><br /><strong>Actors:</strong> <span>Someone Actor</span></div>
    <div class="box download"><div class="box-inner-block">
      <b>New Layout Heading</b><br />
      <a href="https://teknoasian.com/?ht=noqual">GD</a>
    </div></div>
  `;
  const client = { async getPost(id) { return { id, date: '2026-01-01T00:00:00', link: 'https://pahe.ink/mystery', title: 'Mystery Layout', contentHtml: html }; } };
  const engine = new SyncEngine({ config: BASE_CONFIG, store, client, queue: fakeQueue() });

  const entry = await engine.deepSyncPost(999);
  assert.equal(entry.options.length, 1);
  assert.equal(entry.options[0].quality, null); // confirms the fixture actually hits the "no quality parsed" case
  assert.equal(entry.metadataComplete, false);
  assert.equal(store.getPost(999).metadataComplete, false);
});

test('deepSyncPost still marks a post complete when it legitimately has zero download options (not a parsing failure)', async (t) => {
  const { store, dir } = tmpStore();
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  const html = `
    <div class="imdbwp__thumb"><img class="imdbwp__img" src="https://example.com/poster.jpg"></div>
    <div class="imdbwp__header"><span class="imdbwp__title">No Links Yet</span> (2026)</p>
    <div class="imdbwp__meta"><span>110 min</span>|<span>Horror</span>|<span>29 May 2026</span></div>
    <div class="imdbwp__belt"><span class="imdbwp__star">7.0</span></div>
    <div class="imdbwp__teaser">A synopsis</div>
    <div class="imdbwp__footer"><strong>Director:</strong> <span>Someone</span><br /><strong>Actors:</strong> <span>Someone Actor</span></div>
  `;
  const client = { async getPost(id) { return { id, date: '2026-01-01T00:00:00', link: 'https://pahe.ink/no-links', title: 'No Links Yet', contentHtml: html }; } };
  const engine = new SyncEngine({ config: BASE_CONFIG, store, client, queue: fakeQueue() });

  const entry = await engine.deepSyncPost(998);
  assert.equal(entry.options.length, 0);
  assert.equal(entry.metadataComplete, true);
});

test('sweepStaleSeriesResync re-fetches series posts whose page grew new seasons since our last sync', async (t) => {
  const { store, dir } = tmpStore();
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  // Stored with only seasons 1-3, but pahe.ink's live page (below) now has seasons 1-5.
  store.markPost({
    id: 1, title: 'Growing Show Season 1-5 Complete', link: 'https://pahe.ink/growing-show', date: '2026-01-01', isSeries: true,
    options: [
      { provider: 'GD', quality: '720p', qualityLabel: 'Season 1 – 720p x264', season: 1, url: 'https://teknoasian.com/?ht=old1' },
      { provider: 'GD', quality: '720p', qualityLabel: 'Season 3 – 720p x264', season: 3, url: 'https://teknoasian.com/?ht=old3' },
    ],
  });
  // Not stale — up to date.
  store.markPost({
    id: 2, title: 'Complete Show Season 1-2 Complete', link: 'https://pahe.ink/complete-show', date: '2026-01-02', isSeries: true,
    options: [
      { provider: 'GD', quality: '720p', qualityLabel: 'Season 1 – 720p x264', season: 1, url: 'https://teknoasian.com/?ht=c1' },
      { provider: 'GD', quality: '720p', qualityLabel: 'Season 2 – 720p x264', season: 2, url: 'https://teknoasian.com/?ht=c2' },
    ],
  });

  const liveHtmlById = {
    1: Array.from({ length: 5 }, (_, i) => `<p><b>Season ${i + 1} – 720p x264</b><br><a href="https://teknoasian.com/?ht=new${i + 1}">GD</a></p>`).join(''),
  };
  const client = {
    async getPost(id) {
      return { id, date: '2026-01-01T00:00:00', link: 'https://pahe.ink/growing-show', title: 'Growing Show Season 1-5 Complete', contentHtml: liveHtmlById[id] };
    },
  };
  const engine = new SyncEngine({ config: BASE_CONFIG, store, client, queue: fakeQueue() });

  assert.deepEqual(store.listStaleSeriesPostIds(10), [1]);
  assert.equal(store.countStaleSeries(), 1);

  const result = await engine.sweepStaleSeriesResync({ batchSize: 10 });
  assert.equal(result.processed, 1);
  assert.equal(result.remaining, 0);

  const post = store.getPost(1);
  const seasons = [...new Set(post.options.map((o) => o.season))].sort((a, b) => a - b);
  assert.deepEqual(seasons, [1, 2, 3, 4, 5]);
  assert.equal(store.countStaleSeries(), 0);
});

test('runLivePoll skips auto-resolve for an in-progress series without "Complete" in the title', async (t) => {
  const { store, dir } = tmpStore();
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  const client = {
    async getLatestPosts() {
      return [{ id: 5000, date: '2026-01-01T00:00:00', link: 'https://pahe.ink/series', title: 'Some Series Season 1' }];
    },
    async getPost(id) {
      return {
        id, date: '2026-01-01T00:00:00', link: 'https://pahe.ink/series', title: 'Some Series Season 1',
        contentHtml: '<p><b>720p x264 Episode 1</b><br><a href="https://teknoasian.com/?ht=e1">GD</a></p>',
      };
    },
  };
  const queue = fakeQueue();
  const engine = new SyncEngine({ config: BASE_CONFIG, store, client, queue });

  await engine.runLivePoll();
  assert.equal(queue.enqueued.length, 0); // no "Complete" in title, onlyCompleteSeries=true -> skipped
});
