import { createLogger } from '../../core/logger.js';
import { extractCookieSourceDomains, parseCookieString } from '../cookieUtils.js';

const log = createLogger('resolver:gdflix');

/**
 * GDFlix resolver. Once the ad chain lands on a gdflix.* /file/ page, this
 * extracts the actual Google Drive (or pixeldrain / direct) link.
 *
 * GDFlix layouts change often; selectors are intentionally broad and ordered by
 * preference. Tune `LINK_BUTTON_SELECTORS` against the live page if it breaks.
 */

// Anchored to an actual domain label: "gdflix" must sit at the start of the
// hostname or right after a dot, and the TLD must run to the end of the
// string. An unanchored /gdflix\.[a-z]+/ would also match unrelated hosts
// that merely contain that substring, e.g. "not-gdflix.example.com" (matches
// "gdflix.example") — which would wrongly trigger cookie injection (with the
// user's real GDFlix session) against an untrusted page.
const GDFLIX_HOST_RE = /(^|\.)gdflix\.[a-z]{2,}$/i;

const PRIMARY_LINK_SELECTORS = [
  'a:has-text("G-Drive Link")',
  'button:has-text("G-Drive Link")',
  'a:has(b:has-text("G-Drive Link"))',
  'b:has-text("G-Drive Link")',
  'button#ddl',
  '#ddl',
];

const FALLBACK_LINK_SELECTORS = [
  'button#drc',
  '#drc',
  'button:has-text("Download File")',
  'button:has-text("Download")',
  'button:has-text("Direct Download")',
  'a:has-text("Download File")',
  'a:has-text("Direct Download")',
  'a:has-text("Cloud Download")',
  'a:has-text("Google Drive")',
  'a:has-text("GDToT")',
  'a:has-text("Direct DL")',
  'a:has-text("Instant DL")',
  'a:has-text("PixelDrain")',
  'a:has-text("Download")',
  'a:has-text("Fast Cloud")',
  'a:has-text("ZipDisk")',
];

// A resolved final link looks like one of these hosts.
const FINAL_HOST_RE = /(drive\.google\.com|googleusercontent\.com|usercontent\.google|pixeldrain\.|workers\.dev|\.r2\.|pixeldra\.in)/i;

// Google Drive specifically, excluding the other mirror/proxy hosts above
// (pixeldrain, workers.dev, .r2.dev). Used to keep the "G-Drive Link" button's
// wait strict to an actual Drive URL — see the PRIMARY_LINK_SELECTORS click
// in resolveGdflix for why: without this, if any other open tab (an ad
// popup, a different mirror link shown on the same page, etc.) happens to
// carry a workers.dev/.r2.dev URL while we're waiting for the real Drive
// link to render, the broad FINAL_HOST_RE would accept that instead.
const GOOGLE_DRIVE_HOST_RE_SOURCE = 'drive\\.google\\.com|googleusercontent\\.com|usercontent\\.google';

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
  // `workers.dev`/`.r2.` here is a catch-all for hosts we haven't taught
  // resolveGdflix to follow through yet (see MULTIUP_VALIDATE_HOST_RE below
  // for the one we do). Confirmed live: validate.multiup*.workers.dev is a
  // Cloudflare-Worker front for multiup.io — it redirects to a real
  // multi-mirror page (gofile.io/1fichier.com/megaup.net, no Google Drive
  // involved at all), not a Google Drive link as it might look at a glance.
  if (/workers\.dev|\.r2\./.test(url)) return 'worker-proxy';
  return 'direct';
}

// multiup.io's Cloudflare-Worker validator. It's an intermediate redirector,
// not a real final host: it 302s through to a multiup mirror-list page
// (e.g. goflix.sbs — a whitelabeled multiup.io instance) offering several
// third-party mirrors (gofile.io, 1fichier.com, megaup.net) plus multiup's
// own same-host "/download-fast/" link. The "/download-fast/" link is NOT
// clean either — it meta-refreshes into an unrelated ad-redirect domain
// before ever reaching a file — so resolveMultiupMirror deliberately skips
// it and prefers a known, stable third-party mirror host instead.
const MULTIUP_VALIDATE_HOST_RE = /^validate\.multiup\d*\.workers\.dev$/i;

