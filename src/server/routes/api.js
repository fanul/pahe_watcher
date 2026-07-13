import express from 'express';
import { bus } from '../../core/eventBus.js';
import { selectOptions, checkIsSeries, parseDownloadOptions } from '../../parser/postParser.js';

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
      counts: { posts: store.listPosts().length, jobs: store.listJobs().length },
    });
  });

  // ── posts ──
  router.get('/posts', (req, res) => {
    res.json(store.listPosts());
  });

  router.get('/posts/:id', (req, res) => {
    const post = store.getPost(req.params.id);
    if (!post) return res.status(404).json({ error: 'not found' });
    res.json(post);
  });

  // Enqueue resolution jobs for a post's matching options.
  router.post('/posts/:id/resolve', async (req, res) => {
    const post = store.getPost(req.params.id);
    if (!post) return res.status(404).json({ error: 'not found' });

    // Lazy load options if empty (e.g. from historical crawl)
    if (!post.options || post.options.length === 0) {
      try {
        const full = await watcher.client.getPost(post.id);
        post.options = parseDownloadOptions(full.contentHtml);
        store.markPost(post);
        bus.emit('post:new', post); // update GUI options view
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

  // Crawl previous pages of posts (lazy loads details on-demand)
  router.post('/watcher/crawl', async (req, res) => {
    const maxPages = parseInt(req.body?.maxPages || 5, 10) || 5;
    const results = [];
    
    try {
      for (let page = 1; page <= maxPages; page++) {
        // Emit WebSocket progress event
        bus.emit('crawl:progress', { page, maxPages, status: 'running' });
        
        const posts = await watcher.client.getPostsPage(page, 10);
        if (posts.length === 0) break;

        for (const post of posts) {
          const existing = store.getPost(post.id);
          const entry = {
            id: post.id,
            title: post.title,
            link: post.link,
            date: post.date,
            seenAt: existing?.seenAt || new Date().toISOString(),
            options: existing?.options || [], // lazy-loaded on demand
            pageFound: page
          };
          store.markPost(entry);
          bus.emit('post:new', entry); // render in posts list
          results.push(entry);
        }
      }
      
      bus.emit('crawl:progress', { status: 'done', resultsCount: results.length });
      res.json({ results });
    } catch (err) {
      bus.emit('crawl:progress', { status: 'error', error: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  // ── jobs ──
  router.get('/jobs', (req, res) => {
    res.json(queue.store.listJobs());
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
