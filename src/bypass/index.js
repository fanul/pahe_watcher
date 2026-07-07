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
    const hops = [];
    let settled = null;

    const onFrameNav = (frame) => {
      if (frame === page.mainFrame()) {
        const u = frame.url();
        if (u && u !== 'about:blank') {
          hops.push(u);
          ctx.log?.(`→ ${shorten(u)}`);
        }
      }
    };
    page.on('framenavigated', onFrameNav);

    try {
      ctx.log?.(`Starting: ${job.provider} ${job.quality || ''} — ${shorten(job.url)}`);
      await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});

      settled = await this._driveToFinal(page, ctx, timeoutMs);
      if (!settled) throw new Error('Timed out before reaching a final link');

      ctx.log?.(`✔ Final link (${settled.linkType}): ${settled.finalUrl}`);
      return { ...settled, hops };
    } finally {
      page.off('framenavigated', onFrameNav);
      await page.close().catch(() => {});
    }
  }

  /**
   * Poll the page until it reaches a GDFlix page (then resolve it) or a final
   * host directly. The injected userscript handles intermediate ad hops.
   */
  async _driveToFinal(page, ctx, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let handledGdflix = false;

    while (Date.now() < deadline) {
      const url = page.url();

      // Reached a final host directly.
      if (FINAL_HOST_RE.test(url)) {
        return { finalUrl: url, linkType: classifyFinalLink(url) };
      }

      // Reached GDFlix — run the resolver once.
      if (isGdflixUrl(url) && !handledGdflix) {
        handledGdflix = true;
        const res = await resolveGdflix(
          page,
          { credentials: this.config.bypass.gdflix, captcha: this.captcha },
          ctx,
        ).catch((err) => {
          ctx.log?.(`GDFlix resolve error: ${err.message}`);
          return null;
        });
        if (res) return res;
        handledGdflix = false; // allow retry if page changed
      }

      // If a captcha is blocking an intermediate hop, try to solve it.
      const cap = await detectCaptcha(page);
      if (cap?.present) {
        ctx.log?.(`Captcha detected (${cap.kind}) at ${shorten(url)}`);
        await this.captcha.solve(page, ctx).catch(() => {});
      }

      await page.waitForTimeout(1000);
    }
    return null;
  }
}

function shorten(u) {
  if (!u) return '';
  return u.length > 70 ? `${u.slice(0, 67)}…` : u;
}

export default BypassEngine;
