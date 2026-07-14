import { createLogger } from '../../core/logger.js';
import { extractCookieSourceDomains, parseCookieString, baseDomainOf } from '../cookieUtils.js';

const log = createLogger('resolver:google');

/**
 * Google Drive cookie-based auth. Many "anyone with the link" Drive files need
 * no sign-in at all — this only intervenes when a sign-in wall is actually
 * detected, so it costs nothing on the common public-file path.
 *
 * Unlike GDFlix, Google doesn't operate interchangeable mirror domains, so
 * cookies always remap to the single ".google.com" base domain (covering
 * accounts./drive./docs. subdomains), regardless of which of those the
 * export happened to record.
 */

export function isGoogleAuthHost(url) {
  try {
    return /(^|\.)accounts\.google\.com$/i.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * Normalize a resolved Drive URL into its direct-download form. Google serves
 * the same file through several URL shapes:
 *   - drive.usercontent.google.com/open?id=X          -> "open in browser" page
 *   - drive.usercontent.google.com/download?id=X&export=download  -> direct download
 *   - drive.google.com/file/d/X/view                  -> classic "share" page
 *   - drive.google.com/uc?id=X                        -> legacy direct-download form
 * Whichever shape got captured (depends on which link/button happened to be on
 * the GDFlix page), rewrite it to the one that actually triggers a download
 * instead of showing a viewer/confirmation page first.
 */
export function normalizeGoogleDriveLink(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();

    if (host === 'drive.usercontent.google.com' && u.pathname === '/open') {
      u.pathname = '/download';
      if (!u.searchParams.has('export')) u.searchParams.set('export', 'download');
      return u.toString();
    }

    if (host === 'drive.usercontent.google.com' && u.pathname === '/download' && !u.searchParams.has('export')) {
      u.searchParams.set('export', 'download');
      return u.toString();
    }

    const shareMatch = u.pathname.match(/^\/file\/d\/([^/]+)/);
    if (host === 'drive.google.com' && shareMatch) {
      const out = new URL('https://drive.usercontent.google.com/download');
      out.searchParams.set('id', shareMatch[1]);
      out.searchParams.set('export', 'download');
      const authuser = u.searchParams.get('authuser');
      if (authuser) out.searchParams.set('authuser', authuser);
      return out.toString();
    }

    if (host === 'drive.google.com' && u.pathname === '/uc' && !u.searchParams.has('export')) {
      u.searchParams.set('export', 'download');
      return u.toString();
    }

    return url;
  } catch {
    return url;
  }
}

export function isGoogleDriveHost(url) {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return /(^|\.)(drive|docs)\.google\.com$/i.test(h) || /(^|\.)drive\.usercontent\.google\.com$/i.test(h);
  } catch {
    return false;
  }
}

async function getGoogleLoginStatus(page) {
  return page
    .evaluate(() => {
      if (/accounts\.google\.com$/i.test(location.hostname)) return 'signin-page';
      const hasSignInLink = Array.from(document.querySelectorAll('a, button')).some((el) => {
        const text = (el.textContent || '').trim().toLowerCase();
        return text === 'sign in' || text === 'login' || text === 'log in';
      });
      return hasSignInLink ? 'signed-out' : 'ok';
    })
    .catch(() => 'ok');
}

/**
 * Ensure the browser has a signed-in Google session (if cookies are configured
 * and a sign-in wall is actually present). No-ops quickly for public files.
 * @returns {Promise<{loggedIn: boolean, method?: string, skipped?: boolean}>}
 */
export async function ensureGoogleLogin(page, credentials, ctx = {}) {
  const { cookies } = credentials || {};

  const initialStatus = await getGoogleLoginStatus(page);
  if (initialStatus === 'ok') {
    return { loggedIn: true, method: 'public-or-session' };
  }

  ctx.log?.(`[Google] Sign-in wall detected ("${initialStatus}").`);

  if (!cookies) {
    ctx.log?.('[Google] No Google account cookies configured — leaving as-is (set them in Settings → Google Drive if this file needs an account).');
    return { loggedIn: false, skipped: true };
  }

  try {
    const { mirrorDomain } = baseDomainOf(page.url());
    const sourceDomains = extractCookieSourceDomains(cookies);
    if (sourceDomains.length > 0) {
      const mismatched = sourceDomains.filter((d) => !d.replace(/^\./, '').endsWith('google.com'));
      if (mismatched.length > 0) {
        ctx.log?.(`[Google] ⚠ Configured cookies were exported from ${mismatched.join(', ')} — remapping to ${mirrorDomain}.`);
      }
    }

    const parsed = parseCookieString(cookies, mirrorDomain);
    if (parsed.length === 0) {
      ctx.log?.('[Google] Configured cookies did not parse into any usable entries.');
      return { loggedIn: false };
    }

    ctx.log?.(`[Google] Injecting ${parsed.length} cookie(s) scoped to ${mirrorDomain}...`);
    await page.context().addCookies(parsed);
    await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});

    const postStatus = await getGoogleLoginStatus(page);
    ctx.log?.(`[Google] Post-cookie check: "${postStatus}"`);

    if (postStatus === 'ok') {
      ctx.log?.('[Google] Authenticated successfully using cookies.');
      return { loggedIn: true, method: 'cookies' };
    }

    ctx.log?.(
      '[Google] ❌ Cookie login did not authenticate. The cookies may be expired, or for a different Google ' +
      'account than this file requires. The link will still be recorded — you may need to sign in manually.',
    );
    return { loggedIn: false };
  } catch (err) {
    log.warn('Google cookie injection failed', { error: String(err) });
    ctx.log?.(`[Google] Cookie injection error: ${err.message}`);
    return { loggedIn: false, error: String(err) };
  }
}

export default ensureGoogleLogin;
