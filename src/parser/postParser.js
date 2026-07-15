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

// Single source of truth for recognized resolution tokens — reused by every
// quality-heading regex below so adding a new resolution (e.g. a rarer one
// like 540p/1440p) only needs to happen in one place.
const QUALITY_TOKEN_SRC = '2160p|1440p|1080p|720p|540p|480p';
const QUALITY_RE = new RegExp(`(${QUALITY_TOKEN_SRC})`, 'i');
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
 * Flattens the DOM into a document-order sequence of the nodes
 * parseDownloadOptions cares about: <b>/<strong> headings, plain text runs,
 * and <a> anchors. pahe.ink uses two layouts for the quality/size heading
 * that precedes each row of provider links — bolded
 * ("<b>720p x264</b> | 750 MB") or plain text ("720p x264 | 750 MB", no
 * wrapper at all) — so both need to be visible to the same walk, not just
 * elements matched by a flat `b, strong, a` selector.
 */
function flattenNodes($, root, out) {
  $(root).contents().each((_, node) => {
    if (node.type === 'text') {
      const text = (node.data || '').trim();
      if (text) out.push({ type: 'text', text });
    } else if (node.type === 'tag') {
      const tag = node.tagName?.toLowerCase();
      if (tag === 'script' || tag === 'style') return;
      if (tag === 'a') out.push({ type: 'a', el: node });
      else if (tag === 'b' || tag === 'strong') out.push({ type: 'b', el: node });
      else flattenNodes($, node, out);
    }
  });
}

// A size figure, either a single value ("750 MB") or a per-episode range
// ("350-500 MB").
const SIZE_RE_SRC = '[\\d.]+(?:\\s*-\\s*[\\d.]+)?\\s?(?:GB|MB)';

// Plain-text quality heading, e.g. "720p x264 | 750 MB" — requires the
// trailing "| SIZE" to distinguish a real heading from incidental mentions
// of a resolution elsewhere in the post (e.g. the "Source ....: 1080p ..."
// line in the technical-spec block, which never has a pipe+size after it).
const PLAIN_LABEL_RE = new RegExp(`^(.*?(?:${QUALITY_TOKEN_SRC})[^|]*?)\\s*\\|\\s*(${SIZE_RE_SRC})`, 'i');

// Same plain-text heading, but with no "|" separator at all — e.g.
// "480p x264 400 MB<br />" (quality, codec, and size run together as one
// space-separated line, no wrapper, no pipe). Anchored to the end of the
// string (unlike PLAIN_LABEL_RE) so it only matches when the size is truly
// the last thing on the line — a tech-spec line that merely mentions a
// resolution won't also happen to end in "NN GB/MB".
const PLAIN_LABEL_NO_PIPE_RE = new RegExp(`^(.*?(?:${QUALITY_TOKEN_SRC}).*?)\\s+(${SIZE_RE_SRC})$`, 'i');

// A short heading line that *starts* with a quality token and has no size
// anywhere on it — e.g. a bare "<span>480p</span>" quality-only element
// (nothing trailing at all), or plain text like "1080p x264 6CH" (codec plus
// an audio-channel-count annotation pahe.ink sometimes tacks on, with no
// pipe and no size — the real size shows up later via its own "<b>Batch</b>
// SIZE" sub-heading, handled separately by BARE_SIZE_RE). Anchored at the
// *start* only (unlike PLAIN_LABEL_NO_PIPE_RE, which requires a trailing
// size) — safe because a tech-spec line mentioning a resolution always has a
// "Label ....: " prefix before it, so it never starts with the quality token
// itself. Capped at a short trailing run so it can't accidentally swallow an
// unrelated, much longer sentence that happens to start with a number.
const SHORT_QUALITY_HEADING_RE = new RegExp(`^(?:${QUALITY_TOKEN_SRC})\\b.{0,24}$`, 'i');

// A bare size figure with no quality token attached — e.g. the " | 750 MB"
// text that immediately follows a bolded "<b>720p x264</b>" heading, or the
// " 350 MB" / " 7.87 GB" that follows a non-quality sub-heading like
// "<b>Per Episode</b>"/"<b>Batch</b>" within a multi-tier quality block.
// Updates only the running size, never the quality/season context.
const BARE_SIZE_RE = new RegExp(`^\\|?\\s*(${SIZE_RE_SRC})\\b`, 'i');

/**
 * Parse a post's rendered HTML into a structured list of download options.
 *
 * Each option = { provider, providerName, quality, sizeLabel, url, host }.
 * Quality is inferred from the nearest preceding quality/codec heading —
 * either a bolded one ("<b>720p x264</b>") or, on pahe.ink posts that don't
 * bold it, a plain-text one ("720p x264 | 750 MB"). Size is tracked
 * independently as its own running value, since a single quality heading
 * can cover multiple differently-sized anchor groups further down (e.g.
 * "<b>Per Episode</b> 350 MB" then "<b>Batch</b> 7.87 GB" under the same
 * "720p x264" heading) — the size resets whenever a new one is seen, not
 * only when the quality changes.
 *
 * @param {string} html
 * @param {string} [postTitle] - Optional; used only as a last-resort quality
 *   fallback (see the bottom of this function) for single-quality releases
 *   whose download box never restates the resolution the title already names.
 * @returns {Array<object>}
 */
