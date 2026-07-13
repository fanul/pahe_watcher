import fs from 'node:fs';
import { createLogger } from '../core/logger.js';
import { injectedAutomationScript } from './userscript.js';

const log = createLogger('browser');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36';

/**
 * Manages a single persistent Chromium context (via Playwright). Persisting the
 * profile keeps the GDFlix login/cookies between jobs and restarts.
 */
export class BrowserManager {
  constructor({ profileDir, headless = true, initialPageDelayMs = 1500, config = {} }) {
    this.profileDir = profileDir;
    this.headless = headless;
    this.initialPageDelayMs = initialPageDelayMs;
    this.config = config;
    this.context = null;
    this._chromium = null;
  }

  async _ensureContext() {
    if (this.context) return this.context;
    if (!this._chromium) {
      const pw = await import('playwright').catch((err) => {
        throw new Error(
          `Playwright not available (${err.message}). Run: npm install && npm run install:browser`,
        );
      });
      this._chromium = pw.chromium;
    }
    fs.mkdirSync(this.profileDir, { recursive: true });
    log.info(`Launching Chromium (${this.headless ? 'headless' : 'headful'})`, { profile: this.profileDir });

    const stealth = this.config?.bypass?.stealth || {};
    const launchOptions = {
      headless: this.headless,
      viewport: { width: 1366, height: 768 },
    };

    if (stealth.useStealthUserAgent !== false && this.headless) {
      launchOptions.userAgent = UA;
    }

    const ignoreDefaultArgs = [];
    if (stealth.disableAutomationFlag !== false) {
      ignoreDefaultArgs.push('--enable-automation');
    }
    if (ignoreDefaultArgs.length > 0) {
      launchOptions.ignoreDefaultArgs = ignoreDefaultArgs;
    }

    const args = [];
    if (stealth.disableAutomationFlag !== false) {
      args.push('--disable-blink-features=AutomationControlled');
    }
    if (stealth.useNoSandbox !== false) {
      args.push('--no-sandbox');
    }
    launchOptions.args = args;

    this.context = await this._chromium.launchPersistentContext(this.profileDir, launchOptions);

    this.context.on('close', () => {
      this.context = null;
      log.info('Browser context closed (process exited)');
    });

    // Listen to console events in all open pages/tabs
    this.context.on('page', (p) => {
      p.on('console', (msg) => {
        const text = msg.text();
        if (text.includes('[pahe-auto]')) {
          log.info(`[Page Log] ${text}`);
        }
      });
    });

    // Inject settings delay
    const delay = this.initialPageDelayMs;
    await this.context.addInitScript((d) => {
      window.__paheDelayMs = d;
    }, delay);

    // Inject speedup exclusions
    const exclusions = this.config?.bypass?.speedUpExclusions || ['oii.la', 'linegee.net', 'tpi.li', 'pahe.plus', 'ouo.io', 'ouo.press'];
    await this.context.addInitScript((ex) => {
      window.__paheSpeedUpExclusions = ex;
    }, exclusions);

    // Mask Webdriver
    if (stealth.maskWebdriver !== false) {
      await this.context.addInitScript(() => {
        try {
          Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        } catch {}
      });
    }

    // Spoof Canvas Fingerprint
    if (stealth.spoofCanvasFingerprint === true) {
      await this.context.addInitScript(() => {
        try {
          const originalGetContext = HTMLCanvasElement.prototype.getContext;
          HTMLCanvasElement.prototype.getContext = function(type, ...args) {
            const context = originalGetContext.apply(this, [type, ...args]);
            if (type === '2d' && context) {
              const originalGetImageData = context.getImageData;
              context.getImageData = function(...imgArgs) {
                const imgData = originalGetImageData.apply(this, imgArgs);
                // Add minor noise to canvas data to spoof canvas fingerprinting
                for (let i = 0; i < imgData.data.length; i += 4) {
                  imgData.data[i] = imgData.data[i] ^ 1;
                }
                return imgData;
              };
            }
            return context;
          };
        } catch {}
      });
    }

    // Inject the ad-chain automation into every page/navigation.
    await this.context.addInitScript(injectedAutomationScript);
    return this.context;
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
        'static.cloudflareinsights.com', 'googletagmanager'
      ];
      await page.route('**/*', (route) => {
        const url = route.request().url().toLowerCase();
        if (route.request().resourceType() !== 'document' && AD_DOMAINS.some(domain => url.includes(domain))) {
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
