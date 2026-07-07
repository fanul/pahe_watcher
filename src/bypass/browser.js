import fs from 'node:fs';
import { createLogger } from '../core/logger.js';
import { pageAutomation } from './userscript.js';

const log = createLogger('browser');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

/**
 * Manages a single persistent Chromium context (via Playwright). Persisting the
 * profile keeps the GDFlix login/cookies between jobs and restarts.
 *
 * Playwright is imported lazily so the rest of the app (watcher, server) can run
 * even before `npm run install:browser` has downloaded Chromium.
 */
export class BrowserManager {
  constructor({ profileDir, headless = true }) {
    this.profileDir = profileDir;
    this.headless = headless;
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
    this.context = await this._chromium.launchPersistentContext(this.profileDir, {
      headless: this.headless,
      userAgent: UA,
      viewport: { width: 1366, height: 768 },
      args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
    });
    // Inject the ad-chain automation into every page/navigation.
    await this.context.addInitScript(pageAutomation);
    return this.context;
  }

  /** Open a fresh page with the automation injected. */
  async newPage() {
    const ctx = await this._ensureContext();
    const page = await ctx.newPage();
    page.setDefaultTimeout(45_000);
    // Block obvious heavy ad/media resources to speed navigation.
    await page.route('**/*', (route) => {
      const type = route.request().resourceType();
      if (type === 'media' || type === 'font') return route.abort();
      return route.continue();
    });
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
