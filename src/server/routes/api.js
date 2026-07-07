import express from 'express';
import { bus } from '../../core/eventBus.js';

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
  router.post('/posts/:id/resolve', (req, res) => {
    const post = store.getPost(req.params.id);
    if (!post) return res.status(404).json({ error: 'not found' });
    const providers = (req.body?.providers || runtime.watcher.preferredProviders || []).map((p) => p.toUpperCase());
    const qualities = (req.body?.qualities || runtime.watcher.preferredQualities || []).map((q) => q.toLowerCase());
    const selected = (post.options || []).filter((o) => {
      const pOk = providers.length === 0 || providers.includes(o.provider);
      const qOk = qualities.length === 0 || (o.quality && qualities.includes(o.quality));
      return pOk && qOk;
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
  router.patch('/config', (req, res) => {
    const updated = app.updateConfig(req.body || {});
    res.json(updated);
  });

  // ── sheets ──
  router.get('/sheets/test', async (req, res) => {
    res.json(await sheets.testConnection());
  });

  return router;
}

export default createApiRouter;
