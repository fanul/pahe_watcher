// configManager.js coordinates configuration override mapping & persistence.
import { createLogger } from './core/logger.js';
import { createCaptchaSolver } from './bypass/captcha/index.js';
import {
  getPublicWatcherConfig,
  applyWatcherOverrides,
  mergeWatcherOverrides
} from './config/watcher.js';
import {
  getPublicBypassConfig,
  applyBypassOverrides,
  mergeBypassOverrides
} from './config/bypass.js';
import {
  getPublicSheetsConfig,
  applySheetsOverrides,
  mergeSheetsOverrides,
  handleSheetsKeyFile
} from './config/sheets.js';
import {
  getPublicJdownloaderConfig,
  applyJdownloaderOverrides,
  mergeJdownloaderOverrides
} from './config/jdownloader.js';
import {
  getPublicDriveBackupConfig,
  applyDriveBackupOverrides,
  mergeDriveBackupOverrides
} from './config/driveBackup.js';
import {
  getPublicSyncConfig,
  applySyncOverrides,
  mergeSyncOverrides
} from './config/sync.js';
import {
  getPublicDeadLinkReportConfig,
  applyDeadLinkReportOverrides,
  mergeDeadLinkReportOverrides
} from './config/deadLinkReport.js';

const log = createLogger('app:config');

export function getPublicConfig(runtime, sheets, jdownloader, driveBackup) {
  return {
    watcher: getPublicWatcherConfig(runtime),
    bypass: getPublicBypassConfig(runtime),
    sheets: getPublicSheetsConfig(runtime, sheets),
    jdownloader: getPublicJdownloaderConfig(runtime, jdownloader),
    driveBackup: getPublicDriveBackupConfig(runtime, driveBackup),
    sync: getPublicSyncConfig(runtime),
    deadLinkReport: getPublicDeadLinkReportConfig(runtime),
  };
}

export async function updateConfig(runtime, store, sheets, bypass, watcher, patch, jdownloader, driveBackup) {
  // Handle Sheets Key file creation/removal
  handleSheetsKeyFile(runtime, patch, log);

  // Apply overrides to runtime config
  applyOverrides(runtime, patch);

  // Persist overrides in store
  store.setMeta('configOverrides', mergeOverrides(store.getMeta('configOverrides', {}), patch));

  // Reload Sheets Client variables
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

  // Reload JDownloader client credentials — force a fresh connect() next use
  if (patch?.jdownloader && jdownloader) {
    jdownloader.email = runtime.jdownloader.email;
    jdownloader.password = runtime.jdownloader.password;
    jdownloader.deviceName = runtime.jdownloader.deviceName;
    jdownloader.autostart = runtime.jdownloader.autostart;
    await jdownloader.close().catch(() => {});
  }

  // Reload Drive backup client fields — force a fresh client next use
  if (patch?.driveBackup && driveBackup) {
    driveBackup.folderId = runtime.driveBackup.folderId;
    driveBackup.clientId = runtime.driveBackup.oauthClientId;
    driveBackup.clientSecret = runtime.driveBackup.oauthClientSecret;
    driveBackup.refreshToken = runtime.driveBackup.oauthRefreshToken;
    driveBackup.drive = null;
  }

  // Restart Browser if bypass settings changed
  if (patch?.bypass) {
    if (
      patch.bypass.browserMode !== undefined || 
      patch.bypass.cdpEnabled !== undefined ||
      patch.bypass.cdpUrl !== undefined ||
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

  // Re-arm Watcher interval if poll interval changed
  if (patch?.watcher?.pollIntervalSeconds && watcher.timer) {
    watcher.stop();
    watcher.start();
  }

  // Re-arm the optional backfill auto-run timer if its settings changed
  if (patch?.sync && (patch.sync.backfillAutoRun !== undefined || patch.sync.backfillIntervalSeconds !== undefined)) {
    watcher._armBackfillAutoRun();
  }

  log.info('Runtime config updated', patch);
  return getPublicConfig(runtime, sheets, jdownloader, driveBackup);
}

export function applyOverrides(runtime, patch) {
  applyWatcherOverrides(runtime, patch);
  applyBypassOverrides(runtime, patch);
  applySheetsOverrides(runtime, patch);
  applyJdownloaderOverrides(runtime, patch);
  applyDriveBackupOverrides(runtime, patch);
  applySyncOverrides(runtime, patch);
  applyDeadLinkReportOverrides(runtime, patch);
  return runtime;
}

export function mergeOverrides(existing, patch) {
  return {
    watcher: mergeWatcherOverrides(existing, patch),
    bypass: mergeBypassOverrides(existing, patch),
    sheets: mergeSheetsOverrides(existing, patch),
    jdownloader: mergeJdownloaderOverrides(existing, patch),
    driveBackup: mergeDriveBackupOverrides(existing, patch),
    sync: mergeSyncOverrides(existing, patch),
    deadLinkReport: mergeDeadLinkReportOverrides(existing, patch),
  };
}
