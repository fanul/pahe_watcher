import * as cheerio from 'cheerio';

/**
 * Strategy 2: a generic, structure-agnostic fallback. Unlike parser01 (which
 * targets the confirmed `.imdbwp__*` widget), this scans the page's raw
 * visible text for common "Label: value" patterns wherever they appear —
 * it's a best-effort net for a post whose metadata block is missing or
 * shaped differently, not a confirmed second layout. The orchestrator
 * (`./index.js`) only runs it when parser01 left fields empty, and only
 * uses whatever it finds to fill those specific gaps.
 *
 * @param {string} html
 * @returns {{poster:string, rating:string, synopsis:string, year:number|null,
 *   genre:string, durationMinutes:number|null, director:string, creator:string, actors:string}}
 */
export function extractMetadata(html) {
  const $ = cheerio.load(html);
  const text = $.text();

  const poster = findPoster($);
  const rating = findLabeled(text, /(?:IMDb\s*)?Rating\s*:?\s*([\d.]+)(?:\s*\/\s*10)?/i);
  const synopsis = findSynopsis($);
  const year = findYear(text);
  const genre = findLabeled(text, /Genres?\s*:\s*([^\n|]+)/i);
  const durationMinutes = findDurationMinutes(text);
  const director = findLabeled(text, /Directors?\s*:\s*([^\n|]+)/i);
  const creator = findLabeled(text, /(?:Creators?|Created\s*by)\s*:\s*([^\n|]+)/i);
  const actors = findLabeled(text, /(?:Actors?|Cast|Starring)\s*:\s*([^\n|]+)/i);

  return {
    poster,
    rating: rating || '',
    synopsis,
    year,
    genre: cleanList(genre),
    durationMinutes,
    director: cleanList(director),
    creator: cleanList(creator),
    actors: cleanList(actors),
  };
}

/** Runs a "Label: value" regex against the page's flat text and returns the trimmed capture, or ''. */
function findLabeled(text, re) {
  const m = text.match(re);
  return m ? m[1].trim() : '';
}

/** Labeled values are often followed by trailing junk from adjacent text nodes running together — cut at excess length. */
function cleanList(value) {
  if (!value) return '';
  return value.length > 200 ? value.slice(0, 200).trim() : value.trim();
}

function findYear(text) {
  const m = text.match(/\b(19|20)\d{2}\b/);
  return m ? parseInt(m[0], 10) : null;
}

function findDurationMinutes(text) {
  const labeled = text.match(/(?:Runtime|Duration)\s*:?\s*(\d+)\s*min/i);
  if (labeled) return parseInt(labeled[1], 10);
  const bare = text.match(/\b(\d{2,3})\s*min\b/i);
  return bare ? parseInt(bare[1], 10) : null;
}

function findPoster($) {
  let poster = '';
  $('img').each((_, el) => {
    const src = $(el).attr('src');
    if (src && !src.includes('hitcounter') && !src.includes('avatar') && !src.includes('download.png') && !src.includes('favicon')) {
      poster = src;
      return false; // break
    }
  });
  return poster;
}

function findSynopsis($) {
  let synopsis = '';
  $('p').each((_, el) => {
    const $el = $(el);
    const t = $el.text().trim();
    if (t.length > 50 && !$el.find('a').length && !/kbps|gb|mb|pixels|resolutions|imdb/i.test(t) && !t.includes('cookie')) {
      synopsis = t;
      return false; // break
    }
  });
  return synopsis.length > 300 ? synopsis.slice(0, 300) + '...' : synopsis;
}

export default extractMetadata;
