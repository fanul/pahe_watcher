import * as cheerio from 'cheerio';

/**
 * Known link-shortener entry hosts used by pahe.ink. A download option's URL
 * points at one of these; the bypass engine drives the rest of the chain.
 */
export const SHORTENER_HOSTS = [
  'teknoasian.com',
  'intercelestial.com',
  'linegee.net',
  'oii.la',
  'uii.io',
  'tpi.li',
  'pahe.plus',
  'blogmystt.com',
];

/** Provider code -> human name. Codes appear as the anchor text in posts. */
export const PROVIDER_NAMES = {
  GD: 'GDFlix (Google Drive)',
  '1F': '1Fichier',
  MG: 'Mega',
  VF: 'VidFast',
  TB: 'TeraBox',
};

const QUALITY_RE = /(2160p|1080p|720p|480p)/i;
const CODEC_RE = /(x264|x265|hevc|10bit|av1|dd\+?5\.1|blu-?ray|web-?dl)/i;

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function isShortener(url) {
  const h = hostOf(url);
  return SHORTENER_HOSTS.some((s) => h === s || h.endsWith(`.${s}`));
}

/**
 * Parse a post's rendered HTML into a structured list of download options.
 *
 * Each option = { provider, providerName, quality, sizeLabel, url, host }.
 * Quality/size is inferred from the nearest preceding <b>/<strong> heading,
 * matching the pahe.ink layout: "<b>720p x264</b> | 750 MB <br> 1F GD MG VF TB".
 *
 * @param {string} html
 * @returns {Array<object>}
 */
export function parseDownloadOptions(html) {
  const $ = cheerio.load(html);
  const options = [];
  let currentLabel = null;
  let currentQuality = null;
  let currentSize = null;

  // Walk block markers and anchors in document order.
  $('b, strong, a').each((_, el) => {
    const $el = $(el);
    const tag = el.tagName?.toLowerCase();

    if (tag === 'b' || tag === 'strong') {
      const text = $el.text().replace(/\s+/g, ' ').trim();
      if (QUALITY_RE.test(text) || CODEC_RE.test(text)) {
        currentLabel = text;
        currentQuality = (text.match(QUALITY_RE) || [])[0]?.toLowerCase() || null;
        currentSize = null;
      }
      return;
    }

    // anchor
    const href = $el.attr('href') || '';
    if (!href || !isShortener(href)) return;
    const code = $el.text().replace(/\s+/g, ' ').trim().toUpperCase();
    if (!code || code.length > 4) return; // provider codes are short (GD, 1F, ...)

    // capture size that trails the bold label on the same line if present
    if (currentLabel && currentSize === null) {
      const m = currentLabelSize($, el, currentLabel);
      currentSize = m;
    }

    options.push({
      provider: code,
      providerName: PROVIDER_NAMES[code] || code,
      quality: currentQuality,
      qualityLabel: currentLabel,
      sizeLabel: currentSize,
      url: href,
      host: hostOf(href),
    });
  });

  return dedupe(options);
}

/** Best-effort: pull the "| 750 MB" size that follows the bold quality label. */
function currentLabelSize($, anchorEl, label) {
  // The size text usually sits as a text node right after the <b> element,
  // e.g. "<b>720p x264</b> | 750 MB". Look back from the anchor's parent text.
  const parentText = $(anchorEl).parent().text();
  const idx = parentText.indexOf(label);
  if (idx === -1) return null;
  const after = parentText.slice(idx + label.length, idx + label.length + 40);
  const m = after.match(/([\d.]+\s?(?:GB|MB))/i);
  return m ? m[1] : null;
}

function dedupe(options) {
  const seen = new Set();
  return options.filter((o) => {
    const k = o.url;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * Filter parsed options by preferred providers and qualities (from config).
 * Empty preference arrays mean "accept all".
 */
export function selectOptions(options, { providers = [], qualities = [] } = {}) {
  const wantP = providers.map((p) => p.toUpperCase());
  const wantQ = qualities.map((q) => q.toLowerCase());
  return options.filter((o) => {
    const pOk = wantP.length === 0 || wantP.includes(o.provider);
    const qOk = wantQ.length === 0 || (o.quality && wantQ.includes(o.quality));
    return pOk && qOk;
  });
}

export default parseDownloadOptions;