// Preferred by observed reliability (least gated/ad-walled first), not by
// bandwidth — any of these is a genuine, separately-hostable mirror.
const MULTIUP_MIRROR_HOST_RE = /gofile\.io|megaup\.net|1fichier\.com|mega\.nz/i;
const MULTIUP_MIRROR_PREFERENCE = ['gofile.io', 'megaup.net', '1fichier.com', 'mega.nz'];

export function isMultiupValidateUrl(url) {
  try {
    return MULTIUP_VALIDATE_HOST_RE.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * Picks the best mirror link out of every href found on a resolved multiup
 * mirror-list page. Pure/testable — the browser-dependent part is just
 * collecting `hrefs` (see resolveMultiupMirror).
 */
export function pickMultiupMirrorLink(hrefs) {
  const candidates = (hrefs || []).filter((h) => MULTIUP_MIRROR_HOST_RE.test(h));
  for (const host of MULTIUP_MIRROR_PREFERENCE) {
    const match = candidates.find((h) => h.includes(host));
    if (match) return match;
  }
  return candidates[0] || null;
}

/**
 * Follows a multiup.io validator URL through to its real mirror-list page and
 * returns a concrete third-party mirror link, classified normally. Returns
 * null (never throws) if the page can't be loaded or has no recognizable
 * mirror — callers should fall back to the raw validator URL in that case.
 */
async function resolveMultiupMirror(page, validateUrl, ctx) {
  ctx.log?.(`[GDFlix] Following multiup validator through to its mirror list: ${validateUrl}`);
  const mirrorPage = await page.context().newPage();
  try {
    await mirrorPage.goto(validateUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    const hrefs = await mirrorPage
      .evaluate(() => [...document.querySelectorAll('a[href]')].map((a) => a.href))
      .catch(() => []);
    const chosen = pickMultiupMirrorLink(hrefs);
    if (chosen) {
      ctx.log?.(`[GDFlix] multiup mirror resolved: ${chosen}`);
      return { finalUrl: chosen, linkType: classifyFinalLink(chosen) };
    }
    ctx.log?.('[GDFlix] multiup mirror list page had no recognizable mirror link.');
    return null;
  } catch (err) {
    ctx.log?.(`[GDFlix] Failed to follow multiup validator: ${err.message}`);
    return null;
  } finally {
    await mirrorPage.close().catch(() => {});
  }
}

/** Classifies a found URL, following it through to a real mirror first if it's an intermediate multiup validator. */
async function finalizeLink(page, url, ctx) {
  if (isMultiupValidateUrl(url)) {
    const resolved = await resolveMultiupMirror(page, url, ctx);
    if (resolved) return resolved;
  }
  return { finalUrl: url, linkType: classifyFinalLink(url) };
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



  // 1) Look for an already-present Google Drive link in the DOM first.
  const googleDriveLink = await scanPageForFinalLink(page, GOOGLE_DRIVE_HOST_RE_SOURCE);
  if (googleDriveLink) {
    ctx.log?.(`[GDFlix] Found Google Drive link already in DOM: ${googleDriveLink}`);
    return { finalUrl: googleDriveLink, linkType: 'google-drive' };
  }

  // 2) The G-Drive Link button is the top preference. Try to click it if it exists
  // to generate the Google Drive link. The wait afterward is kept strict to an
  // actual Drive URL (not the broader FINAL_HOST_RE) — otherwise an unrelated
  // tab (ad popup, a different mirror link on the same page) carrying a
  // workers.dev/.r2.dev URL could get grabbed instead of the real Drive link
  // this specific button is supposed to produce.
  const primarySelector = PRIMARY_LINK_SELECTORS.join(', ');
  ctx.log?.('[GDFlix] Checking for G-Drive Link button...');
  const primaryBtn = await page.$(primarySelector).catch(() => null);

  if (primaryBtn) {
    const desc = await elementFingerprint(primaryBtn);
    ctx.log?.(`[GDFlix] Found G-Drive Link button: ${desc}. Clicking to generate Google Drive link...`);
    const found = await clickAndAwaitLink(page, primaryBtn, desc, ctx, GOOGLE_DRIVE_HOST_RE_SOURCE);
    if (found) return found;
  }

  // 3) If no Google Drive link was found or generated, look for any other fallback links (like R2, pixeldrain) in DOM
  const directFallback = await scanPageForFinalLink(page, FINAL_HOST_RE.source);
  if (directFallback) {
    ctx.log?.(`[GDFlix] Found fallback link in DOM: ${directFallback}`);
    return await finalizeLink(page, directFallback, ctx);
  }

  // 4) If still nothing, wait for any fallback/mirror button (e.g. Instant DL, Fast Cloud) to appear and click it
  ctx.log?.('[GDFlix] No G-Drive link/button or DOM fallback found. Waiting for fallback buttons...');
  const fallbackSelector = FALLBACK_LINK_SELECTORS.join(', ');
  const fallbackBtn = await page
    .waitForSelector(fallbackSelector, { timeout: 8000, state: 'visible' })
    .catch(() => null);

  let triedFingerprint = null;
  if (fallbackBtn) {
    const desc = await elementFingerprint(fallbackBtn);
    triedFingerprint = desc;
    ctx.log?.(`[GDFlix] Found fallback button: ${desc}. Clicking...`);
    const found = await clickAndAwaitLink(page, fallbackBtn, desc, ctx);
    if (found) return found;
  } else {
    ctx.log?.('[GDFlix] No download or mirror button appeared.');
  }

  // 5) Fallback sweep: try all selectors in order of preference if the initial steps failed
  const allSelectors = [...PRIMARY_LINK_SELECTORS, ...FALLBACK_LINK_SELECTORS];
  for (const sel of allSelectors) {
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

/**
 * Click a button/link, then poll every open tab for up to 15s for a resulting
 * final link. `hostReSource` restricts what counts as "found" — pass the
 * Google-Drive-only regex when the click was specifically the G-Drive Link
 * button, so an unrelated tab carrying some other final-host URL (ad popup,
 * a different mirror shown on the same page) can't get grabbed instead of
 * the actual Drive link this click is supposed to produce. Defaults to the
 * broad FINAL_HOST_RE for fallback-button clicks, where any mirror is fine.
 */
async function clickAndAwaitLink(page, btn, label, ctx, hostReSource = FINAL_HOST_RE.source) {
  await btn.click().catch(() => {});
  const hostRe = new RegExp(hostReSource, 'i');

  ctx.log?.(`[GDFlix] Clicked ${label} — waiting up to 15 seconds for Google Drive or final link to generate...`);
  const maxPollTimeMs = 15000;
  const pollIntervalMs = 500;
  const startTime = Date.now();

  while (Date.now() - startTime < maxPollTimeMs) {
    // Check all active pages/tabs in the context (some clicks open popups/new tabs)
    const pages = page.context().pages();
    for (const p of pages) {
      const u = p.url();
      if (hostRe.test(u)) {
        ctx.log?.(`[GDFlix] Found final URL in browser address bar: ${u}`);
        if (p !== page) await p.close().catch(() => {});
        return await finalizeLink(page, u, ctx);
      }

      const found = await scanPageForFinalLink(p, hostReSource);
      if (found) {
        ctx.log?.(`[GDFlix] Successfully captured generated link: ${found}`);
        if (p !== page) await p.close().catch(() => {});
        return await finalizeLink(page, found, ctx);
      }
    }

    await page.waitForTimeout(pollIntervalMs).catch(() => {});
  }

  return null;
}

export default resolveGdflix;
