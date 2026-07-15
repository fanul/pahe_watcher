import * as cheerio from 'cheerio';

/**
 * Strategy 1: pahe.ink's `imdbwp` IMDb-widget block (`.imdbwp__header`,
 * `.imdbwp__meta`, `.imdbwp__teaser`, `.imdbwp__footer`, ...). This is the
 * primary, most reliable source — confirmed against many live posts — and
 * the first strategy the orchestrator (`./index.js`) tries.
 *
 * @param {string} html
 * @returns {{poster:string, rating:string, synopsis:string, year:number|null,
 *   genre:string, durationMinutes:number|null, director:string, creator:string, actors:string}}
 */
export function extractMetadata(html) {
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

export default extractMetadata;
