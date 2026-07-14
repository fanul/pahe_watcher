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

/** Best-effort peek at which domain(s) a JSON cookie export was recorded for, for logging only. */
function extractCookieSourceDomains(cookieStr) {
  if (!cookieStr || !cookieStr.trim().startsWith('[')) return [];
  try {
    const parsed = JSON.parse(cookieStr);
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.map((c) => c.domain).filter(Boolean))];
  } catch {
    return [];
  }
}

/**
 * GDFlix operates many interchangeable mirror domains (gdflix.app, gdflix.io,
 * gdflix.co, gdflix.dad, new2.gdflix.app, ...). Cookies exported from one
 * mirror carry that mirror's own `domain` field, but the browser may resolve
 * to a *different* mirror by the time it reaches the file page. A cookie's
 * domain is enforced by the browser itself — a cookie scoped to `gdflix.app`
 * is never sent on a request to `gdflix.io`, silently, with no error.
 *
 * So we always remap to whatever mirror is actually active (dot-prefixed base
 * domain, so it also covers subdomains like new2./www.), ignoring the
 * cookie's own recorded domain. This is a deliberate override, not a bug.
 */
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
            domain, // always remap — see comment above; never trust c.domain
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

  const getLoginStatus = async () => {
    return await page.evaluate(() => {
      const hasLoginLink = Array.from(document.querySelectorAll('a')).some(a => {
        const text = (a.textContent || '').trim().toLowerCase();
        const href = a.getAttribute('href') || '';
        return (text === 'log in' || text === 'login') && (href.endsWith('/login') || href.includes('/login?'));
      });
      const hasLogoutLink = Array.from(document.querySelectorAll('a')).some(a => {
        const text = (a.textContent || '').trim().toLowerCase();
        const href = a.getAttribute('href') || '';
        return (text === 'log out' || text === 'logout') || href.includes('logout');
      });
      if (hasLogoutLink) return 'logged-in';
      if (hasLoginLink) return 'logged-out';
      return 'unknown';
    });
  };

  let initialStatus = await getLoginStatus();
  ctx.log?.(`[GDFlix] Initial page check: status is "${initialStatus}"`);

  if (cookies) {
    try {
      const hostname = new URL(page.url()).hostname;
      const baseDomain = hostname.split('.').slice(-2).join('.'); // e.g. gdflix.io
      const mirrorDomain = `.${baseDomain}`;

      const sourceDomains = extractCookieSourceDomains(cookies);
      const mismatched = sourceDomains.filter((d) => !d.replace(/^\./, '').endsWith(baseDomain));
      if (mismatched.length > 0) {
        ctx.log?.(
          `[GDFlix] ⚠ Configured cookies were exported from ${mismatched.join(', ')}, but the browser is on ` +
          `${hostname}. GDFlix cookies are domain-scoped and never sent cross-domain, so they would silently ` +
          `do nothing on this mirror — remapping them to ${mirrorDomain} instead.`,
        );
      }

      const parsed = parseCookieString(cookies, mirrorDomain);

      if (parsed.length > 0) {
        ctx.log?.(`[GDFlix] Injecting ${parsed.length} session cookie(s) scoped to ${mirrorDomain}...`);
        await page.context().addCookies(parsed);

        // Reload if not already logged in to apply session cookies
        if (initialStatus !== 'logged-in') {
          ctx.log?.('[GDFlix] Reloading page to apply cookies...');
          await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
        }

        const postCookieStatus = await getLoginStatus();
        ctx.log?.(`[GDFlix] Post-cookie check: status is "${postCookieStatus}"`);

        if (postCookieStatus === 'logged-in') {
          ctx.log?.('[GDFlix] Authenticated successfully using cookies.');
          return { loggedIn: true, method: 'cookies' };
        } else {
          ctx.log?.(
            `[GDFlix] ❌ Cookie login did not authenticate on ${hostname}. This means the session ` +
            `(PHPSESSID/token) itself isn't valid here — either it belongs to a different GDFlix account/mirror ` +
            `backend than the one now active, or it expired. Re-export cookies while logged in on ${hostname} ` +
            `specifically, or configure email/password login instead.`,
          );
        }
      }
    } catch (err) {
      log.warn('GDFlix cookie injection failed', { error: String(err) });
      ctx.log?.(`[GDFlix] Cookie injection error: ${err.message}`);
    }
  }

  // Check if we are already logged in before trying credentials
  const currentStatus = await getLoginStatus();
  if (currentStatus === 'logged-in') {
    ctx.log?.('[GDFlix] Already logged in (using existing browser session).');
    return { loggedIn: true, method: 'session' };
  }

  if (!email || !password) {
    ctx.log?.('[GDFlix] No credentials configured. Skipping login form fallback.');
    return { loggedIn: false, skipped: true };
  }

  try {
    ctx.log?.('[GDFlix] Attempting credentials login (email/password)...');
    const loginLink = await page.$('a[href*="login"]');
    if (loginLink) await loginLink.click().catch(() => {});
    await page.fill('input[type="email"], input[name="email"]', email).catch(() => {});
    await page.fill('input[type="password"], input[name="password"]', password).catch(() => {});
    await page.click('button[type="submit"], input[type="submit"]').catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

    const finalStatus = await getLoginStatus();
    ctx.log?.(`[GDFlix] Post-credentials check: status is "${finalStatus}"`);
    if (finalStatus === 'logged-in') {
      ctx.log?.('[GDFlix] Authenticated successfully using credentials.');
      return { loggedIn: true, method: 'credentials' };
    } else {
      ctx.log?.('[GDFlix] Credentials login failed.');
      return { loggedIn: false };
    }
  } catch (err) {
    log.warn('GDFlix credentials login attempt failed', { error: String(err) });
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

  let loginResult = { loggedIn: false, skipped: true };
  if (credentials) loginResult = await ensureGdflixLogin(page, credentials, ctx);

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

  // 3) Nothing found. If this is specifically because the file is gated behind
  // a GDFlix account login and we couldn't establish one, say so clearly and
  // stop — retrying won't help until the credentials/cookies are fixed.
  const loginGateText = await page
    .evaluate(() => {
      const a = Array.from(document.querySelectorAll('a[href]')).find((x) =>
        /\/login(\?|$)/.test(x.getAttribute('href') || ''),
      );
      return a ? (a.textContent || '').trim().replace(/\s+/g, ' ') : null;
    })
    .catch(() => null);

  if (loginGateText && !loginResult.loggedIn) {
    const hostname = new URL(page.url()).hostname;
    const reason = credentials?.cookies
      ? `the configured cookies did not authenticate on ${hostname} (see the cookie log lines above — likely a different mirror/account or an expired session)`
      : credentials?.email
        ? `credential (email/password) login failed on ${hostname}`
        : `no GDFlix login is configured (set cookies or email/password in Settings → GDFlix)`;
    ctx.log?.(`[GDFlix] ❌ Blocked by login gate: "${loginGateText}" — ${reason}.`);
    throw terminalError(
      `GDFlix login required ("${loginGateText}") on ${hostname} — ${reason}.`,
    );
  }

  log.warn('Could not extract a final link from GDFlix page', { url: page.url() });
  return null;
}

/** Marks an error as unrecoverable-by-retry so callers stop looping and fail the job immediately. */
function terminalError(message) {
  const err = new Error(message);
  err.terminal = true;
  return err;
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
