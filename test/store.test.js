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

function seedForQuery(store) {
  store.markPost({
    id: 1, title: 'Dragon Warriors', link: 'l1', date: '2026-01-05', isSeries: false, synopsis: 'Epic dragon battle',
    year: 2026, genre: 'Action, Fantasy', durationMinutes: 130, director: 'Alice Director', actors: 'Actor One, Actor Two',
    metadataComplete: true,
    options: [
      { provider: 'GD', quality: '720p', qualityLabel: '720p x264', url: 'u1' },
      { provider: 'GD', quality: '1080p', qualityLabel: '1080p x265 10Bit', url: 'u2' },
    ],
  });
  store.markPost({
    id: 2, title: 'Space Odyssey', link: 'l2', date: '2026-01-04', isSeries: false, synopsis: 'A journey to the stars',
    year: 2020, genre: 'Sci-Fi', durationMinutes: 85,
    metadataComplete: true,
    options: [{ provider: '1F', quality: '720p', qualityLabel: '720p x264', url: 'u3' }],
  });
  store.markPost({
    id: 3, title: 'Dragon Kingdom Season 1', link: 'l3', date: '2026-01-03', isSeries: true, synopsis: 'Dragons rule the kingdom',
    year: 2024, genre: 'Fantasy, Drama', creator: 'Bob Creator', actors: 'Actor Three',
    metadataComplete: true,
    options: [{ provider: 'GD', quality: '1080p', qualityLabel: '1080p x265', url: 'u4' }],
  });
  store.markPost({ id: 4, title: 'Random Comedy', link: 'l4', date: '2026-01-02', isSeries: false, synopsis: 'Funny stuff', options: [] });
  store.markPost({
    // Synced (has options), but no year/genre — simulates a post deep-synced under the older parser.
    id: 5, title: 'Old Movie', link: 'l5', date: '2026-01-01', isSeries: false, synopsis: '',
    options: [{ provider: 'GD', quality: '2160p', qualityLabel: '2160p x264', url: 'u5' }],
  });
}

test('queryPosts: pagination returns bounded pages with an accurate total', (t) => {
  const { store, dir } = tmpStore();
  cleanup(t, dir, store);
  seedForQuery(store);

  const p1 = store.queryPosts({ limit: 2, offset: 0 });
  assert.deepEqual(p1.items.map((p) => p.id), [1, 2]);
  assert.equal(p1.total, 5);

  const p2 = store.queryPosts({ limit: 2, offset: 2 });
  assert.deepEqual(p2.items.map((p) => p.id), [3, 4]);
  assert.equal(p2.total, 5);
});

test('queryPosts: search matches whole words across title and synopsis (FTS5)', (t) => {
  const { store, dir } = tmpStore();
  cleanup(t, dir, store);
  seedForQuery(store);

  const r = store.queryPosts({ search: 'dragon' });
  assert.deepEqual(r.items.map((p) => p.id).sort(), [1, 3]);
  assert.equal(r.total, 2);
});

test('queryPosts: type filter separates movies from series', (t) => {
  const { store, dir } = tmpStore();
  cleanup(t, dir, store);
  seedForQuery(store);

  const movies = store.queryPosts({ type: 'movie' });
  assert.deepEqual(movies.items.map((p) => p.id).sort(), [1, 2, 4, 5]);

  const series = store.queryPosts({ type: 'series' });
  assert.deepEqual(series.items.map((p) => p.id), [3]);
});

test('queryPosts: provider/quality/codec must match within a single option, not independently', (t) => {
  const { store, dir } = tmpStore();
  cleanup(t, dir, store);
  seedForQuery(store);

  // provider=GD alone: posts 1, 3, 5 each have a GD option
  assert.deepEqual(store.queryPosts({ provider: 'GD' }).items.map((p) => p.id).sort(), [1, 3, 5]);

  // quality=1080p alone: posts 1, 3
  assert.deepEqual(store.queryPosts({ quality: '1080p' }).items.map((p) => p.id).sort(), [1, 3]);

  // codec=x265 ("x265|hevc|10bit"): posts 1 (10bit variant), 3
  assert.deepEqual(store.queryPosts({ codec: 'x265' }).items.map((p) => p.id).sort(), [1, 3]);

  // codec=x264 means "not x265-like" (matches the old client's isX265 exclusion, not a literal x264 substring)
  assert.deepEqual(store.queryPosts({ codec: 'x264' }).items.map((p) => p.id).sort(), [1, 2, 5]);

  // combined: provider=GD AND quality=1080p AND codec=x265 must be satisfied by ONE option
  assert.deepEqual(store.queryPosts({ provider: 'GD', quality: '1080p', codec: 'x265' }).items.map((p) => p.id).sort(), [1, 3]);

  // mismatch across options must NOT match: post 2 has 1F but only at 720p, never at 1080p
  assert.deepEqual(store.queryPosts({ provider: '1F', quality: '1080p' }).items, []);
});

