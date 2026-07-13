import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from './logger.js';

const log = createLogger('store');

/**
 * Minimal JSON-file persistence with an in-memory cache and atomic writes.
 *
 * Intentionally dependency-free and swappable: the public surface
 * (getSeenPost / markPost / upsertJob / listJobs / getMeta / setMeta) is all
 * the app uses, so this can later be replaced by SQLite/Postgres without
 * touching callers. See ARCHITECTURE.md.
 */
export class Store {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = {
      posts: {}, // postId -> { id, title, link, date, seenAt, options }
      jobs: {}, // jobId  -> Job
      meta: {}, // arbitrary key/value (e.g. lastPollAt, highestPostId)
    };
    this._dirty = false;
    this._flushTimer = null;
    this._load();
  }

  _load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf8');
        const parsed = JSON.parse(raw);
        this.data = { posts: {}, jobs: {}, meta: {}, ...parsed };
        log.info('State loaded', {
          posts: Object.keys(this.data.posts).length,
          jobs: Object.keys(this.data.jobs).length,
        });
      } else {
        fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
        this._flush(true);
      }
    } catch (err) {
      log.error('Failed to load state, starting fresh', { error: String(err) });
    }
  }

  _scheduleFlush() {
    this._dirty = true;
    if (this._flushTimer) return;
    this._flushTimer = setTimeout(() => {
      this._flushTimer = null;
      this._flush();
    }, 250);
  }

  _flush(force = false) {
    if (!this._dirty && !force) return;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
      fs.renameSync(tmp, this.filePath);
      this._dirty = false;
    } catch (err) {
      log.error('Failed to persist state', { error: String(err) });
    }
  }

  /** Force a synchronous flush (call on shutdown). */
  flushNow() {
    if (this._flushTimer) {
      clearTimeout(this._flushTimer);
      this._flushTimer = null;
    }
    this._flush(true);
  }

  // ── posts ──
  hasSeenPost(id) {
    return Boolean(this.data.posts[String(id)]);
  }
  getPost(id) {
    return this.data.posts[String(id)] || null;
  }
  markPost(post) {
    this.data.posts[String(post.id)] = { ...post, seenAt: post.seenAt || new Date().toISOString() };
    this._scheduleFlush();
  }
  listPosts() {
    return Object.values(this.data.posts).sort((a, b) => (a.date < b.date ? 1 : -1));
  }

  // ── jobs ──
  upsertJob(job) {
    this.data.jobs[job.id] = { ...this.data.jobs[job.id], ...job };
    this._scheduleFlush();
    return this.data.jobs[job.id];
  }
  deleteJob(id) {
    if (this.data.jobs[id]) {
      delete this.data.jobs[id];
      this._scheduleFlush();
      return true;
    }
    return false;
  }
  getJob(id) {
    return this.data.jobs[id] || null;
  }
  listJobs() {
    return Object.values(this.data.jobs).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  // ── meta ──
  getMeta(key, fallback = null) {
    return key in this.data.meta ? this.data.meta[key] : fallback;
  }
  setMeta(key, value) {
    this.data.meta[key] = value;
    this._scheduleFlush();
  }
}

export default Store;
