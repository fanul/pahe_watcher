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

const LINK_BUTTON_SELECTORS = [
  'a:has-text("G-Drive Link")',
  'button:has-text("G-Drive Link")',
  'a:has(b:has-text("G-Drive Link"))',
  'b:has-text("G-Drive Link")',
  'button#ddl',
  '#ddl',
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

  const hostname = new URL(page.url()).hostname.toLowerCase();
  let initialStatus = await getLoginStatus();
  ctx.log?.(`[GDFlix] Current domain: ${hostname} | Initial login check: "${initialStatus}"`);

  if (cookies) {
    try {
      const baseDomain = hostname.split('.').slice(-2).join('.'); // e.g. gdflix.io
      const mirrorDomain = `.${baseDomain}`;

      let activeCookies = null;
      let cookieDomainInfo = '';

      let cookieMap = null;
      if (cookies.trim().startsWith('{')) {
        try {
          cookieMap = JSON.parse(cookies);
        } catch {}
      }

      if (cookieMap && typeof cookieMap === 'object' && !Array.isArray(cookieMap)) {
        ctx.log?.(`[GDFlix] Found domain-mapped cookies configuration in settings (Total domains: ${Object.keys(cookieMap).length})`);
        // Find best match in keys
        let matchKey = Object.keys(cookieMap).find(k => {
          const cleanK = k.replace(/^\./, '').toLowerCase();
          return hostname.endsWith(cleanK) || baseDomain === cleanK;
        });

        if (matchKey) {
          activeCookies = cookieMap[matchKey];
          cookieDomainInfo = `specifically configured for "${matchKey}"`;
          ctx.log?.(`[GDFlix] Domain match found! Using cookies specifically configured for "${matchKey}"`);
        } else {
          // Fallback to default or wildcard keys
          const fallbackKey = Object.keys(cookieMap).find(k => k === 'default' || k === '*');
          if (fallbackKey) {
            activeCookies = cookieMap[fallbackKey];
            cookieDomainInfo = `using fallback "${fallbackKey}"`;
            ctx.log?.(`[GDFlix] No exact domain match for ${hostname}. Using fallback "${fallbackKey}" cookies.`);
          } else {
            ctx.log?.(
              `[GDFlix] ⚠ No matching cookies found for ${hostname} (available domains: ${Object.keys(cookieMap).join(', ') || 'none'}). ` +
              `You can configure cookies for this mirror domain in Settings.`
            );
          }
        }
      } else {
        activeCookies = cookies;
        cookieDomainInfo = 'legacy fallback (all domains)';
        ctx.log?.(`[GDFlix] Using legacy cookie string (no domain mapping detected).`);
      }

      if (activeCookies) {
        const sourceDomains = extractCookieSourceDomains(activeCookies);
        if (sourceDomains.length > 0) {
          ctx.log?.(`[GDFlix] Extracted source domain(s) from cookie: ${sourceDomains.join(', ')}`);
        }
        
        const mismatched = sourceDomains.filter((d) => !d.replace(/^\./, '').endsWith(baseDomain));
        if (mismatched.length > 0) {
          ctx.log?.(
            `[GDFlix] ⚠ Cookies (${cookieDomainInfo}) were exported from ${mismatched.join(', ')}, but browser is on ` +
            `${hostname}. Remapping them to ${mirrorDomain} to force injection.`,
          );
        }

        const parsed = parseCookieString(activeCookies, mirrorDomain);

        if (parsed.length > 0) {
          const cookieNames = parsed.map(c => c.name);
          ctx.log?.(`[GDFlix] Injecting ${parsed.length} cookie(s) scoped to ${mirrorDomain}: [${cookieNames.join(', ')}]`);
          await page.context().addCookies(parsed);

          // Reload if not already logged in to apply session cookies
          if (initialStatus !== 'logged-in') {
            ctx.log?.('[GDFlix] Reloading page to apply cookies...');
            await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
          }

          const postCookieStatus = await getLoginStatus();
          ctx.log?.(`[GDFlix] Post-cookie check: status is "${postCookieStatus}"`);

          if (postCookieStatus === 'logged-in') {
            ctx.log?.(`[GDFlix] Authenticated successfully using cookies (${cookieDomainInfo}).`);
            return { loggedIn: true, method: 'cookies' };
          } else {
            ctx.log?.(
              `[GDFlix] ❌ Cookie login did not authenticate on ${hostname} (${cookieDomainInfo}). ` +
              `This means the session is invalid or expired for this mirror. ` +
              `Try logging in on ${hostname} and updating settings.`,
            );
          }
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
  const direct = await scanPageForFinalLink(page, FINAL_HOST_RE.source);
  if (direct) {
    return { finalUrl: direct, linkType: classifyFinalLink(direct) };
  }

  // 2) The download button often only renders a short moment after login
  // completes (e.g. once an AJAX call resolves). A single instant page.$()
  // check misses that — wait for any known control to actually appear first.
  const combinedSelector = LINK_BUTTON_SELECTORS.join(', ');
  ctx.log?.('[GDFlix] Waiting for a download-link button to appear...');
  const firstBtn = await page
    .waitForSelector(combinedSelector, { timeout: 10000, state: 'visible' })
    .catch(() => null);

  let triedFingerprint = null;
  if (firstBtn) {
    const desc = await elementFingerprint(firstBtn);
    triedFingerprint = desc;
    ctx.log?.(`[GDFlix] Found button: ${desc}`);
    const found = await clickAndAwaitLink(page, firstBtn, desc, ctx);
    if (found) return found;
  } else {
    ctx.log?.('[GDFlix] No known download-link button appeared within 10s.');
  }

  // 3) Fallback sweep: some pages expose more than one matching control
  // (e.g. distinct quality/host buttons) — try the rest by preference order,
  // skipping whichever element firstBtn already was (avoid a wasted re-click).
  for (const sel of LINK_BUTTON_SELECTORS) {
    const btn = await page.$(sel).catch(() => null);
    if (!btn) continue;
    const fingerprint = await elementFingerprint(btn);
    if (fingerprint === triedFingerprint) continue;

    ctx.log?.(`[GDFlix] Clicking button "${sel}" to generate download link...`);
    const found = await clickAndAwaitLink(page, btn, sel, ctx);
    if (found) return found;
    ctx.log?.(`[GDFlix] Timeout waiting for link after clicking "${sel}". Trying next selector if available...`);
  }

  // 4) Nothing found. If this is specifically because the file is gated behind
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

/** A cheap, stable-enough identity string for an element, used to dedupe clicks across selectors. */
async function elementFingerprint(handle) {
  return handle
    .evaluate((el) => `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''} "${(el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 50)}"`)
    .catch(() => null);
}

/**
 * Scan a page for a final link. GDFlix "reveal link" panels don't always
 * expose the result as a plain `<a href>` — some populate a readonly
 * input/textarea (for copy-to-clipboard), a data-* attribute, or just render
 * the URL as visible text. Check all of those, in that order of confidence.
 */
async function scanPageForFinalLink(target, reSource) {
  return target
    .evaluate((re) => {
      const rx = new RegExp(re, 'i');

      const a = [...document.querySelectorAll('a[href]')].find((x) => rx.test(x.href));
      if (a) return a.href;

      const fields = [...document.querySelectorAll('input, textarea')];
      for (const f of fields) {
        if (f.value && rx.test(f.value)) return f.value;
      }

      const attrNames = ['data-href', 'data-url', 'data-clipboard-text', 'data-link'];
      const attrEls = document.querySelectorAll(attrNames.map((a) => `[${a}]`).join(','));
      for (const el of attrEls) {
        for (const attr of attrNames) {
          const v = el.getAttribute(attr);
          if (v && rx.test(v)) return v;
        }
      }

      const textMatch = document.body.innerText.match(new RegExp(`https?:\\/\\/[^\\s"'<>]{0,300}(?:${re})[^\\s"'<>]{0,150}`, 'i'));
      return textMatch ? textMatch[0] : null;
    }, reSource)
    .catch(() => null);
}

/** Click a button/link, then poll every open tab for up to 15s for a resulting final link. */
async function clickAndAwaitLink(page, btn, label, ctx) {
  await btn.click().catch(() => {});

  ctx.log?.(`[GDFlix] Clicked ${label} — waiting up to 15 seconds for Google Drive or final link to generate...`);
  const maxPollTimeMs = 15000;
  const pollIntervalMs = 500;
  const startTime = Date.now();

  while (Date.now() - startTime < maxPollTimeMs) {
    // Check all active pages/tabs in the context (some clicks open popups/new tabs)
    const pages = page.context().pages();
    for (const p of pages) {
      const u = p.url();
      if (FINAL_HOST_RE.test(u)) {
        ctx.log?.(`[GDFlix] Found final URL in browser address bar: ${u}`);
        const linkType = classifyFinalLink(u);
        if (p !== page) await p.close().catch(() => {});
        return { finalUrl: u, linkType };
      }

      const found = await scanPageForFinalLink(p, FINAL_HOST_RE.source);
      if (found) {
        ctx.log?.(`[GDFlix] Successfully captured generated link: ${found}`);
        if (p !== page) await p.close().catch(() => {});
        return { finalUrl: found, linkType: classifyFinalLink(found) };
      }
    }

    await page.waitForTimeout(pollIntervalMs).catch(() => {});
  }

  return null;
}

export default resolveGdflix;