test('queryJobs: pagination returns bounded pages newest-first with an accurate total', (t) => {
  const { store, dir } = tmpStore();
  cleanup(t, dir, store);

  store.upsertJob({ id: 'j1', status: 'done', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' });
  store.upsertJob({ id: 'j2', status: 'queued', createdAt: '2026-01-02T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z' });
  store.upsertJob({ id: 'j3', status: 'failed', createdAt: '2026-01-03T00:00:00Z', updatedAt: '2026-01-03T00:00:00Z' });

  const page1 = store.queryJobs({ limit: 2, offset: 0 });
  assert.deepEqual(page1.items.map((j) => j.id), ['j3', 'j2']);
  assert.equal(page1.total, 3);

  const page2 = store.queryJobs({ limit: 2, offset: 2 });
  assert.deepEqual(page2.items.map((j) => j.id), ['j1']);
});

test('queryPosts: genre/year/duration filters', (t) => {
  const { store, dir } = tmpStore();
  cleanup(t, dir, store);
  seedForQuery(store);

  // genre is a comma-list; substring match against the raw stored string
  assert.deepEqual(store.queryPosts({ genre: 'Fantasy' }).items.map((p) => p.id).sort(), [1, 3]);

  assert.deepEqual(store.queryPosts({ year: 2020 }).items.map((p) => p.id), [2]);
  assert.equal(store.queryPosts({ year: 1999 }).items.length, 0);

  // duration buckets: short <90, medium 90-150, long >150. Posts without a duration never match.
  assert.deepEqual(store.queryPosts({ duration: 'short' }).items.map((p) => p.id), [2]);
  assert.deepEqual(store.queryPosts({ duration: 'medium' }).items.map((p) => p.id), [1]);
  assert.equal(store.queryPosts({ duration: 'long' }).items.length, 0);
});

test('queryPosts: sort whitelist controls ORDER BY (title, year)', (t) => {
  const { store, dir } = tmpStore();
  cleanup(t, dir, store);
  seedForQuery(store);

  const byTitleAsc = store.queryPosts({ sort: 'title_asc' }).items.map((p) => p.title);
  assert.deepEqual(byTitleAsc, [...byTitleAsc].sort((a, b) => a.localeCompare(b)));

  // year_desc: posts with a year come first, highest first (2026, 2024, 2020), then NULLs last (4, 5)
  const byYearDesc = store.queryPosts({ sort: 'year_desc' }).items.map((p) => p.id);
  assert.deepEqual(byYearDesc.slice(0, 3), [1, 3, 2]);

  // an unrecognized sort value falls back to the default (date_desc) instead of throwing
  assert.doesNotThrow(() => store.queryPosts({ sort: 'not-a-real-sort; DROP TABLE posts' }));
});

test('queryPosts: search also matches director/creator/actors via FTS', (t) => {
  const { store, dir } = tmpStore();
  cleanup(t, dir, store);
  seedForQuery(store);

  assert.deepEqual(store.queryPosts({ search: 'Alice' }).items.map((p) => p.id), [1]);
  assert.deepEqual(store.queryPosts({ search: 'Condal' }).items.map((p) => p.id), []); // "Ryan J. Condal" wasn't seeded — sanity check for no false positives
  assert.deepEqual(store.queryPosts({ search: 'Creator' }).items.map((p) => p.id), [3]);
});

test('queryPosts: hasDeadJob is derived from a matching dead job by post_link', (t) => {
  const { store, dir } = tmpStore();
  cleanup(t, dir, store);
  seedForQuery(store);

  store.upsertJob({
    id: 'dead-job', status: 'dead', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    postLink: 'l1', title: 'x', provider: 'GD', quality: '720p', url: 'u1',
  });

  const items = store.queryPosts({}).items;
  const post1 = items.find((p) => p.id === 1);
  const post2 = items.find((p) => p.id === 2);
  assert.equal(post1.hasDeadJob, true);
  assert.equal(post2.hasDeadJob, false);
});

test('getPostFacets returns distinct years (desc) and flattened genre tokens', (t) => {
  const { store, dir } = tmpStore();
  cleanup(t, dir, store);
  seedForQuery(store);

  const facets = store.getPostFacets();
  assert.deepEqual(facets.years, [2026, 2024, 2020]);
  assert.deepEqual(facets.genres, ['Action', 'Drama', 'Fantasy', 'Sci-Fi'].sort((a, b) => a.localeCompare(b)));
});

test('listPostsMissingExtendedMetadata / countPostsMissingExtendedMetadata: synced posts not flagged metadataComplete', (t) => {
  const { store, dir } = tmpStore();
  cleanup(t, dir, store);
  seedForQuery(store);

  // posts 4 and 5 both count as "synced" (a synopsis alone sets content_synced_at, same as having
  // options) but neither was marked metadataComplete — both are targets of the metadata-backfill sweep.
  assert.deepEqual(store.listPostsMissingExtendedMetadata(10), [4, 5]);
  assert.equal(store.countPostsMissingExtendedMetadata(), 2);

  store.markPost({ ...store.getPost(4), id: 4, year: 2015, genre: 'Comedy', metadataComplete: true });
  assert.deepEqual(store.listPostsMissingExtendedMetadata(10), [5]);
  assert.equal(store.countPostsMissingExtendedMetadata(), 1);
});

test('listPostsMissingExtendedMetadata also catches posts with complete IMDb metadata but an unresolved option quality — never excluded by metadataSourceIncomplete', (t) => {
  const { store, dir } = tmpStore();
  cleanup(t, dir, store);

  store.markPost({
    id: 10, title: 'Fully Complete', link: 'l10', date: 'd', synopsis: 'A synopsis',
    poster: 'p', rating: '7.5', year: 2020, genre: 'Action', director: 'Someone', actors: 'Someone Actor',
    metadataComplete: true,
    options: [{ provider: 'GD', quality: '720p', url: 'u10' }],
  });
  store.markPost({
    id: 11, title: 'Complete Metadata, Unparsed Quality', link: 'l11', date: 'd', synopsis: 'A synopsis',
    poster: 'p', rating: '7.5', year: 2020, genre: 'Action', director: 'Someone', actors: 'Someone Actor',
    metadataComplete: true,
    options: [{ provider: 'GD', quality: null, url: 'u11' }],
  });

  assert.deepEqual(store.listPostsMissingExtendedMetadata(10), [11]);
  assert.equal(store.countPostsMissingExtendedMetadata(), 1);

  // Marking source-incomplete only concerns the IMDb-metadata reason — a
  // null option quality is always a parser gap, so it stays in the sweep.
  store.markPostSourceIncomplete(11, true);
  assert.deepEqual(store.listPostsMissingExtendedMetadata(10), [11]);
  assert.equal(store.countPostsMissingExtendedMetadata(), 1);
});

test('markPostSourceIncomplete excludes a post from the metadata-backfill sweep and survives a resync', (t) => {
  const { store, dir } = tmpStore();
  cleanup(t, dir, store);
  seedForQuery(store);

  assert.deepEqual(store.listPostsMissingExtendedMetadata(10), [4, 5]);

  store.markPostSourceIncomplete(4, true);
  assert.equal(store.getPost(4).metadataSourceIncomplete, true);
  assert.deepEqual(store.listPostsMissingExtendedMetadata(10), [5]);
  assert.equal(store.countPostsMissingExtendedMetadata(), 1);

  // A full-replace resync (markPost re-inserting the same post) must not clear the flag —
  // it's a durable manual annotation, not sync-derived state (same pattern as dead_reported_at).
  store.markPost({ ...store.getPost(4), id: 4 });
  assert.equal(store.getPost(4).metadataSourceIncomplete, true);
  assert.deepEqual(store.listPostsMissingExtendedMetadata(10), [5]);

  // Unmarking brings it back into the sweep.
  store.markPostSourceIncomplete(4, false);
  assert.equal(store.getPost(4).metadataSourceIncomplete, false);
  assert.deepEqual(store.listPostsMissingExtendedMetadata(10), [4, 5]);
});

test('listStaleSeriesPostIds / countStaleSeries: detects series whose title claims more seasons than are stored', (t) => {
  const { store, dir } = tmpStore();
  cleanup(t, dir, store);

  // Complete, up to date: title says 1-2, season 2 is present.
  store.markPost({
    id: 10, title: 'Fully Synced Show Season 1-2 Complete', link: 'l10', date: 'd', isSeries: true,
    options: [
      { provider: 'GD', quality: '720p', qualityLabel: 'Season 1 – 720p x264', season: 1, url: 'u10a' },
      { provider: 'GD', quality: '720p', qualityLabel: 'Season 2 – 720p x264', season: 2, url: 'u10b' },
    ],
  });
  // Stale: title says 1-7, but only season 1-3 are stored (site added seasons 4-7 since our last sync).
  store.markPost({
    id: 11, title: 'Growing Show Season 1-7 Complete', link: 'l11', date: 'd', isSeries: true,
    options: [
      { provider: 'GD', quality: '720p', qualityLabel: 'Season 1 – 720p x264', season: 1, url: 'u11a' },
      { provider: 'GD', quality: '720p', qualityLabel: 'Season 3 – 720p x264', season: 3, url: 'u11b' },
    ],
  });
  // Never confirmed: title says 1-5, but this post predates the `season` column (options carry no season at all).
  store.markPost({
    id: 12, title: 'Old Sync Show Season 1-5 Complete', link: 'l12', date: 'd', isSeries: true,
    options: [{ provider: 'GD', quality: '720p', qualityLabel: '720p x264', url: 'u12a' }], // no season tag
  });
  // Single season — nothing to compare (title range min === max), never flagged.
  store.markPost({
    id: 13, title: 'Single Season Show Season 1 Complete', link: 'l13', date: 'd', isSeries: true,
    options: [{ provider: 'GD', quality: '720p', qualityLabel: '720p x264', url: 'u13a' }],
  });
  // A movie — not a series at all, must never be considered.
  store.markPost({ id: 14, title: 'Some Movie (2026)', link: 'l14', date: 'd', isSeries: false, options: [{ provider: 'GD', quality: '720p', url: 'u14a' }] });

  assert.deepEqual(store.listStaleSeriesPostIds(10).sort(), [11, 12]);
  assert.equal(store.countStaleSeries(), 2);

  // Re-syncing post 11 with all 7 seasons present clears it from the stale list.
  store.markPost({
    ...store.getPost(11), id: 11,
    options: Array.from({ length: 7 }, (_, i) => ({ provider: 'GD', quality: '720p', qualityLabel: `Season ${i + 1} – 720p x264`, season: i + 1, url: `u11-${i + 1}` })),
  });
  assert.deepEqual(store.listStaleSeriesPostIds(10), [12]);
  assert.equal(store.countStaleSeries(), 1);
});

test('queryPosts: metadataComplete filter — posts 1/2/3 are complete, posts 4/5 (never flagged) count as incomplete', (t) => {
  const { store, dir } = tmpStore();
  cleanup(t, dir, store);
  seedForQuery(store);

  assert.deepEqual(store.queryPosts({ metadataComplete: 'complete' }).items.map((p) => p.id).sort(), [1, 2, 3]);
  assert.deepEqual(store.queryPosts({ metadataComplete: 'incomplete' }).items.map((p) => p.id).sort(), [4, 5]);
  assert.equal(store.queryPosts({ metadataComplete: 'all' }).total, 5);
});

test('queryPosts: metadataComplete "source-incomplete" filter is its own bucket, excluded from "incomplete"', (t) => {
  const { store, dir } = tmpStore();
  cleanup(t, dir, store);
  seedForQuery(store);

  store.markPostSourceIncomplete(4, true);

  assert.deepEqual(store.queryPosts({ metadataComplete: 'source-incomplete' }).items.map((p) => p.id), [4]);
  assert.deepEqual(store.queryPosts({ metadataComplete: 'incomplete' }).items.map((p) => p.id), [5]);
  assert.equal(store.queryPosts({ metadataComplete: 'all' }).total, 5); // still counted overall, just re-bucketed
});

test('queryPosts: deadLink filter matches jobs.post_link = posts.link regardless of how the job was created', (t) => {
  const { store, dir } = tmpStore();
  cleanup(t, dir, store);
  seedForQuery(store);

  store.upsertJob({
    id: 'dead-job-1', status: 'dead', createdAt: 'd', updatedAt: 'd',
    postLink: 'l2', title: 'x', provider: 'GD', quality: '720p', url: 'u3',
  });

  assert.deepEqual(store.queryPosts({ deadLink: 'dead' }).items.map((p) => p.id), [2]);
  assert.deepEqual(store.queryPosts({ deadLink: 'not-dead' }).items.map((p) => p.id).sort(), [1, 3, 4, 5]);
});

test('markOptionReported persists dead_reported_at on the matching option and survives a resync', (t) => {
  const { store, dir } = tmpStore();
  cleanup(t, dir, store);
  seedForQuery(store);

  assert.equal(store.getPost(1).options.find((o) => o.url === 'u1').deadReportedAt, null);

  store.markOptionReported(1, 'u1');
  const reportedAt = store.getPost(1).options.find((o) => o.url === 'u1').deadReportedAt;
  assert.ok(reportedAt, 'deadReportedAt should be set');

  // A full-replace resync (markPost re-inserting the same options) must not lose the report.
  store.markPost({ ...store.getPost(1), id: 1 });
  assert.equal(store.getPost(1).options.find((o) => o.url === 'u1').deadReportedAt, reportedAt);

  // A different option on the same post is unaffected.
  assert.equal(store.getPost(1).options.find((o) => o.url === 'u2').deadReportedAt, null);
});

test('reopening a Store retroactively computes metadata_complete for posts synced before that column existed', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pahe-store-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sqlitePath = path.join(dir, 'test.db');

  {
    const store = new Store({ sqlitePath, jsonPath: path.join(dir, 'no.json') });
    // markPost without metadataComplete (undefined) simulates a post synced by
    // an older parser version — full data present, but the flag was never set.
    store.markPost({
      id: 1, title: 'Fully Populated Old Post', link: 'l1', date: 'd', synopsis: 'A synopsis',
      poster: 'https://example.com/p.jpg', rating: '7.5', year: 1991, genre: 'Action, Drama',
      director: 'Some Director', actors: 'Actor One, Actor Two',
      options: [{ provider: 'GD', quality: '720p', url: 'u1' }],
    });
    // A genuinely incomplete post — missing rating and actors.
    store.markPost({
      id: 2, title: 'Genuinely Incomplete Post', link: 'l2', date: 'd', synopsis: 'A synopsis',
      poster: 'https://example.com/p2.jpg', year: 2000, genre: 'Comedy', director: 'Someone',
      options: [{ provider: 'GD', quality: '720p', url: 'u2' }],
    });
    assert.equal(store.getPost(1).metadataComplete, false); // not yet backfilled
    store.close();
  }

  // Reopening the same DB file (simulating an app restart) triggers the retroactive backfill.
  {
    const store = new Store({ sqlitePath, jsonPath: path.join(dir, 'no.json') });
    assert.equal(store.getPost(1).metadataComplete, true);
    assert.equal(store.getPost(2).metadataComplete, false);
    store.close();
  }

  // A third open is a no-op (idempotent) — nothing left to backfill, values unchanged.
  {
    const store = new Store({ sqlitePath, jsonPath: path.join(dir, 'no.json') });
    assert.equal(store.getPost(1).metadataComplete, true);
    assert.equal(store.getPost(2).metadataComplete, false);
    store.close();
  }
});

test('markOptionReportedByLink resolves the post via its link (for jobs that lack a reliable postId) and persists dead_reported_at', (t) => {
  const { store, dir } = tmpStore();
  cleanup(t, dir, store);
  seedForQuery(store);

  assert.equal(store.getPost(1).options.find((o) => o.url === 'u1').deadReportedAt, null);

  const ok = store.markOptionReportedByLink('l1', 'u1');
  assert.equal(ok, true);
  assert.ok(store.getPost(1).options.find((o) => o.url === 'u1').deadReportedAt);

  // A different option on the same post is unaffected.
  assert.equal(store.getPost(1).options.find((o) => o.url === 'u2').deadReportedAt, null);

  // Unknown link/url combos are a no-op, not a throw.
  assert.equal(store.markOptionReportedByLink('does-not-exist', 'u1'), false);
  assert.equal(store.markOptionReportedByLink('l1', 'does-not-exist'), false);
});
