import fs from 'node:fs';
import { createLogger } from '../core/logger.js';
import { getInjectedAutomationScript } from './userscript.js';

const log = createLogger('browser');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36';

/**
 * Manages a single persistent Chromium context.
 *
 * Engine:
 *   - "playwright" (default): stock Playwright + manual stealth init scripts.
 *   - "patchright": an undetected Playwright fork that closes the
 *     `Runtime.enable` CDP leak Cloudflare uses to fingerprint Playwright —
 *     this is what lets ouo.io's Turnstile auto-issue a token (or stay
 *     solvable). Pairs with a real Chrome install via `channel: "chrome"`.
 *     NOT the default despite that: as of patchright 1.57.0–1.61.1, its
 *     `addInitScript` silently no-ops (confirmed live — a variable set from
 *     it is never visible to page.evaluate; upstream tracked as
 *     patchright-nodejs#55), which means the ENTIRE userscript.js automation
 *     layer (every DOMAIN_RULES click-through rule, not just one site) never
 *     actually runs under it. Stock Playwright doesn't have this bug. Set
 *     BYPASS_STEALTH_ENGINE=patchright to opt back in for Turnstile-heavy
 *     use, at the cost of every other site's automation being silently dead.
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
    const want = this.config?.bypass?.stealth?.engine || 'playwright';
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

    const stealth = this.config?.bypass?.stealth || {};
    const cdpUrl = this.config?.bypass?.cdpUrl;
    const cdpEnabled = this.config?.bypass?.cdpEnabled;

    if (cdpEnabled && cdpUrl) {
      log.info(`Connecting to remote browser via CDP: ${cdpUrl}`);
      try {
        this._remoteBrowser = await chromium.connectOverCDP(cdpUrl);
        this.context = this._remoteBrowser.contexts()[0] || await this._remoteBrowser.newContext();
      } catch (err) {
        log.error(`Failed to connect to remote browser via CDP at ${cdpUrl}: ${err.message}`);
        throw err;
      }
    } else {
      fs.mkdirSync(this.profileDir, { recursive: true });

      // Which browser binary: real Chrome ("chrome") is best for Turnstile; empty
      // string or "chromium" uses the bundled build.
      const channelCfg = stealth.chromeChannel ?? 'chrome';
      const channel = channelCfg && channelCfg !== 'chromium' ? channelCfg : null;

      const launchOptions = {
        headless: this.headless,
        viewport: { width: 1366, height: 768 },
        // Confirmed live: launchPersistentContext without an explicit
        // locale sends NO Accept-Language header at all (verified against
        // multiple domains) — every real browser always sends one. A
        // totally absent Accept-Language is a concrete, checkable
        // automation tell that has nothing to do with click behavior or
        // TLS; this is the fix for it, not a stealth flag.
        locale: 'en-US',
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
        // Headful automation otherwise pops a visible Chrome window and
        // steals focus for every fully-automated stretch (GDFlix resolving,
        // clicking through ad chains, etc.) where nobody needs to look at
        // it. Starts minimized instead; the one place a human actually
        // needs it — manual captcha solving — calls page.bringToFront()
        // (see captcha/manual.js) to bring it back up at exactly that
        // moment.
        if (!this.headless && stealth.startMinimized !== false) args.push('--start-minimized');
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
    }

    this.context.on('close', () => {
      this.context = null;
      this._remoteBrowser = null;
      log.info('Browser context closed (process exited or disconnected)');
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
      ['linegee.net', 'pahe.plus', 'ouo.io', 'ouo.press'];
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

    // Some ad-gate sites (confirmed live: clksz.com) "detect adblock" by
    // fetch()-ing Google AdSense's real adsbygoogle.js and checking whether
    // it resolves — if it rejects, they show a "please disable Adblock"
    // wall with no real button to click through. Confirmed live this fetch
    // fails even in a completely separate, non-automated browser on this
    // network — googlesyndication.com is blocked at the network/firewall
    // level here (common on corporate/government networks), which has
    // nothing to do with whether THIS browser has an adblocker. Faking a
    // successful empty response for just this one URL lets that specific
    // check pass honestly on its own terms, without a general-purpose
    // ad-fetch-faking mechanism.
    await page.route('**://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js*', (route) =>
      route.fulfill({ status: 200, contentType: 'application/javascript', body: '' }),
    );

    return page;
  }

  async close() {
    if (this.context) {
      await this.context.close().catch(() => {});
      this.context = null;
      log.info('Browser context closed');
    }
    if (this._remoteBrowser) {
      await this._remoteBrowser.disconnect().catch(() => {});
      this._remoteBrowser = null;
      log.info('Disconnected from remote CDP browser');
    }
  }
}

export default BrowserManager;
