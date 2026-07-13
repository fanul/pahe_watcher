import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

function readDefaults() {
  const p = path.join(ROOT, 'config', 'default.json');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function envStr(key, fallback) {
  const v = process.env[key];
  return v === undefined || v === '' ? fallback : v;
}
function envInt(key, fallback) {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? fallback : n;
}
function envList(key, fallback) {
  const v = process.env[key];
  if (v === undefined) return fallback;
  if (v.trim() === '') return [];
  return v.split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * Load layered configuration: config/default.json overridden by environment
 * variables (see .env.example). Returns a frozen, fully-resolved config object.
 * Paths are resolved to absolute against the project root.
 */
export function loadConfig() {
  const d = readDefaults();

  const cfg = {
    root: ROOT,
    server: {
      port: envInt('PORT', d.server.port),
      host: envStr('HOST', d.server.host),
      guiToken: envStr('GUI_TOKEN', d.server.guiToken),
    },
    watcher: {
      baseUrl: envStr('PAHE_BASE_URL', d.watcher.baseUrl).replace(/\/+$/, ''),
      pollIntervalSeconds: envInt('POLL_INTERVAL_SECONDS', d.watcher.pollIntervalSeconds),
      perPage: envInt('POLL_PER_PAGE', d.watcher.perPage),
      preferredProviders: envList('PREFERRED_PROVIDERS', d.watcher.preferredProviders),
      preferredQualities: envList('PREFERRED_QUALITIES', d.watcher.preferredQualities),
      preferredCodecs: envList('PREFERRED_CODECS', d.watcher.preferredCodecs),
      preferredSeriesType: envStr('PREFERRED_SERIES_TYPE', d.watcher.preferredSeriesType),
      onlyCompleteSeries: envStr('ONLY_COMPLETE_SERIES', String(d.watcher.onlyCompleteSeries)) !== 'false',
      autoResolve: envStr('AUTO_RESOLVE', String(d.watcher.autoResolve)) !== 'false',
    },
    bypass: {
      browserMode: envStr('BROWSER_MODE', d.bypass.browserMode),
      initialPageDelaySeconds: parseFloat(envStr('INITIAL_PAGE_DELAY_SECONDS', String(d.bypass.initialPageDelaySeconds))),
      concurrency: envInt('BYPASS_CONCURRENCY', d.bypass.concurrency),
      timeoutSeconds: envInt('BYPASS_TIMEOUT_SECONDS', d.bypass.timeoutSeconds),
      profileDir: path.resolve(ROOT, envStr('BROWSER_PROFILE_DIR', d.bypass.profileDir)),
      maxRetries: envInt('BYPASS_MAX_RETRIES', d.bypass.maxRetries),
      speedUpExclusions: envStr('BYPASS_SPEEDUP_EXCLUSIONS', (d.bypass.speedUpExclusions || []).join(',')).split(',').map(s => s.trim()).filter(Boolean),
      tabPruningWhitelist: envStr('BYPASS_TAB_PRUNING_WHITELIST', (d.bypass.tabPruningWhitelist || []).join(',')).split(',').map(s => s.trim()).filter(Boolean),
      stealth: {
        disableAutomationFlag: envStr('BYPASS_STEALTH_DISABLE_AUTOMATION_FLAG', String(d.bypass.stealth?.disableAutomationFlag)) !== 'false',
        useStealthUserAgent: envStr('BYPASS_STEALTH_USE_STEALTH_USER_AGENT', String(d.bypass.stealth?.useStealthUserAgent)) !== 'false',
        maskWebdriver: envStr('BYPASS_STEALTH_MASK_WEBDRIVER', String(d.bypass.stealth?.maskWebdriver)) !== 'false',
        blockAdsAndTrackers: envStr('BYPASS_STEALTH_BLOCK_ADS_AND_TRACKERS', String(d.bypass.stealth?.blockAdsAndTrackers)) !== 'false',
        spoofCanvasFingerprint: envStr('BYPASS_STEALTH_SPOOF_CANVAS_FINGERPRINT', String(d.bypass.stealth?.spoofCanvasFingerprint)) === 'true',
        useNoSandbox: envStr('BYPASS_STEALTH_USE_NO_SANDBOX', String(d.bypass.stealth?.useNoSandbox)) !== 'false',
      },
      captcha: {
        provider: envStr('CAPTCHA_PROVIDER', d.bypass.captcha.provider),
        twoCaptchaApiKey: envStr('TWOCAPTCHA_API_KEY', d.bypass.captcha.twoCaptchaApiKey),
        flaresolverrUrl: envStr('FLARESOLVERR_URL', d.bypass.captcha.flaresolverrUrl),
        byparrUrl: envStr('BYPARR_URL', d.bypass.captcha.byparrUrl),
        startServicesOnStart: envStr('START_CAPTCHA_SERVICES', String(d.bypass.captcha.startServicesOnStart)) !== 'false',
      },
      gdflix: {
        email: envStr('GDFLIX_EMAIL', d.bypass.gdflix.email),
        password: envStr('GDFLIX_PASSWORD', d.bypass.gdflix.password),
        cookies: envStr('GDFLIX_COOKIES', d.bypass.gdflix.cookies),
      },
    },
    sheets: {
      serviceAccountKey: path.resolve(ROOT, envStr('GOOGLE_SERVICE_ACCOUNT_KEY', d.sheets.serviceAccountKey)),
      sheetId: envStr('GOOGLE_SHEET_ID', d.sheets.sheetId),
      tab: envStr('GOOGLE_SHEET_TAB', d.sheets.tab),
    },
    store: {
      path: path.resolve(ROOT, envStr('STATE_PATH', d.store.path)),
    },
    logging: {
      level: envStr('LOG_LEVEL', d.logging.level),
    },
  };

  return Object.freeze(cfg);
}

export const config = loadConfig();
export default config;