export function parseDownloadOptions(html, postTitle = '') {
  const $ = cheerio.load(html);
  const options = [];
  let currentLabel = null;
  let currentQuality = null;
  let currentSize = null;
  // A bare "<b>Season N</b>" heading with no quality/codec baked into the
  // bold text itself — on this layout, the quality/codec info follows right
  // after as its own plain-text run with no size figure at all, e.g.
  // "<b>Season 1</b> BluRay 720p x264<br/>". Consumed by the very next text
  // node if it carries a quality token; otherwise dropped so it can't leak
  // into an unrelated later heading.
  let pendingSeasonHeading = null;
  // Persists across multiple quality tiers under the same bare season
  // heading (e.g. "<b>Season 1</b>" followed by both a "720p x264" tier AND
  // a separate later "720p x265 10-Bit" tier with no season heading of its
  // own) — unlike pendingSeasonHeading, which is a one-shot value consumed
  // by only the first tier, this stays in effect until a new "Season N"
  // heading actually appears. Used as a fallback when currentLabel itself
  // doesn't contain "Season N" text (e.g. this second tier's own label).
  let currentSeason = null;

  const flat = [];
  flattenNodes($, $.root(), flat);

  for (const item of flat) {
    if (item.type === 'b') {
      const text = $(item.el).text().replace(/\s+/g, ' ').trim();
      if (QUALITY_RE.test(text)) {
        currentLabel = text;
        currentQuality = (text.match(QUALITY_RE) || [])[0]?.toLowerCase() || null;
        currentSize = null;
        pendingSeasonHeading = null;
      } else if (/^season\s*\d+$/i.test(text)) {
        pendingSeasonHeading = text;
        currentSeason = parseInt(text.match(/season\s*(\d+)/i)[1], 10);
      } else if (CODEC_RE.test(text)) {
        // A codec-only bold tag with no quality token of its own, e.g.
        // "Season 1<br/>720p <strong>x264</strong> | 3.42 GB" — the quality
        // (and season, folded into currentLabel) were already established
        // by the plain-text "720p" just before it. Augment the running
        // label instead of overwriting it, so this doesn't null out a
        // quality/season this pass already correctly resolved.
        currentLabel = currentLabel ? `${currentLabel} ${text}`.trim() : text;
      }
      continue;
    }

    if (item.type === 'text') {
      const plainLabelMatch = item.text.match(PLAIN_LABEL_RE);
      if (plainLabelMatch) {
        currentLabel = plainLabelMatch[1].trim();
        currentQuality = (currentLabel.match(QUALITY_RE) || [])[0]?.toLowerCase() || null;
        currentSize = plainLabelMatch[2];
        pendingSeasonHeading = null;
        continue;
      }

      const plainLabelNoPipeMatch = item.text.match(PLAIN_LABEL_NO_PIPE_RE);
      if (plainLabelNoPipeMatch) {
        currentLabel = plainLabelNoPipeMatch[1].trim();
        currentQuality = (currentLabel.match(QUALITY_RE) || [])[0]?.toLowerCase() || null;
        currentSize = plainLabelNoPipeMatch[2];
        pendingSeasonHeading = null;
        continue;
      }

      if (pendingSeasonHeading && QUALITY_RE.test(item.text)) {
        currentLabel = `${pendingSeasonHeading} ${item.text}`.trim();
        currentQuality = (item.text.match(QUALITY_RE) || [])[0]?.toLowerCase() || null;
        currentSize = null;
        pendingSeasonHeading = null;
        continue;
      }
      pendingSeasonHeading = null;

      if (SHORT_QUALITY_HEADING_RE.test(item.text)) {
        currentLabel = item.text;
        currentQuality = (item.text.match(QUALITY_RE) || [])[0]?.toLowerCase() || null;
        currentSize = null;
        continue;
      }

      const bareSizeMatch = item.text.match(BARE_SIZE_RE);
      if (bareSizeMatch) currentSize = bareSizeMatch[1];
      continue;
    }

    // anchor
    pendingSeasonHeading = null;
    const el = item.el;
    const $el = $(el);
    const href = $el.attr('href') || '';
    if (!href || !isShortener(href)) continue;
    const code = $el.text().replace(/\s+/g, ' ').trim().toUpperCase();
    if (!code || code.length > 4) continue; // provider codes are short (GD, 1F, ...)

    // Multi-season "Complete" archive posts tag each quality heading with its
    // season, e.g. "Season 1 – 720p x264" (pahe.ink's season-tabs layout).
    // Falls back to currentSeason (the last bare "Season N" heading seen) for
    // later quality tiers under the same season that don't restate it in
    // their own label. Single-season posts have no season anywhere — stays
    // null for them.
    const seasonMatch = currentLabel && currentLabel.match(/season\s*(\d+)/i);
    const season = seasonMatch ? parseInt(seasonMatch[1], 10) : currentSeason;

    options.push({
      provider: code,
      providerName: PROVIDER_NAMES[code] || code,
      quality: currentQuality,
      qualityLabel: currentLabel,
      season,
      sizeLabel: currentSize,
      url: href,
      host: hostOf(href),
    });
  }

  const deduped = dedupe(options);

  // Last-resort fallback: some single-quality releases never mention the
  // resolution anywhere inside the download box at all (just "<b>Per
  // Episode</b> SIZE"/"<b>Batch</b> SIZE" with no heading) — pahe.ink states
  // it once, in the post title, and doesn't bother repeating it. Only
  // applied when the title names exactly one quality tier, so a multi-
  // quality post (title has "480p, 720p & 1080p") can't get all its distinct
  // tiers wrongly collapsed onto whichever one happens to still be null.
  if (postTitle && deduped.some((o) => !o.quality)) {
    const titleQualities = [...new Set(
      (postTitle.match(new RegExp(QUALITY_TOKEN_SRC, 'gi')) || []).map((q) => q.toLowerCase()),
    )];
    if (titleQualities.length === 1) {
      for (const o of deduped) {
        if (!o.quality) {
          o.quality = titleQualities[0];
          if (!o.qualityLabel) o.qualityLabel = titleQualities[0];
        }
      }
    }
  }

  return deduped;
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
 * Extracts the season range a post's TITLE claims to cover, e.g.
 * "The Mentalist Season 1-7 Complete" -> {min:1, max:7}, "Foo Season 3" ->
 * {min:3, max:3}. Returns null when the title doesn't declare a season
 * range at all (nothing to compare against for staleness detection).
 */
export function parseSeasonRangeFromTitle(title) {
  const m = (title || '').match(/season\s*(\d+)(?:\s*[-–]\s*(\d+))?/i);
  if (!m) return null;
  const min = parseInt(m[1], 10);
  const max = m[2] ? parseInt(m[2], 10) : min;
  return { min, max };
}

/**
 * Detects if a post is a series (based on title and parsed option labels).
 */
export function checkIsSeries(postTitle, options) {
  if (/season|episode|web-dl\s+\[ep|s\d+e\d+|\bs\d+\b/i.test(postTitle)) return true;
  return (options || []).some((o) => {
    const label = (o.qualityLabel || '').toLowerCase();
    return /episode|ep|batch|complete/i.test(label);
  });
}

function isBatchOption(option) {
  const label = (option.qualityLabel || '').toLowerCase();
  if (/batch|complete|pack|collection/i.test(label)) return true;
  if (/\b\d+\s*-\s*\d+\b/.test(label)) return true; // e.g. "1-10" or "01-12"
  return false;
}

function isEpisodeOption(option) {
  const label = (option.qualityLabel || '').toLowerCase();
  if (/(?:episode|ep)\s*\d+/i.test(label) && !/\b\d+\s*-\s*\d+\b/.test(label)) return true;
  return false;
}

function getCodecRank(label, codecs) {
  const l = (label || '').toLowerCase();
  for (let i = 0; i < codecs.length; i++) {
    const codec = codecs[i].toLowerCase();
    if (l.includes(codec)) return i;
  }
  return codecs.length; // lowest preference rank
}

/**
 * Filter parsed options by preferred providers, qualities, codecs, and series type.
 * Deduplicates multiple codecs for the same provider/quality pair.
 */
export function selectOptions(options, { providers = [], qualities = [], codecs = ['x265', 'x264'], seriesType = 'batch', isSeries = false } = {}) {
  const wantP = providers.map((p) => p.toUpperCase());
  const wantQ = qualities.map((q) => q.toLowerCase());

  // 1. Filter by basic provider and quality
  let filtered = options.filter((o) => {
    const pOk = wantP.length === 0 || wantP.includes(o.provider);
    const qOk = wantQ.length === 0 || (o.quality && wantQ.includes(o.quality));
    return pOk && qOk;
  });

  // 2. Filter by series type if it's a series
  if (isSeries) {
    if (seriesType === 'batch') {
      filtered = filtered.filter((o) => isBatchOption(o));
    } else if (seriesType === 'episode') {
      filtered = filtered.filter((o) => isEpisodeOption(o));
    }
  }

  // 3. Deduplicate codecs for the same (provider, quality, episode) key
  const groups = {};
  for (const o of filtered) {
    const epMatch = (o.qualityLabel || '').match(/(?:episode|ep)\s*(\d+)/i);
    const epKey = epMatch ? `ep${epMatch[1]}` : '';
    
    // Group key example: "GD-720p-ep1" or "GD-1080p-"
    const key = `${o.provider}-${o.quality || 'unknown'}-${epKey}`;
    if (!groups[key]) groups[key] = [];
    groups[key].push(o);
  }

  const result = [];
  for (const key in groups) {
    const list = groups[key];
    if (list.length <= 1) {
      result.push(...list);
      continue;
    }

    // Sort by user's codec preference rank (lower index is better)
    list.sort((a, b) => {
      const rankA = getCodecRank(a.qualityLabel, codecs);
      const rankB = getCodecRank(b.qualityLabel, codecs);
      return rankA - rankB;
    });

    result.push(list[0]);
  }

  return result;
}

export default parseDownloadOptions;
