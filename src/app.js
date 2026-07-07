import { config as frozenConfig } from './config/index.js';
import { createLogger, setLevel } from './core/logger.js';
import { Store } from './core/store.js';
import { Watcher } from './watcher/watcher.js';
import { JobQueue } from './queue/jobQueue.js';
import { SheetsClient } from './sheets/sheetsClient.js';
import { BypassEngine } from './bypass/index.js';

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

  const store = new Store(runtime.store.path);

  // Re-apply any persisted runtime overrides from a previous session.
  const overrides = store.getMeta('configOverrides', null);
  if (overrides) applyOverrides(runtime, overrides);

  const sheets = new SheetsClient({
    keyFile: runtime.sheets.serviceAccountKey,
    sheetId: runtime.sheets.sheetId,
    tab: runtime.sheets.tab,
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
    if (sheets.enabled) {
      await sheets.appendResolved(row).catch((err) => {
        ctx.log?.(`Sheet append failed: ${err.message}`);
        log.error('Sheet append failed', { error: String(err) });
      });
    } else {
      ctx.log?.('Sheets not configured — resolved link stored in job result only.');
    }
    return row;
  });

  const app = {
    runtime,
    store,
    sheets,
    queue,
    bypass,
    watcher,

    getPublicConfig() {
      return {
        watcher: {
          pollIntervalSeconds: runtime.watcher.pollIntervalSeconds,
          perPage: runtime.watcher.perPage,
          preferredProviders: runtime.watcher.preferredProviders,
          preferredQualities: runtime.watcher.preferredQualities,
          autoResolve: runtime.watcher.autoResolve,
        },
        bypass: {
          browserMode: runtime.bypass.browserMode,
          concurrency: runtime.bypass.concurrency,
          captchaProvider: runtime.bypass.captcha.provider,
        },
        sheets: { sheetId: runtime.sheets.sheetId, tab: runtime.sheets.tab, configured: sheets.enabled },
      };
    },

    updateConfig(patch) {
      const merged = applyOverrides(runtime, patch);
      store.setMeta('configOverrides', mergeOverrides(store.getMeta('configOverrides', {}), patch));
      // Re-arm watcher interval if it changed.
      if (patch?.watcher?.pollIntervalSeconds && watcher.timer) {
        watcher.stop();
        watcher.start();
      }
      log.info('Runtime config updated', patch);
      return this.getPublicConfig();
    },

    async shutdown() {
      log.info('Shutting down…');
      watcher.stop();
      await bypass.close().catch(() => {});
      store.flushNow();
    },
  };

  queue.hydrate();
  return app;
}

/** Apply a shallow-ish override patch onto the runtime config in place. */
function applyOverrides(runtime, patch) {
  if (patch.watcher) Object.assign(runtime.watcher, patch.watcher);
  if (patch.bypass) {
    const { captcha, ...rest } = patch.bypass;
    Object.assign(runtime.bypass, rest);
    if (captcha) Object.assign(runtime.bypass.captcha, captcha);
  }
  if (patch.sheets) Object.assign(runtime.sheets, patch.sheets);
  return runtime;
}

function mergeOverrides(existing, patch) {
  return {
    watcher: { ...(existing.watcher || {}), ...(patch.watcher || {}) },
    bypass: { ...(existing.bypass || {}), ...(patch.bypass || {}) },
    sheets: { ...(existing.sheets || {}), ...(patch.sheets || {}) },
  };
}

export default createApp;
