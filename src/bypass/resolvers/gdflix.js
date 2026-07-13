import { createLogger } from '../../core/logger.js';

const log = createLogger('resolver:gdflix');

/**
 * GDFlix resolver. Once the ad chain lands on a gdflix.* /file/ page, this
 * extracts the actual Google Drive (or pixeldrain / direct) link.
 *
 * GDFlix layouts change often; selectors are intentionally broad and ordered by
 * preference. Tune `LINK_BUTTON_SELECTORS` against the live page if it breaks.
 */

const GDFLIX_HOST_RE = /gdflix\.[a-z]+/i;

// Buttons on a gdflix file page, most-preferred first.
const LINK_BUTTON_SELECTORS = [
  'button#ddl',
  '#ddl',
  'button:has-text("G-Drive Link")',
  'a:has-text("Cloud Download")',
  'a:has-text("Google Drive")',
  'a:has-text("GDToT")',
  'a:has-text("Direct DL")',
  'a:has-text("Instant DL")',
  'a:has-text("PixelDrain")',
  'a:has-text("Download")',
];

// A resolved final link looks like one of these hosts.
const FINAL_HOST_RE = /(drive\.google\.com|googleusercontent\.com|usercontent\.google|pixeldrain\.|workers\.dev|\.r2\.|pixeldra\.in)/i;

