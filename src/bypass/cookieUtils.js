/**
 * Shared cookie-string handling for resolvers that authenticate via a
 * user-exported session (GDFlix, Google Drive, ...). Accepts either a JSON
 * array export (from a browser cookie-export extension) or a semicolon-
 * separated "name=value; name2=value2" string.
 *
 * Cookies are always remapped to the caller-supplied `domain`, never the
 * domain recorded inside the export itself — a cookie's domain is enforced
 * by the browser, so a cookie scoped to the wrong host is silently never
 * sent, with no error. See resolvers/gdflix.js for the mirror-domain case
 * this was built for; the same reasoning applies to any cookie-auth target.
 */

/** Best-effort peek at which domain(s) a JSON cookie export was recorded for, for logging only. */
export function extractCookieSourceDomains(cookieStr) {
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
 * Parse a cookie export into Playwright `addCookies()` entries, all remapped
 * to `domain` (which should be dot-prefixed, e.g. ".google.com").
 */
export function parseCookieString(cookieStr, domain) {
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
            domain, // always remap — see module comment above; never trust c.domain
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

/** Derive the dot-prefixed base (eTLD+1-ish) domain from a URL, e.g. "https://new3.gdflix.io/x" -> ".gdflix.io". */
export function baseDomainOf(url) {
  const hostname = new URL(url).hostname.toLowerCase();
  const baseDomain = hostname.split('.').slice(-2).join('.');
  return { hostname, baseDomain, mirrorDomain: `.${baseDomain}` };
}
