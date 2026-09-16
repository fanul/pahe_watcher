import { createLogger } from '../core/logger.js';

const log = createLogger('bypass:worker-cache');

// Community-run Cloudflare Worker backing the "pahe-auto-continue-links"
// Greasyfork userscript's shared shortlink cache (see its README/
// INTERCELESTIAL_ISSUES.md at github.com/andradeatdev/auto-continue-
// shortlinks). Confirmed live this session: GET /api/check for a real
// pahe.ink shortlink we were independently stuck on returned the exact
// destination a manual walkthrough also reached — this is genuine,
// accurate, community-contributed data, not a hypothetical integration.
// Read-only by default; WORKER_CACHE_CONTRIBUTE also POSTs our own
// successful resolutions back, same as the reference script does.
const WORKER_URL = 'https://shortlinks.fdyzen.workers.dev';

// Only the oii.la-family templates this Worker's cache is actually built
// for — the reference script's own ORIGIN_DOMAINS list, minus pahe.plus
// (our own pipeline already resolves pahe.plus directly; no need to touch
// a third-party dependency for a domain that isn't stuck) and
// en.mrproblogger.com (not part of this app's ad-chain at all).
const ORIGIN_DOMAINS = ['tpi.li', 'oii.la', 'srnky.com', 'clksz.com'];

export function isWorkerCacheOriginUrl(url) {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    return ORIGIN_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));
  } catch {
    return false;
  }
}

// Short timeout — this is a best-effort speedup, never something a job
// should sit around waiting on if the Worker is slow or unreachable.
const FETCH_TIMEOUT_MS = 5000;

async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Ask the community Worker whether this shortlink's final destination is
 * already known. Returns the destination URL, or null on a miss or any
 * failure (network error, timeout, malformed response) — never throws, so
 * callers can treat this as a pure optimization with no failure mode of
 * its own.
 */
export async function checkWorkerCache(shortlinkUrl) {
  try {
    const res = await fetchWithTimeout(
      `${WORKER_URL}/api/check?url=${encodeURIComponent(shortlinkUrl)}`,
      { method: 'GET' },
    );
    if (!res.ok) return null;
    const body = await res.json();
    return body?.status === 'ok' && body.destination ? body.destination : null;
  } catch (err) {
    log.warn(`Worker cache check failed (non-fatal): ${err.message}`);
    return null;
  }
}

/**
 * Contribute a resolved shortlink -> destination pair back to the shared
 * cache, same schema the reference userscript's listenerNavigation() posts.
 * Fire-and-forget from the caller's perspective — failures are logged but
 * never affect the job that already succeeded.
 */
export async function saveToWorkerCache(shortlinkUrl, destinationUrl) {
  try {
    const res = await fetchWithTimeout(`${WORKER_URL}/api/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shortlink: shortlinkUrl, destination: destinationUrl }),
    });
    const body = await res.json().catch(() => null);
    if (body?.status !== 'ok') {
      log.warn(`Worker cache save rejected: ${res.status} ${JSON.stringify(body)}`);
    }
  } catch (err) {
    log.warn(`Worker cache save failed (non-fatal): ${err.message}`);
  }
}
