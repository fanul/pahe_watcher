import express from 'express';
import { bus } from '../../core/eventBus.js';
import { selectOptions, checkIsSeries } from '../../parser/postParser.js';

/**
 * REST API. Receives the wired application context (`app`) and exposes control
 * + inspection endpoints consumed by the web GUI.
 */
export function createApiRouter(app) {
  const router = express.Router();
  const { store, watcher, queue, bypass, sheets, runtime } = app;

  // ── status ──
  router.get('/status', async (req, res) => {
    res.json({
      watcher: {
        running: Boolean(watcher.timer),
        paused: watcher.paused,
        lastPollAt: store.getMeta('lastPollAt'),
        intervalSeconds: runtime.watcher.pollIntervalSeconds,
        autoResolve: runtime.watcher.autoResolve,
        preferredProviders: runtime.watcher.preferredProviders,
        preferredQualities: runtime.watcher.preferredQualities,
      },
      queue: { ...queue.stats(), paused: queue.paused, concurrency: queue.concurrency },
      bypass: { browserMode: runtime.bypass.browserMode, captcha: runtime.bypass.captcha.provider },
      sheets: { configured: sheets.enabled, sheetId: runtime.sheets.sheetId, tab: runtime.sheets.tab },
      sync: watcher.getBackfillStatus(),
      counts: { posts: store.countPosts(), jobs: store.countJobs() },
    });
  });

  // ── posts ──
  // Paginated + filtered, so the frontend never loads the whole (potentially
  // catalog-sized) table at once. Returns { items, total }.
  router.get('/posts', (req, res) => {
    const limit = Math.min(parseInt(req.query.limit, 10) || 24, 100);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    res.json(store.queryPosts({
      limit,
      offset,
      search: req.query.search || '',
      type: req.query.type || 'all',
      provider: req.query.provider || 'all',
      quality: req.query.quality || 'all',
      codec: req.query.codec || 'all',
      genre: req.query.genre || 'all',
      year: req.query.year || 'all',
      duration: req.query.duration || 'all',
      rating: req.query.rating || 'all',
      sort: req.query.sort || 'date_desc',
    }));
  });

  // Distinct genre/year values present in the archive, for populating filter dropdowns.
  router.get('/posts/facets', (req, res) => {
    res.json(store.getPostFacets());
  });

  router.get('/posts/search', (req, res) => {
    const q = req.query.q;
    if (!q || !String(q).trim()) return res.status(400).json({ error: 'q required' });
    const limit = parseInt(req.query.limit, 10) || 25;
    res.json(store.searchPosts(String(q), { limit }));
  });

  router.get('/posts/:id', (req, res) => {
    const post = store.getPost(req.params.id);
    if (!post) return res.status(404).json({ error: 'not found' });
    res.json(post);
  });

  // Force a fresh fetch+reparse+overwrite of one post — e.g. to pick up
  // metadata/quality/size fields the parser didn't extract at the time of
  // the original sync, without waiting for a catalog-wide sweep.
  router.post('/posts/:id/resync', async (req, res) => {
    const existing = store.getPost(req.params.id);
    if (!existing) return res.status(404).json({ error: 'not found' });
    try {
      const post = await watcher.syncEngine.deepSyncPost(existing.id);
      res.json(post);
    } catch (err) {
      res.status(500).json({ error: `Failed to resync post: ${err.message}` });
    }
  });

  // Enqueue resolution jobs for a post's matching options.
  router.post('/posts/:id/resolve', async (req, res) => {
    let post = store.getPost(req.params.id);
    if (!post) return res.status(404).json({ error: 'not found' });

    // Lazy deep-sync if this post was only ever listing-synced (e.g. from backfill).
    if (!post.options || post.options.length === 0) {
      try {
        post = await watcher.syncEngine.deepSyncPost(post.id);
      } catch (err) {
        return res.status(500).json({ error: `Failed to fetch post download links: ${err.message}` });
      }
    }

    const providers = req.body?.providers || runtime.watcher.preferredProviders;
    const qualities = req.body?.qualities || runtime.watcher.preferredQualities;
    const codecs = runtime.watcher.preferredCodecs || ['x265', 'x264'];
    const seriesType = runtime.watcher.preferredSeriesType || 'batch';
    const isSeries = checkIsSeries(post.title, post.options || []);

    const selected = selectOptions(post.options || [], {
      providers,
      qualities,
      codecs,
      seriesType,
      isSeries,
    });

    const jobs = selected.map((opt) =>
      queue.enqueue({
        postId: post.id,
        title: post.title,
        postLink: post.link,
        provider: opt.provider,
        quality: opt.quality,
        qualityLabel: opt.qualityLabel,
        sizeLabel: opt.sizeLabel,
        url: opt.url,
      }),
    );
    res.json({ enqueued: jobs.length, jobs });
  });

  // ── sync (resumable historical backfill + deep-sync sweep) ──
  router.post('/sync/backfill/run', async (req, res) => {
    try {
      const { batchSize, direction, deepSync } = req.body || {};
      const result = await watcher.runBackfill({ batchSize, direction, deepSync });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
  router.get('/sync/backfill/status', (req, res) => {
    res.json(watcher.getBackfillStatus());
  });
  router.post('/sync/backfill/reset', (req, res) => {
    const { page, direction } = req.body || {};
    res.json(watcher.resetBackfill({ page, direction }));
  });
  router.post('/sync/backfill/pause', (req, res) => {
    res.json(watcher.setBackfillPaused(true));
  });
  router.post('/sync/backfill/resume', (req, res) => {
    res.json(watcher.setBackfillPaused(false));
  });
  router.post('/sync/deep-sync/run', async (req, res) => {
    try {
      const { batchSize } = req.body || {};
      const result = await watcher.runDeepSyncSweep({ batchSize });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
  router.get('/sync/deep-sync/status', (req, res) => {
    res.json({ pending: store.countUnsyncedPosts() });
  });
  router.post('/sync/metadata-backfill/run', async (req, res) => {
    try {
      const { batchSize } = req.body || {};
      const result = await watcher.runMetadataBackfillSweep({ batchSize });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
  router.get('/sync/metadata-backfill/status', (req, res) => {
    res.json({ pending: store.countPostsMissingExtendedMetadata() });
  });
  router.post('/sync/series-resync/run', async (req, res) => {
    try {
      const { batchSize } = req.body || {};
      const result = await watcher.runSeriesResyncSweep({ batchSize });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
  router.get('/sync/series-resync/status', (req, res) => {
    res.json({ pending: store.countStaleSeries() });
  });

  // ── jobs ──
  // Paginated, same reasoning as /posts. Returns { items, total }.
  router.get('/jobs', (req, res) => {
    const limit = Math.min(parseInt(req.query.limit, 10) || 30, 100);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    res.json(store.queryJobs({ limit, offset }));
  });
  router.get('/jobs/:id', (req, res) => {
    const job = store.getJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'not found' });
    res.json(job);
  });
  router.post('/jobs', (req, res) => {
    const { url, provider = 'GD', quality = null, title = 'manual', postLink = '' } = req.body || {};
    if (!url) return res.status(400).json({ error: 'url required' });
    const job = queue.enqueue({ url, provider, quality, title, postLink });
    res.json(job);
  });
  router.post('/jobs/:id/retry', (req, res) => {
    res.json({ ok: queue.retry(req.params.id) });
  });
  router.post('/jobs/:id/cancel', (req, res) => {
    res.json({ ok: queue.cancel(req.params.id) });
  });
  router.post('/jobs/:id/pause', (req, res) => {
    res.json({ ok: queue.pause(req.params.id) });
  });
  router.post('/jobs/:id/resume', (req, res) => {
    res.json({ ok: queue.resume(req.params.id) });
  });
  router.delete('/jobs/:id', (req, res) => {
    res.json({ ok: queue.delete(req.params.id) });
  });
  router.post('/queue/clear', (req, res) => {
    queue.clearAll();
    res.json({ ok: true });
  });
  router.post('/queue/retry', (req, res) => {
    const count = queue.retryAll();
    res.json({ retried: count });
  });

  // ── watcher control ──
  router.post('/watcher/poll', async (req, res) => {
    const result = await watcher.poll().catch((e) => ({ error: String(e) }));
    res.json(result);
  });
  router.post('/watcher/pause', (req, res) => {
    watcher.setPaused(Boolean(req.body?.paused));
    res.json({ paused: watcher.paused });
  });

  // ── queue control ──
  router.post('/queue/pause', (req, res) => {
    queue.setPaused(Boolean(req.body?.paused));
    res.json({ paused: queue.paused });
  });

  // ── captcha (manual solve callback from GUI) ──
  router.post('/captcha/:requestId/solved', (req, res) => {
    bus.emit('captcha:solved', req.params.requestId);
    res.json({ ok: true });
  });

  // ── config (runtime-mutable subset) ──
  router.get('/config', (req, res) => {
    res.json(app.getPublicConfig());
  });
  router.patch('/config', async (req, res) => {
    try {
      const updated = await app.updateConfig(req.body || {});
      res.json(updated);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── sheets ──
  router.get('/sheets/test', async (req, res) => {
    res.json(await sheets.testConnection());
  });

  return router;
}

export default createApiRouter;