export function isGdflixUrl(url) {
  try {
    return GDFLIX_HOST_RE.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

export function classifyFinalLink(url) {
  if (/drive\.google\.com|googleusercontent|usercontent\.google/.test(url)) return 'google-drive';
  if (/pixeldrain|pixeldra\.in/.test(url)) return 'pixeldrain';
  if (/workers\.dev|\.r2\./.test(url)) return 'worker-proxy';
  return 'direct';
}

function parseCookieString(cookieStr, domain) {
  if (!cookieStr) return [];
  // If it's JSON array, parse directly
  if (cookieStr.trim().startsWith('[')) {
    try {
      const parsed = JSON.parse(cookieStr);
      if (Array.isArray(parsed)) {
        return parsed.map((c) => {
          let sameSite = c.sameSite;
          if (!sameSite || sameSite.toLowerCase() === 'unspecified') {
            sameSite = 'Lax';
          } else {
            sameSite = sameSite.charAt(0).toUpperCase() + sameSite.slice(1).toLowerCase();
            if (!['Lax', 'Strict', 'None'].includes(sameSite)) {
              sameSite = 'Lax';
            }
          }
          return {
            name: c.name,
            value: c.value,
            domain: c.domain || domain,
            path: c.path || '/',
            secure: c.secure ?? true,
            httpOnly: c.httpOnly ?? false,
            sameSite: sameSite,
          };
        });
      }
    } catch {}
  }

  // Semicolon separated string
  return cookieStr
    .split(';')
    .map((pair) => {
      const parts = pair.split('=');
      const name = parts[0]?.trim();
      const value = parts.slice(1).join('=')?.trim();
      if (!name || !value) return null;
      return {
        name,
        value,
        domain: domain.startsWith('.') ? domain : `.${domain}`,
        path: '/',
        secure: true,
        httpOnly: false,
        sameSite: 'Lax',
      };
    })
    .filter(Boolean);
}

/**
 * Ensure the GDFlix session is logged in (if credentials/cookies are configured).
 * Many GDFlix mirrors work without login; this is best-effort.
 */
export async function ensureGdflixLogin(page, credentials, ctx = {}) {
  const { email, password, cookies } = credentials || {};

  if (cookies) {
    try {
      const hostname = new URL(page.url()).hostname;
      const parts = hostname.split('.');
      const domain = parts.slice(-2).join('.'); // e.g. gdflix.co or gdflix.to
      const parsed = parseCookieString(cookies, domain);
      
      if (parsed.length > 0) {
        ctx.log?.(`Injecting ${parsed.length} GDFlix session cookies...`);
        await page.context().addCookies(parsed);
        
        // Check if we need to reload to apply injected cookies
        const needsReload = await page.evaluate(() => {
          return !!(document.querySelector('input[type="password"]') || document.querySelector('a[href*="login"]'));
        });
        if (needsReload) {
          ctx.log?.('Reloading GDFlix page to apply session cookies...');
          await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
        }

        const needsLoginAfter = await page.evaluate(() => {
          return !!(document.querySelector('input[type="password"]') || document.querySelector('a[href*="login"]'));
        });
        if (!needsLoginAfter) {
          ctx.log?.('GDFlix authenticated successfully via cookies.');
          return { loggedIn: true };
        } else {
          ctx.log?.('GDFlix cookie login failed or session expired. Falling back to credentials...');
        }
      }
    } catch (err) {
      log.warn('GDFlix cookie injection failed', { error: String(err) });
    }
  }

  if (!email || !password) return { loggedIn: false, skipped: true };
  try {
    const needsLogin = await page.$('input[type="password"], a[href*="login"]');
    if (!needsLogin) return { loggedIn: true };
    ctx.log?.('Attempting GDFlix login…');
    const loginLink = await page.$('a[href*="login"]');
    if (loginLink) await loginLink.click().catch(() => {});
    await page.fill('input[type="email"], input[name="email"]', email).catch(() => {});
    await page.fill('input[type="password"], input[name="password"]', password).catch(() => {});
    await page.click('button[type="submit"], input[type="submit"]').catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    return { loggedIn: true };
  } catch (err) {
    log.warn('GDFlix login attempt failed', { error: String(err) });
    return { loggedIn: false, error: String(err) };
  }
}

/**
 * From a gdflix file page, click through to the final host and return the URL.
 * @returns {Promise<{finalUrl, linkType} | null>}
 */
export async function resolveGdflix(page, { credentials, captcha } = {}, ctx = {}) {
  ctx.log?.('On GDFlix file page — extracting final link…');
  await page.waitForLoadState('domcontentloaded').catch(() => {});

  if (credentials) await ensureGdflixLogin(page, credentials, ctx);

  // Solve any captcha guarding the file page.
  if (captcha) {
    const res = await captcha.solve(page, ctx).catch(() => ({ solved: true }));
    if (res && res.solved === false) {
      throw new Error(`Captcha not solved on GDFlix (${res.reason || 'unknown'})`);
    }
  }

  // 1) Look for an already-present final link in the DOM.
  const direct = await page.evaluate((re) => {
    const rx = new RegExp(re, 'i');
    const a = [...document.querySelectorAll('a[href]')].find((x) => rx.test(x.href));
    return a ? a.href : null;
  }, FINAL_HOST_RE.source);
  if (direct) {
    return { finalUrl: direct, linkType: classifyFinalLink(direct) };
  }

  // 2) Otherwise click the best download button and capture navigation / new tab.
  for (const sel of LINK_BUTTON_SELECTORS) {
    const btn = await page.$(sel).catch(() => null);
    if (!btn) continue;
    ctx.log?.(`Clicking "${sel}"…`);

    const context = page.context();
    const popupP = context.waitForEvent('page', { timeout: 8000 }).catch(() => null);
    const navP = page.waitForNavigation({ timeout: 8000 }).catch(() => null);
    await btn.click().catch(() => {});
    const popup = await popupP;

    // check popup first
    if (popup) {
      await popup.waitForLoadState('domcontentloaded').catch(() => {});
      const u = popup.url();
      const found = await findFinalIn(popup, u);
      if (found) { await popup.close().catch(() => {}); return found; }
      await popup.close().catch(() => {});
    }
    await navP;
    const found = await findFinalIn(page, page.url());
    if (found) return found;
  }

  log.warn('Could not extract a final link from GDFlix page', { url: page.url() });
  return null;
}

async function findFinalIn(page, currentUrl) {
  if (FINAL_HOST_RE.test(currentUrl)) {
    return { finalUrl: currentUrl, linkType: classifyFinalLink(currentUrl) };
  }
  const href = await page
    .evaluate((re) => {
      const rx = new RegExp(re, 'i');
      const a = [...document.querySelectorAll('a[href]')].find((x) => rx.test(x.href));
      return a ? a.href : null;
    }, FINAL_HOST_RE.source)
    .catch(() => null);
  if (href) return { finalUrl: href, linkType: classifyFinalLink(href) };
  return null;
}

export default resolveGdflix;
