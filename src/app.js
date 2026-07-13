import fs from 'node:fs';
import path from 'node:path';
import { config as frozenConfig } from './config/index.js';
import { createLogger, setLevel } from './core/logger.js';
import { Store } from './core/store.js';
import { Watcher } from './watcher/watcher.js';
import { JobQueue } from './queue/jobQueue.js';
import { SheetsClient } from './sheets/sheetsClient.js';
import { BypassEngine } from './bypass/index.js';
import { createCaptchaSolver } from './bypass/captcha/index.js';

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
      let serviceAccountKeyContent = '';
      try {
        if (fs.existsSync(runtime.sheets.serviceAccountKey)) {
          serviceAccountKeyContent = fs.readFileSync(runtime.sheets.serviceAccountKey, 'utf8');
        }
      } catch {}

      return {
        watcher: {
          pollIntervalSeconds: runtime.watcher.pollIntervalSeconds,
          perPage: runtime.watcher.perPage,
          preferredProviders: runtime.watcher.preferredProviders,
          preferredQualities: runtime.watcher.preferredQualities,
          preferredCodecs: runtime.watcher.preferredCodecs,
          preferredSeriesType: runtime.watcher.preferredSeriesType,
          onlyCompleteSeries: runtime.watcher.onlyCompleteSeries,
          autoResolve: runtime.watcher.autoResolve,
        },
        bypass: {
          browserMode: runtime.bypass.browserMode,
          initialPageDelaySeconds: runtime.bypass.initialPageDelaySeconds,
          concurrency: runtime.bypass.concurrency,
          captchaProvider: runtime.bypass.captcha.provider,
          twoCaptchaApiKey: runtime.bypass.captcha.twoCaptchaApiKey,
          flaresolverrUrl: runtime.bypass.captcha.flaresolverrUrl,
          byparrUrl: runtime.bypass.captcha.byparrUrl,
          startServicesOnStart: runtime.bypass.captcha.startServicesOnStart,
          gdflixEmail: runtime.bypass.gdflix.email,
          gdflixPassword: runtime.bypass.gdflix.password,
          gdflixCookies: runtime.bypass.gdflix.cookies,
          stealth: runtime.bypass.stealth,
          speedUpExclusions: runtime.bypass.speedUpExclusions,
          tabPruningWhitelist: runtime.bypass.tabPruningWhitelist,
          pruneAdTabs: runtime.bypass.pruneAdTabs,
          injectOuoScript: runtime.bypass.injectOuoScript,
          speedUpPahe: runtime.bypass.speedUpPahe,
          removeOuoAds: runtime.bypass.removeOuoAds,
        },
        sheets: {
          sheetId: runtime.sheets.sheetId,
          tab: runtime.sheets.tab,
          configured: sheets.enabled,
          serviceAccountKey: runtime.sheets.serviceAccountKey,
          serviceAccountKeyContent,
        },
      };
    },

    async updateConfig(patch) {
      if (patch?.sheets && patch.sheets.serviceAccountKeyContent !== undefined) {
        const keyContent = patch.sheets.serviceAccountKeyContent;
        const keyPath = runtime.sheets.serviceAccountKey;
        if (keyContent) {
          try {
            fs.mkdirSync(path.dirname(keyPath), { recursive: true });
            fs.writeFileSync(keyPath, keyContent, 'utf8');
            log.info(`Wrote Google Sheets Service Account Key to ${keyPath}`);
          } catch (err) {
            log.error(`Failed to write Service Account Key to ${keyPath}`, { error: err.message });
          }
        } else {
          try {
            if (fs.existsSync(keyPath)) {
              fs.unlinkSync(keyPath);
              log.info(`Deleted Google Sheets Service Account Key file ${keyPath}`);
            }
          } catch (err) {
            log.error(`Failed to delete Service Account Key file ${keyPath}`, { error: err.message });
          }
        }
        delete patch.sheets.serviceAccountKeyContent;
      }

      const merged = applyOverrides(runtime, patch);
      store.setMeta('configOverrides', mergeOverrides(store.getMeta('configOverrides', {}), patch));

      if (patch?.sheets) {
        if (patch.sheets.sheetId !== undefined) {
          sheets.sheetId = runtime.sheets.sheetId;
        }
        if (patch.sheets.tab !== undefined) {
          sheets.tab = runtime.sheets.tab;
        }
        sheets.sheets = null;
        sheets._headerEnsured = false;
      }

      if (patch?.bypass) {
        if (
          patch.bypass.browserMode !== undefined || 
          patch.bypass.initialPageDelaySeconds !== undefined ||
          patch.bypass.stealth !== undefined ||
          patch.bypass.speedUpExclusions !== undefined ||
          patch.bypass.tabPruningWhitelist !== undefined ||
          patch.bypass.pruneAdTabs !== undefined ||
          patch.bypass.injectOuoScript !== undefined ||
          patch.bypass.speedUpPahe !== undefined ||
          patch.bypass.removeOuoAds !== undefined
        ) {
          await bypass.close().catch(() => {});
          bypass.browser.headless = runtime.bypass.browserMode !== 'headful';
          bypass.browser.initialPageDelayMs = (runtime.bypass.initialPageDelaySeconds || 1.5) * 1000;
          bypass.browser.config = runtime;
        }
        bypass.captcha = createCaptchaSolver(runtime, {
          headless: runtime.bypass.browserMode !== 'headful',
        });
      }

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
    const { captcha, gdflix, ...rest } = patch.bypass;
    Object.assign(runtime.bypass, rest);
    if (captcha) Object.assign(runtime.bypass.captcha, captcha);
    if (gdflix) Object.assign(runtime.bypass.gdflix, gdflix);
  }
  if (patch.sheets) Object.assign(runtime.sheets, patch.sheets);
  return runtime;
}

function mergeOverrides(existing, patch) {
  const existingBypass = existing.bypass || {};
  const patchBypass = patch.bypass || {};
  return {
    watcher: { ...(existing.watcher || {}), ...(patch.watcher || {}) },
    bypass: {
      ...existingBypass,
      ...patchBypass,
      captcha: { ...(existingBypass.captcha || {}), ...(patchBypass.captcha || {}) },
      gdflix: { ...(existingBypass.gdflix || {}), ...(patchBypass.gdflix || {}) }
    },
    sheets: { ...(existing.sheets || {}), ...(patch.sheets || {}) },
  };
}

export default createApp;
