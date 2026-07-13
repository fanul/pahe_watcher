import fs from 'node:fs';
import { createLogger } from '../core/logger.js';
import { getInjectedAutomationScript } from './userscript.js';

const log = createLogger('browser');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36';

/**
 * Manages a single persistent Chromium context.
 *
 * Engine:
 *   - "patchright" (default): an undetected Playwright fork that closes the
 *     `Runtime.enable` CDP leak Cloudflare uses to fingerprint Playwright. This
 *     is what lets ouo.io's Turnstile auto-issue a token (or stay solvable).
 *     Pairs with a real Chrome install via `channel: "chrome"`.
 *   - "playwright": stock Playwright + manual stealth init scripts (fallback).
 *
 * Persisting the profile keeps GDFlix login/cookies AND warms the Cloudflare
 * fingerprint between jobs, which materially raises the Turnstile pass rate.
 */
export class BrowserManager {
  constructor({ profileDir, headless = true, initialPageDelayMs = 1500, config = {} }) {
    this.profileDir = profileDir;
    this.headless = headless;
    this.initialPageDelayMs = initialPageDelayMs;
    this.config = config;
    this.context = null;
    this._engine = null; // { chromium, name }
  }

  async _loadEngine() {
    if (this._engine) return this._engine;
    const want = this.config?.bypass?.stealth?.engine || 'patchright';
    if (want === 'patchright') {
      try {
        const pw = await import('patchright');
        log.info('Using stealth engine: patchright (undetected)');
        this._engine = { chromium: pw.chromium, name: 'patchright' };
        return this._engine;
      } catch (err) {
        log.warn(`patchright unavailable (${err.message}); falling back to playwright`);
      }
    }
    const pw = await import('playwright').catch((err) => {
      throw new Error(`Playwright not available (${err.message}). Run: npm install && npm run install:browser`);
    });
    log.info('Using stealth engine: playwright (stock)');
    this._engine = { chromium: pw.chromium, name: 'playwright' };
    return this._engine;
  }

  async _ensureContext() {
    if (this.context) return this.context;
    const { chromium, name: engine } = await this._loadEngine();
    const isPatchright = engine === 'patchright';

    fs.mkdirSync(this.profileDir, { recursive: true });
    const stealth = this.config?.bypass?.stealth || {};

    // Which browser binary: real Chrome ("chrome") is best for Turnstile; empty
    // string or "chromium" uses the bundled build.
    const channelCfg = stealth.chromeChannel ?? 'chrome';
    const channel = channelCfg && channelCfg !== 'chromium' ? channelCfg : null;

    const launchOptions = {
      headless: this.headless,
      viewport: { width: 1366, height: 768 },
    };
    if (channel) launchOptions.channel = channel;

    // patchright manages its own anti-detection; adding automation flags,
    // custom UAs, or stealth init scripts can REINTRODUCE detectable patterns.
    // So we only apply the manual hardening on the stock-playwright path.
    if (!isPatchright) {
      if (stealth.useStealthUserAgent !== false && this.headless) launchOptions.userAgent = UA;
      const ignoreDefaultArgs = [];
      const args = [];
      if (stealth.disableAutomationFlag !== false) {
        ignoreDefaultArgs.push('--enable-automation');
        args.push('--disable-blink-features=AutomationControlled');
      }
      if (stealth.useNoSandbox !== false) args.push('--no-sandbox');
      if (ignoreDefaultArgs.length) launchOptions.ignoreDefaultArgs = ignoreDefaultArgs;
      launchOptions.args = args;
    } else {
      // Minimal, non-fingerprintable args only.
      launchOptions.args = stealth.useNoSandbox !== false ? ['--no-sandbox'] : [];
    }

    log.info(`Launching ${engine} (${this.headless ? 'headless' : 'headful'}${channel ? `, channel=${channel}` : ''})`, {
      profile: this.profileDir,
    });

    this.context = await this._launchWithFallback(chromium, launchOptions, channel);

    this.context.on('close', () => {
      this.context = null;
      log.info('Browser context closed (process exited)');
    });

    // Surface [pahe-auto] page logs into the app log.
    this.context.on('page', (p) => {
      p.on('console', (msg) => {
        const text = msg.text();
        if (text.includes('[pahe-auto]') || text.includes('[node-auto]')) log.info(`[Page Log] ${text}`);
      });
    });

    // ── functional init scripts (safe, not stealth) ──
    await this.context.addInitScript((d) => { window.__paheDelayMs = d; }, this.initialPageDelayMs);

    const exclusions = this.config?.bypass?.speedUpExclusions ||
      ['oii.la', 'linegee.net', 'tpi.li', 'pahe.plus', 'ouo.io', 'ouo.press'];
    await this.context.addInitScript((ex) => { window.__paheSpeedUpExclusions = ex; }, exclusions);

    // ── manual stealth init scripts: ONLY on the stock-playwright path ──
    if (!isPatchright) {
      if (stealth.maskWebdriver !== false) {
        await this.context.addInitScript(() => {
          try { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); } catch {}
        });
      }
      if (stealth.spoofCanvasFingerprint === true) {
        await this.context.addInitScript(() => {
          try {
            const orig = HTMLCanvasElement.prototype.getContext;
            HTMLCanvasElement.prototype.getContext = function (type, ...a) {
              const c = orig.apply(this, [type, ...a]);
              if (type === '2d' && c) {
                const gi = c.getImageData;
                c.getImageData = function (...args) {
                  const d = gi.apply(this, args);
                  for (let i = 0; i < d.data.length; i += 4) d.data[i] = d.data[i] ^ 1;
                  return d;
                };
              }
              return c;
            };
          } catch {}
        });
      }
    }

    // The ad-chain rule automation (must always be injected).
    await this.context.addInitScript(getInjectedAutomationScript(this.config));
    return this.context;
  }

  /** Launch, and if a requested Chrome channel is missing, retry on bundled Chromium. */
  async _launchWithFallback(chromium, launchOptions, channel) {
    try {
      return await chromium.launchPersistentContext(this.profileDir, launchOptions);
    } catch (err) {
      if (channel) {
        log.warn(`channel=${channel} launch failed (${err.message.split('\n')[0]}); retrying with bundled Chromium`);
        const { channel: _drop, ...rest } = launchOptions;
        return chromium.launchPersistentContext(this.profileDir, rest);
      }
      throw err;
    }
  }

  /** Open a fresh page with the automation injected. */
  async newPage() {
    const ctx = await this._ensureContext();
    const page = await ctx.newPage();
    page.setDefaultTimeout(45_000);

    const stealth = this.config?.bypass?.stealth || {};
    if (stealth.blockAdsAndTrackers !== false) {
      const AD_DOMAINS = [
        'adservice', 'google-analytics', 'popads', 'propeller', 'clickunder',
        'zq.trovesleepit.com', 'llvpn.com', 'freelygreatestscammer.com',
        'static.cloudflareinsights.com', 'googletagmanager',
      ];
      await page.route('**/*', (route) => {
        const url = route.request().url().toLowerCase();
        if (route.request().resourceType() !== 'document' && AD_DOMAINS.some((d) => url.includes(d))) {
          return route.abort();
        }
        return route.continue();
      });
    }
    return page;
  }

  async close() {
    if (this.context) {
      await this.context.close().catch(() => {});
      this.context = null;
      log.info('Browser context closed');
    }
  }
}

export default BrowserManager;
