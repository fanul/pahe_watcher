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
