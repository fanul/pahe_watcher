import { randomUUID } from 'node:crypto';
import { createLogger } from '../core/logger.js';
import { bus } from '../core/eventBus.js';

const log = createLogger('queue');

/**
 * Job lifecycle: queued -> running -> (done | failed | needs-captcha)
 * A `needs-captcha` job is paused waiting for manual GUI intervention, then
 * resumed back into `running` by the worker.
 */
export const JobStatus = {
  QUEUED: 'queued',
  RUNNING: 'running',
  NEEDS_CAPTCHA: 'needs-captcha',
  DONE: 'done',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
};

/**
 * In-memory concurrency-limited job queue with retries, backed by the Store for
 * persistence/visibility. The `processor` is an async fn (job, ctx) => result.
 */
export class JobQueue {
  constructor({ store, concurrency = 1, maxRetries = 2 }) {
    this.store = store;
    this.concurrency = Math.max(1, concurrency);
    this.maxRetries = maxRetries;
    this.processor = null;
    this.pending = []; // job ids awaiting a worker
    this.active = new Set(); // job ids currently running
    this.paused = false;
  }

  setProcessor(fn) {
    this.processor = fn;
  }

  /** Re-load queued jobs from the store on startup (resume after restart). */
  hydrate() {
    for (const job of this.store.listJobs()) {
      if (job.status === JobStatus.QUEUED || job.status === JobStatus.RUNNING) {
        // Anything left "running" from a previous process is requeued.
        job.status = JobStatus.QUEUED;
        this.store.upsertJob(job);
        this.pending.push(job.id);
      }
    }
    if (this.pending.length) log.info(`Hydrated ${this.pending.length} pending job(s)`);
    this._drain();
  }

  enqueue(payload) {
    const job = {
      id: randomUUID(),
      status: JobStatus.QUEUED,
      attempts: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      logs: [],
      result: null,
      error: null,
      ...payload,
    };
    this.store.upsertJob(job);
    this.pending.push(job.id);
    bus.emit('job:created', job);
    log.info(`Enqueued job ${job.id.slice(0, 8)} (${payload.provider} ${payload.quality})`, {
      title: payload.title,
    });
    this._drain();
    return job;
  }

  setPaused(paused) {
    this.paused = paused;
    log.info(`Queue ${paused ? 'paused' : 'resumed'}`);
    if (!paused) this._drain();
  }

  cancel(jobId) {
    const job = this.store.getJob(jobId);
    if (!job) return false;
    if (job.status === JobStatus.QUEUED) {
      this.pending = this.pending.filter((id) => id !== jobId);
      this._update(job, { status: JobStatus.CANCELLED });
      return true;
    }
    return false; // running jobs can't be cancelled synchronously (kept simple)
  }

  /** Retry a failed/cancelled job. */
  retry(jobId) {
    const job = this.store.getJob(jobId);
    if (!job) return false;
    if ([JobStatus.FAILED, JobStatus.CANCELLED].includes(job.status)) {
      this._update(job, { status: JobStatus.QUEUED, error: null });
      this.pending.push(job.id);
      this._drain();
      return true;
    }
    return false;
  }

  _update(job, patch) {
    const updated = this.store.upsertJob({ ...job, ...patch, updatedAt: new Date().toISOString() });
    bus.emit('job:updated', updated);
    return updated;
  }

  jobLog(jobId, msg) {
    const job = this.store.getJob(jobId);
    if (!job) return;
    const line = { ts: new Date().toISOString(), msg };
    job.logs = [...(job.logs || []), line].slice(-200);
    this.store.upsertJob(job);
    bus.emit('job:log', { jobId, ...line });
  }

  _drain() {
    if (this.paused || !this.processor) return;
    while (this.active.size < this.concurrency && this.pending.length > 0) {
      const jobId = this.pending.shift();
      const job = this.store.getJob(jobId);
      if (!job || job.status === JobStatus.CANCELLED) continue;
      this._run(job);
    }
  }

  async _run(job) {
    this.active.add(job.id);
    this._update(job, { status: JobStatus.RUNNING, attempts: (job.attempts || 0) + 1 });
    const ctx = {
      log: (msg) => this.jobLog(job.id, msg),
      // The processor calls this when it needs manual captcha help; it returns
      // a promise that resolves once the GUI marks the captcha solved.
      setStatus: (status) => this._update(this.store.getJob(job.id), { status }),
    };

    try {
      const result = await this.processor(this.store.getJob(job.id), ctx);
      this._update(this.store.getJob(job.id), { status: JobStatus.DONE, result, error: null });
      log.info(`Job ${job.id.slice(0, 8)} done`);
    } catch (err) {
      const fresh = this.store.getJob(job.id);
      const canRetry = (fresh.attempts || 1) <= this.maxRetries;
      if (canRetry) {
        log.warn(`Job ${job.id.slice(0, 8)} failed (attempt ${fresh.attempts}), requeueing`, {
          error: String(err),
        });
        this._update(fresh, { status: JobStatus.QUEUED, error: String(err) });
        this.pending.push(job.id);
      } else {
        log.error(`Job ${job.id.slice(0, 8)} failed permanently`, { error: String(err) });
        this._update(fresh, { status: JobStatus.FAILED, error: String(err) });
      }
    } finally {
      this.active.delete(job.id);
      this._drain();
    }
  }

  stats() {
    const jobs = this.store.listJobs();
    const by = (s) => jobs.filter((j) => j.status === s).length;
    return {
      queued: by(JobStatus.QUEUED),
      running: by(JobStatus.RUNNING),
      needsCaptcha: by(JobStatus.NEEDS_CAPTCHA),
      done: by(JobStatus.DONE),
      failed: by(JobStatus.FAILED),
      total: jobs.length,
    };
  }
}

export default JobQueue;
