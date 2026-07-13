import { createLogger } from '../core/logger.js';
import { BrowserManager } from './browser.js';
import { createCaptchaSolver, detectCaptcha } from './captcha/index.js';
import { isGdflixUrl, resolveGdflix, classifyFinalLink } from './resolvers/gdflix.js';

const log = createLogger('bypass');

const FINAL_HOST_RE = /(drive\.google\.com|googleusercontent\.com|pixeldrain\.|pixeldra\.in|workers\.dev|\.r2\.)/i;

/**
 * BypassEngine drives one job from a shortener entry URL through the ad chain to
 * the final Google Drive (or pixeldrain/direct) link.
 *
 * The injected page automation (userscript.js) auto-advances the known ad hosts;
 * this engine watches for the browser to land on a GDFlix page (or directly on a
 * final host), then runs the GDFlix resolver. Captcha handling is delegated to
 * the configured solver.
 */
export class BypassEngine {
  constructor({ config }) {
    this.config = config;
    this.browser = new BrowserManager({
      profileDir: config.bypass.profileDir,
      headless: config.bypass.browserMode !== 'headful',
      initialPageDelayMs: (config.bypass.initialPageDelaySeconds || 1.5) * 1000,
      config: config,
    });
    this.captcha = createCaptchaSolver(config, {
      headless: config.bypass.browserMode !== 'headful',
    });
  }

  async close() {
    await this.browser.close();
  }

  /**
   * Resolve a single download option.
   * @param {object} job  the queue job (has .url, .provider, .quality, .title)
   * @param {object} ctx  { log(msg), jobId }
   * @returns {Promise<{finalUrl, linkType, hops}>}
   */
  async resolve(job, ctx = {}) {
    const timeoutMs = this.config.bypass.timeoutSeconds * 1000;
    const page = await this.browser.newPage();
    const context = page.context();
    const hops = [];
    let settled = null;

    const activePages = new Set([page]);
    const navListeners = new Map();

    const trackPage = (p) => {
      const navListener = (frame) => {
        if (frame === p.mainFrame()) {
          const u = frame.url();
          if (u && u !== 'about:blank') {
            hops.push(u);
            ctx.log?.(`→ ${shorten(u)}`);
          }
        }
      };
      p.on('framenavigated', navListener);
      navListeners.set(p, navListener);
      
      p.once('close', () => {
        p.off('framenavigated', navListener);
        navListeners.delete(p);
        activePages.delete(p);
      });
    };

    // Track the initial page
    trackPage(page);

    // Track any new tabs or popups created in this context
    const onPage = (newPage) => {
      activePages.add(newPage);
      ctx.log?.(`[tab] New tab opened: ${shorten(newPage.url())}`);
      trackPage(newPage);
    };
    context.on('page', onPage);

    try {
      ctx.log?.(`Starting: ${job.provider} ${job.quality || ''} — ${shorten(job.url)}`);
      await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});

      settled = await this._driveToFinal(activePages, ctx, timeoutMs);
      if (!settled) throw new Error('Timed out before reaching a final link');

      ctx.log?.(`✔ Final link (${settled.linkType}): ${settled.finalUrl}`);
      return { ...settled, hops };
    } finally {
      // Clean up context listeners and close all pages
      context.off('page', onPage);
      for (const p of activePages) {
        const listener = navListeners.get(p);
        if (listener) p.off('framenavigated', listener);
      }
      await this.browser.close().catch(() => {});
    }
  }

  /**
   * Poll all active pages/tabs in the context until one reaches GDFlix or a final host directly.
   */
  async _driveToFinal(activePages, ctx, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let handledGdflix = false;

    const WHITELIST_DOMAINS = this.config?.bypass?.tabPruningWhitelist || [
      'pahe.plus', 'old.pahe.plus', 'ouo.io', 'ouo.press', 'gdflix', 'drive.google', 
      'pixeldrain', 'pixeldra.in', 'teknoasian.com', 'spacetica.com', 'oii.la', 'linegee.net', 
      'tpi.li', 'wordcounter.icu', 'about:blank'
    ];

    while (Date.now() < deadline) {
      const pages = Array.from(activePages).filter(p => !p.isClosed());
      if (pages.length === 0) {
        throw new Error('All browser pages/tabs were closed');
      }

      for (const p of pages) {
        const url = p.url();

        // 1. Close failed/error tabs immediately
        if (url.includes('chrome-error://') || url.includes('chromewebdata')) {
          ctx.log?.(`[tab] Closing failed/error tab`);
          await p.close().catch(() => {});
          continue;
        }

        // 2. Close unwanted ad popups (if it's not the initial tab and not whitelisted)
        const isInitialTab = (p === pages[0] && pages.length === 1);
        if (!isInitialTab && url && url !== 'about:blank') {
          const isWhitelisted = WHITELIST_DOMAINS.some(d => url.toLowerCase().includes(d));
          if (!isWhitelisted) {
            ctx.log?.(`[tab] Closing unwanted ad popup tab: ${shorten(url)}`);
            await p.close().catch(() => {});
            continue;
          }
        }

        // Reached a final host directly.
        if (FINAL_HOST_RE.test(url)) {
          return { finalUrl: url, linkType: classifyFinalLink(url) };
        }

        // Reached GDFlix — run the resolver once.
        if (isGdflixUrl(url) && !handledGdflix) {
          handledGdflix = true;
          const res = await resolveGdflix(
            p,
            { credentials: this.config.bypass.gdflix, captcha: this.captcha },
            ctx,
          ).catch((err) => {
            ctx.log?.(`GDFlix resolve error: ${err.message}`);
            return null;
          });
          if (res) return res;
          handledGdflix = false; // allow retry if page changed
        }

        // If a captcha is blocking this tab, try to solve it.
        const cap = await detectCaptcha(p);
        if (cap?.present) {
          ctx.log?.(`Captcha detected (${cap.kind}) at ${shorten(url)}`);
          await this.captcha.solve(p, ctx).catch(() => {});
        }
      }

      await pages[0].waitForTimeout(1000);
    }
    return null;
  }
}

function shorten(u) {
  if (!u) return '';
  return u.length > 70 ? `${u.slice(0, 67)}…` : u;
}

export default BypassEngine;
