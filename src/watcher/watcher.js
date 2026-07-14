import { createLogger } from '../core/logger.js';
import { bus } from '../core/eventBus.js';
import { PaheClient } from './paheClient.js';
import { parseDownloadOptions, selectOptions, checkIsSeries, parsePostMetadata } from '../parser/postParser.js';

const log = createLogger('watcher');

/**
 * Polls pahe.ink for new posts. On a new post it parses the download options,
 * persists them, emits `post:new`, and (if autoResolve) enqueues bypass jobs
 * for the preferred provider/quality combinations.
 */
export class Watcher {
  constructor({ config, store, queue }) {
    this.config = config;
    this.store = store;
    this.queue = queue;
    this.client = new PaheClient(config.watcher.baseUrl);
    this.timer = null;
    this.running = false;
    this.paused = false;
  }

  start() {
    if (this.timer) return;
    const ms = Math.max(15, this.config.watcher.pollIntervalSeconds) * 1000;
    log.info(`Watcher started (interval ${this.config.watcher.pollIntervalSeconds}s)`);
    // fire immediately, then on the interval
    this.poll().catch((e) => log.error('Initial poll failed', { error: String(e) }));
    this.timer = setInterval(() => {
      this.poll().catch((e) => log.error('Poll failed', { error: String(e) }));
    }, ms);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    log.info('Watcher stopped');
  }

  setPaused(paused) {
    this.paused = paused;
    log.info(`Watcher ${paused ? 'paused' : 'resumed'}`);
  }

  /** One polling cycle. Safe to call manually (GUI "Check now"). */
  async poll() {
    if (this.running) {
      log.debug('Poll already in progress, skipping');
      return { skipped: true };
    }
    if (this.paused) {
      log.debug('Watcher paused, skipping poll');
      return { paused: true };
    }
    this.running = true;
    let found = 0;
    try {
      const posts = await this.client.getLatestPosts(this.config.watcher.perPage);
      // Oldest-first so IDs/highest-water-mark advance monotonically.
      posts.sort((a, b) => (a.date > b.date ? 1 : -1));

      for (const post of posts) {
        if (this.store.hasSeenPost(post.id)) continue;
        found += 1;
        await this._handleNewPost(post);
      }

      this.store.setMeta('lastPollAt', new Date().toISOString());
      bus.emit('watcher:tick', { at: new Date().toISOString(), checked: posts.length, found });
      log.info(`Poll complete: checked ${posts.length}, new ${found}`);
    } catch (err) {
      log.error('Poll error', { error: String(err) });
      throw err;
    } finally {
      this.running = false;
    }
    return { found };
  }

  async _handleNewPost(post) {
    log.info(`New post: ${post.title}`, { id: post.id });
    let options = [];
    let meta = { poster: '', rating: '', synopsis: '' };
    try {
      const full = await this.client.getPost(post.id);
      options = parseDownloadOptions(full.contentHtml);
      meta = parsePostMetadata(full.contentHtml);
    } catch (err) {
      log.warn('Failed to fetch/parse post content', { id: post.id, error: String(err) });
    }

    const isSeries = checkIsSeries(post.title, options);

    const entry = {
      id: post.id,
      title: post.title,
      link: post.link,
      date: post.date,
      seenAt: new Date().toISOString(),
      options,
      poster: meta.poster,
      rating: meta.rating,
      synopsis: meta.synopsis,
      isSeries,
    };
    this.store.markPost(entry);
    bus.emit('post:new', entry);

    if (!this.config.watcher.autoResolve) {
      log.info('autoResolve disabled — leaving post for manual resolution', { id: post.id });
      return;
    }

    if (isSeries && this.config.watcher.onlyCompleteSeries && !/complete/i.test(post.title)) {
      log.info('Skipping auto-resolve for in-progress series (does not contain "Complete" in title)', { id: post.id, title: post.title });
      return;
    }

    const selected = selectOptions(options, {
      providers: this.config.watcher.preferredProviders,
      qualities: this.config.watcher.preferredQualities,
      codecs: this.config.watcher.preferredCodecs || ['x265', 'x264'],
      seriesType: this.config.watcher.preferredSeriesType || 'batch',
      isSeries,
    });

    if (selected.length === 0) {
      log.info('No matching download options to auto-resolve', { id: post.id, total: options.length });
      return;
    }

    for (const opt of selected) {
      this.queue.enqueue({
        postId: post.id,
        title: post.title,
        postLink: post.link,
        provider: opt.provider,
        quality: opt.quality,
        qualityLabel: opt.qualityLabel,
        sizeLabel: opt.sizeLabel,
        url: opt.url,
      });
    }
    log.info(`Enqueued ${selected.length} bypass job(s)`, { id: post.id });
  }
}

export default Watcher;
