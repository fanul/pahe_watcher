import express from 'express';
import { bus } from '../../core/eventBus.js';
import { selectOptions, checkIsSeries } from '../../parser/postParser.js';

/** Same derivation the chip UI uses (src/server/public/js/posts.js) to label a link's codec from its raw quality label. */
function deriveCodec(qualityLabel) {
  if (/x265|hevc|10bit/i.test(qualityLabel || '')) return 'x265';
  if (/av1/i.test(qualityLabel || '')) return 'AV1';
  return 'x264';
}

/** Fills `{placeholder}` tokens in a dead-link report template from the post + option being reported. */
function renderReportTemplate(template, { post, option }) {
  const values = {
    postLink: post.link,
    title: post.title,
    provider: option.provider || '',
    providerName: option.providerName || option.provider || '',
    quality: option.quality || '',
    qualityLabel: option.qualityLabel || '',
    codec: deriveCodec(option.qualityLabel),
  };
  return template.replace(/\{(\w+)\}/g, (match, key) => (key in values ? values[key] : match));
}

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
      metadataComplete: req.query.metadataComplete || 'all',
      deadLink: req.query.deadLink || 'all',
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

  // Builds the dead-link report comment text from the configured template —
  // read-only, does not mark anything reported. The user reviews/copies this
  // and submits it themselves as a WordPress comment on the post (semi-
  // automated by design — see ARCHITECTURE.md's dead-link-reporting section).
  router.post('/posts/:id/report-dead-link', (req, res) => {
    const post = store.getPost(req.params.id);
    if (!post) return res.status(404).json({ error: 'not found' });
    const url = req.body?.url;
    const option = (post.options || []).find((o) => o.url === url);
    if (!option) return res.status(404).json({ error: 'option not found on this post' });

    const template = runtime.deadLinkReport?.reportCommentTemplate
      || 'Link: {postLink} – Info: {providerName} {quality} {codec} has been deleted, please add a new one';
    const commentText = renderReportTemplate(template, { post, option });
    res.json({ commentText, postLink: post.link });
  });

  // Persists that the user actually submitted the report — only this marks
  // dead_reported_at, so a card never shows "Reported" from generating the
  // text alone.
  router.post('/posts/:id/mark-reported', (req, res) => {
    const post = store.getPost(req.params.id);
    if (!post) return res.status(404).json({ error: 'not found' });
    const url = req.body?.url;
    if (!url) return res.status(400).json({ error: 'url required' });
    store.markOptionReported(post.id, url);
    res.json(store.getPost(post.id));
  });

  // Manually flags a post's incomplete metadata as "the source (pahe.ink)
  // never had this data" rather than "our parser hasn't caught up yet" —
  // excludes it from the batch "Resync incomplete metadata" sweep so it
  // isn't refetched forever for data that will never appear.
  router.post('/posts/:id/mark-source-incomplete', (req, res) => {
    const post = store.getPost(req.params.id);
    if (!post) return res.status(404).json({ error: 'not found' });
    const flag = req.body?.sourceIncomplete !== false;
    store.markPostSourceIncomplete(post.id, flag);
    res.json(store.getPost(post.id));
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
  router.post('/jobs/:id/mark-dead', (req, res) => {
    res.json({ ok: queue.markDead(req.params.id) });
  });
  router.post('/jobs/:id/unmark-dead', (req, res) => {
    res.json({ ok: queue.unmarkDead(req.params.id) });
  });

  // Job-centric dead-link report: builds the comment text straight from the
  // job's own fields (no post_options lookup needed — a manually-created job
  // may not even correspond to a tracked post_options row).
  router.post('/jobs/:id/report-dead-link', (req, res) => {
    const job = store.getJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'not found' });
    const template = runtime.deadLinkReport?.reportCommentTemplate
      || 'Link: {postLink} – Info: {providerName} {quality} {codec} has been deleted, please add a new one';
    const commentText = renderReportTemplate(template, {
      post: { link: job.postLink || '', title: job.title || '' },
      option: { provider: job.provider, providerName: job.provider, quality: job.quality, qualityLabel: job.qualityLabel },
    });
    res.json({ commentText, postLink: job.postLink || '' });
  });

  // Persists the report against the matching post_options row, resolved via
  // the job's postLink + url (jobs don't reliably carry a postId).
  router.post('/jobs/:id/mark-reported', (req, res) => {
    const job = store.getJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'not found' });
    const ok = store.markOptionReportedByLink(job.postLink || '', job.url);
    res.json({ ok });
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
