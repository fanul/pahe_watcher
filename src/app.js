import { config as frozenConfig } from './config/index.js';
import { createLogger, setLevel } from './core/logger.js';
import { Store } from './core/store.js';
import { Watcher } from './watcher/watcher.js';
import { JobQueue } from './queue/jobQueue.js';
import { SheetsClient } from './sheets/sheetsClient.js';
import { JDownloaderClient } from './jdownloader/jdownloaderClient.js';
import { BypassEngine } from './bypass/index.js';
import { bus } from './core/eventBus.js';
import {
  getPublicConfig,
  updateConfig,
  applyOverrides
} from './configManager.js';

const log = createLogger('app');

/**
 * Wires the whole system together and exposes a single `app` context object
 * shared with the server/API. Holds a mutable `runtime` config (deep clone of
 * the loaded config) so a subset of settings can be changed live via the GUI
 * and persisted to the store.
 */
export async function createApp() {
  setLevel(frozenConfig.logging.level);
  const runtime = structuredClone(frozenConfig);

  const store = new Store({ sqlitePath: runtime.store.sqlitePath, jsonPath: runtime.store.path });

  // Re-apply any persisted runtime overrides from a previous session.
  const overrides = store.getMeta('configOverrides', null);
  if (overrides) applyOverrides(runtime, overrides);

  const sheets = new SheetsClient({
    keyFile: runtime.sheets.serviceAccountKey,
    sheetId: runtime.sheets.sheetId,
    tab: runtime.sheets.tab,
  });

  const jdownloader = new JDownloaderClient({
    email: runtime.jdownloader.email,
    password: runtime.jdownloader.password,
    deviceName: runtime.jdownloader.deviceName,
    autostart: runtime.jdownloader.autostart,
  });

  const queue = new JobQueue({
    store,
    concurrency: runtime.bypass.concurrency,
    maxRetries: runtime.bypass.maxRetries,
  });

  const bypass = new BypassEngine({ config: runtime });

  const watcher = new Watcher({ config: runtime, store, queue });

  // The queue processor: resolve the link via the bypass engine, then log it to
  // the sheet. Kept here so the queue stays transport-agnostic.
  queue.setProcessor(async (job, ctx) => {
    ctx.jobId = job.id;
    const resolved = await bypass.resolve(job, ctx);
    const row = {
      resolvedAt: new Date().toISOString(),
      title: job.title,
      provider: job.provider,
      quality: job.quality,
      sizeLabel: job.sizeLabel,
      finalUrl: resolved.finalUrl,
      linkType: resolved.linkType,
      postLink: job.postLink,
      sourceUrl: job.url,
    };
    // Save the resolved result on the job in the database first, so that even if subsequent steps (like sheets) fail,
    // the resolved link is already captured and visible in the GUI!
    const currentJob = store.getJob(job.id);
    if (currentJob) {
      currentJob.result = row;
      store.upsertJob(currentJob);
    }

    if (sheets.enabled) {
      try {
        await sheets.appendResolved(row);
      } catch (err) {
        ctx.log?.(`Sheet append failed: ${err.message}`);
        log.error('Sheet append failed', { error: String(err) });
        throw err;
      }
    } else {
      ctx.log?.('Sheets not configured — resolved link stored in job result only.');
    }

    // Push to JDownloader last, and deliberately non-fatal: the link is
    // already resolved and saved above (and logged to the sheet, if
    // configured) by this point — a JDownloader hiccup (device offline,
    // bad credentials) shouldn't fail the whole job and force a costly
    // re-run of the entire ad-chain just to retry this convenience step.
    // Recorded on the row (null = not configured, true/false = attempted)
    // so the GUI can show a push-status badge next to the job's own status.
    row.jdownloaderPushed = null;
    if (jdownloader.enabled) {
      try {
        await jdownloader.addLink(row.finalUrl, { packageName: job.title });
        row.jdownloaderPushed = true;
        ctx.log?.('Pushed to JDownloader.');
      } catch (err) {
        row.jdownloaderPushed = false;
        row.jdownloaderError = err.message;
        ctx.log?.(`JDownloader push failed: ${err.message}`);
        log.error('JDownloader push failed', { error: String(err) });
      }
    }

    return row;
  });

  const app = {
    runtime,
    store,
    sheets,
    jdownloader,
    queue,
    bypass,
    watcher,

    getPublicConfig() {
      return getPublicConfig(runtime, sheets, jdownloader);
    },

    async updateConfig(patch) {
      return await updateConfig(runtime, store, sheets, bypass, watcher, patch, jdownloader);
    },

    async shutdown() {
      log.info('Shutting down…');
      watcher.stop();
      await bypass.close().catch(() => {});
      await jdownloader.close().catch(() => {});
      store.flushNow();
      store.close();
    },
  };

  bus.on('job:deleted', (jobId) => {
    bypass.abort(jobId).catch(() => {});
  });
  bus.on('job:cancelled', (jobId) => {
    bypass.abort(jobId).catch(() => {});
  });
  bus.on('queue:idle', () => {
    bypass.close().catch(() => {});
  });
  bus.on('queue:paused', (paused) => {
    if (paused) {
      bypass.close().catch(() => {});
    }
  });

  queue.hydrate();
  return app;
}

export default createApp;
