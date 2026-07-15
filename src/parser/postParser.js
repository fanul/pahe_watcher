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

    // Multi-season "Complete" archive posts tag each quality heading with its
    // season, e.g. "Season 1 – 720p x264" (pahe.ink's season-tabs layout).
    // Single-season posts have no such prefix — season stays null for them.
    const seasonMatch = currentLabel && currentLabel.match(/season\s*(\d+)/i);
    const season = seasonMatch ? parseInt(seasonMatch[1], 10) : null;

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

export function parsePostMetadata(html) {
  const $ = cheerio.load(html);
  
  // 1. Poster Image
  let poster = $('.imdbwp__img').attr('src') || $('.imdbwp__thumb img').attr('src') || '';
  if (!poster) {
    $('img').each((_, el) => {
      const src = $(el).attr('src');
      if (src && !src.includes('hitcounter') && !src.includes('avatar') && !src.includes('download.png') && !src.includes('favicon')) {
        poster = src;
        return false; // break
      }
    });
  }

  // 2. IMDb Rating
  let rating = $('.imdbwp__star').first().text().trim() || '';
  if (!rating) {
    const textContent = $.text();
    const imdbMatch = textContent.match(/IMDb\s*(?:Rating)?\s*:\s*([\d.]+)(?:\/\d+)?/i);
    if (imdbMatch) {
      rating = imdbMatch[1];
    }
  }

  // 3. Synopsis
  let synopsis = $('.imdbwp__teaser').first().text().trim() || '';
  if (!synopsis) {
    let synopsisEl = null;
    $('p, div, b, strong, h3').each((_, el) => {
      const text = $(el).text().trim().toLowerCase();
      if (text === 'synopsis' || text === 'storyline' || text.startsWith('story:')) {
        synopsisEl = el;
        return false; // break
      }
    });

    if (synopsisEl) {
      let next = $(synopsisEl).next();
      if (next.length && next.text().trim()) {
        synopsis = next.text().trim();
      } else {
        let parentNext = $(synopsisEl).parent().next();
        if (parentNext.length) {
          synopsis = parentNext.text().trim();
        }
      }
    }
  }

  // Fallback: grab first paragraph that is long enough and not technical specs
  if (!synopsis) {
    $('p').each((_, el) => {
      const $el = $(el);
      const text = $el.text().trim();
      if (text.length > 50 && !$el.find('a').length && !/kbps|gb|mb|pixels|resolutions|imdb/i.test(text) && !text.includes('cookie')) {
        synopsis = text;
        return false; // break
      }
    });
  }

  if (synopsis.length > 300) {
    synopsis = synopsis.slice(0, 300) + '...';
  }

  // 4. Release year (from the header, e.g. "Backrooms (2026)" or "House of the Dragon (2022–)")
  const headerText = $('.imdbwp__header').first().text();
  const yearMatch = headerText.match(/\((\d{4})/);
  const year = yearMatch ? parseInt(yearMatch[1], 10) : null;

  // 5. Duration + genre (from the pipe-separated meta line, e.g. "110 min|Horror, Sci-Fi|29 May 2026")
  const metaSpans = $('.imdbwp__meta').first().children('span');
  const durationText = metaSpans.eq(0).text().trim();
  const genreText = metaSpans.eq(1).text().trim();
  const durationMatch = durationText.match(/(\d+)\s*min/i);
  const durationMinutes = durationMatch ? parseInt(durationMatch[1], 10) : null;
  const genre = genreText && genreText.toUpperCase() !== 'N/A' ? genreText : '';

  // 6. Director/Creator/Actors (label-driven — series posts omit Director)
  let director = '';
  let creator = '';
  let actors = '';
  $('.imdbwp__footer').first().find('strong').each((_, el) => {
    const label = $(el).text().replace(/:/g, '').trim().toLowerCase();
    const value = $(el).next('span').text().trim();
    if (!value) return;
    if (label === 'director') director = value;
    else if (label === 'creator') creator = value;
    else if (/^actors?$/.test(label)) actors = value;
  });

  return { poster, rating, synopsis, year, genre, durationMinutes, director, creator, actors };
}

export default parseDownloadOptions;
