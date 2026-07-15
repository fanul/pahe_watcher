import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDownloadOptions, selectOptions, checkIsSeries, parsePostMetadata, parseSeasonRangeFromTitle } from '../src/parser/postParser.js';

// Real markup captured from a live pahe.ink movie post (imdbwp IMDb-widget layout).
const MOVIE_METADATA_SAMPLE = `
<div class="imdbwp imdbwp--movie dark">
<div class="imdbwp__thumb"><a class="imdbwp__link" href="http://www.imdb.com/title/tt26657236/"><img class="imdbwp__img" src="https://example.com/poster.jpg"></a></div>
<div class="imdbwp__content">
<div class="imdbwp__header"><span class="imdbwp__title">Backrooms</span> (2026)</p>
<div class="imdbwp__meta"><span>110 min</span>|<span>Horror, Sci-Fi, Thriller</span>|<span>29 May 2026</span></div>
</div>
<div class="imdbwp__belt"><span class="imdbwp__star">7.0</span><span class="imdbwp__rating"><strong>Rating:</strong> 7.0 / 10 from 100,148 users</span></div>
<div class="imdbwp__teaser">After a therapist's patient disappears into a dimension beyond reality, she must venture into the unknown to save him.</div>
<div class="imdbwp__footer"><strong>Director:</strong> <span>Kane Parsons</span><br /><strong>Creator:</strong> <span>Will Soodik, Kane Parsons</span><br /><strong>Actors:</strong> <span>Chiwetel Ejiofor, Renate Reinsve, Mark Duplass</span></div>
</div>
</div>
`;

// Real markup from a live in-progress series post: N/A duration, open-ended year, no Director line.
const SERIES_METADATA_SAMPLE = `
<div class="imdbwp imdbwp--series dark">
<div class="imdbwp__content">
<div class="imdbwp__header"><span class="imdbwp__title">House of the Dragon</span> (2022–)</p>
<div class="imdbwp__meta"><span>N/A</span>|<span>Action, Adventure, Drama</span>|<span>21 Aug 2022</span></div>
</div>
<div class="imdbwp__belt"><span class="imdbwp__star">8.3</span></div>
<div class="imdbwp__teaser">An internal succession war within House Targaryen.</div>
<div class="imdbwp__footer"><strong>Creator:</strong> <span>Ryan J. Condal, George R.R. Martin</span><br /><strong>Actors:</strong> <span>Matt Smith, Emma D'Arcy, Olivia Cooke</span></div>
</div>
</div>
`;

test('parsePostMetadata extracts year/genre/duration/director/creator/actors from a movie post', () => {
  const meta = parsePostMetadata(MOVIE_METADATA_SAMPLE);
  assert.equal(meta.year, 2026);
  assert.equal(meta.genre, 'Horror, Sci-Fi, Thriller');
  assert.equal(meta.durationMinutes, 110);
  assert.equal(meta.director, 'Kane Parsons');
  assert.equal(meta.creator, 'Will Soodik, Kane Parsons');
  assert.equal(meta.actors, 'Chiwetel Ejiofor, Renate Reinsve, Mark Duplass');
});

test('parsePostMetadata handles series posts: open-ended year, N/A duration, no Director label', () => {
  const meta = parsePostMetadata(SERIES_METADATA_SAMPLE);
  assert.equal(meta.year, 2022);
  assert.equal(meta.genre, 'Action, Adventure, Drama');
  assert.equal(meta.durationMinutes, null);
  assert.equal(meta.director, '');
  assert.equal(meta.creator, 'Ryan J. Condal, George R.R. Martin');
  assert.equal(meta.actors, "Matt Smith, Emma D'Arcy, Olivia Cooke");
});

test('parsePostMetadata defaults new fields to empty/null when the imdbwp block is absent', () => {
  const meta = parsePostMetadata('<p>No IMDb widget here.</p>');
  assert.equal(meta.year, null);
  assert.equal(meta.genre, '');
  assert.equal(meta.durationMinutes, null);
  assert.equal(meta.director, '');
  assert.equal(meta.creator, '');
  assert.equal(meta.actors, '');
});

// Mirrors the real pahe.ink layout: a <b> quality/size label followed by a row
// of short provider anchors pointing at a shortener host.
const SAMPLE = `
  <p><b>480p x264</b> | 350 MB<br>
    <a href="https://teknoasian.com/?ht=aaa">1F</a>
    <a href="https://teknoasian.com/?ht=bbb">GD</a>
    <a href="https://teknoasian.com/?ht=ccc">MG</a>
  </p>
  <p><b>1080p x265 10Bit</b> | 2.12 GB<br>
    <a href="https://teknoasian.com/?ht=ddd">1F</a>
    <a href="https://teknoasian.com/?ht=eee">GD</a>
  </p>
  <p><a href="https://www.imdb.com/title/tt123">IMDb</a></p>
`;

test('parses provider × quality options and ignores non-shortener links', () => {
  const opts = parseDownloadOptions(SAMPLE);
  assert.equal(opts.length, 5);
  const gd1080 = opts.find((o) => o.provider === 'GD' && o.quality === '1080p');
  assert.ok(gd1080, 'has a GD 1080p option');
  assert.equal(gd1080.url, 'https://teknoasian.com/?ht=eee');
  assert.equal(gd1080.sizeLabel, '2.12 GB');
  assert.equal(gd1080.host, 'teknoasian.com');
});

test('does not treat the IMDb link as a download option', () => {
  const opts = parseDownloadOptions(SAMPLE);
  assert.ok(!opts.some((o) => o.host.includes('imdb')));
});

test('selectOptions filters by provider and quality', () => {
  const opts = parseDownloadOptions(SAMPLE);
  const gd = selectOptions(opts, { providers: ['GD'], qualities: ['1080p'] });
  assert.equal(gd.length, 1);
  assert.equal(gd[0].url, 'https://teknoasian.com/?ht=eee');

  const all480 = selectOptions(opts, { providers: [], qualities: ['480p'] });
  assert.equal(all480.length, 3);
});

test('dedupes identical URLs', () => {
  const dup = SAMPLE + '<p><b>480p</b><br><a href="https://teknoasian.com/?ht=bbb">GD</a></p>';
  const opts = parseDownloadOptions(dup);
  const bbb = opts.filter((o) => o.url === 'https://teknoasian.com/?ht=bbb');
  assert.equal(bbb.length, 1);
});

test('deduplicates codecs based on preferredCodecs priority', () => {
  const sampleWithCodecs = `
    <p><b>720p x264</b><br>
      <a href="https://teknoasian.com/?ht=111">GD</a>
    </p>
    <p><b>720p x265</b><br>
      <a href="https://teknoasian.com/?ht=222">GD</a>
    </p>
  `;
  const opts = parseDownloadOptions(sampleWithCodecs);
  
  // Prefer x265
  const selectedx265 = selectOptions(opts, {
    providers: ['GD'],
    qualities: ['720p'],
    codecs: ['x265', 'x264'],
  });
  assert.equal(selectedx265.length, 1);
  assert.equal(selectedx265[0].url, 'https://teknoasian.com/?ht=222');

  // Prefer x264
  const selectedx264 = selectOptions(opts, {
    providers: ['GD'],
    qualities: ['720p'],
    codecs: ['x264', 'x265'],
  });
  assert.equal(selectedx264.length, 1);
  assert.equal(selectedx264[0].url, 'https://teknoasian.com/?ht=111');
});

test('detects series and filters by preferredSeriesType (batch)', () => {
  const sampleSeries = `
    <p><b>720p x265 Episode 1</b><br>
      <a href="https://teknoasian.com/?ht=ep1">GD</a>
    </p>
    <p><b>720p x265 Episode 1-10</b><br>
      <a href="https://teknoasian.com/?ht=batch">GD</a>
    </p>
  `;
  const opts = parseDownloadOptions(sampleSeries);
  const isSeries = checkIsSeries('Some Series Season 1 [Episode 10 Added]', opts);
  assert.ok(isSeries);

  // Filter for batch
  const selectedBatch = selectOptions(opts, {
    providers: ['GD'],
    qualities: ['720p'],
    seriesType: 'batch',
    isSeries,
  });
  assert.equal(selectedBatch.length, 1);
  assert.equal(selectedBatch[0].url, 'https://teknoasian.com/?ht=batch');

  // Filter for episode
  const selectedEpisode = selectOptions(opts, {
    providers: ['GD'],
    qualities: ['720p'],
    seriesType: 'episode',
    isSeries,
  });
  assert.equal(selectedEpisode.length, 1);
  assert.equal(selectedEpisode[0].url, 'https://teknoasian.com/?ht=ep1');
});

// Mirrors pahe.ink's real multi-season "Complete" season-tabs layout (e.g.
// "The Mentalist Season 1-7 Complete"): each season's quality heading is
// tagged "Season N – ...", repeated per season/quality tier.
const SEASON_TABS_SAMPLE = `
  <div class="box download"><div class="box-inner-block">
    <span><b>Season 1 – 720p x264</b></span> | 23 Eps<br>
    <a href="https://teknoasian.com/?ht=s1_720p_gd1">GD</a>
  </div></div>
  <div class="box download"><div class="box-inner-block">
    <span><b>Season 2 – 720p x264</b></span> | 23 Eps<br>
    <a href="https://teknoasian.com/?ht=s2_720p_gd1">GD</a>
  </div></div>
`;

test('parseDownloadOptions tags each option with its season from multi-season "Complete" layouts', () => {
  const opts = parseDownloadOptions(SEASON_TABS_SAMPLE);
  assert.equal(opts.length, 2);
  assert.equal(opts[0].season, 1);
  assert.equal(opts[1].season, 2);
});

test('parseDownloadOptions leaves season null for single-season (non-tabbed) posts', () => {
  assert.equal(parseDownloadOptions(SAMPLE)[0].season, null);
});

test('parseSeasonRangeFromTitle extracts a season range from the title, or null if absent', () => {
  assert.deepEqual(parseSeasonRangeFromTitle('The Mentalist Season 1-7 Complete WEB-HD 720p & 1080p'), { min: 1, max: 7 });
  assert.deepEqual(parseSeasonRangeFromTitle('Star City Season 1 Complete WEB-DL 720p & 1080p'), { min: 1, max: 1 });
  assert.deepEqual(parseSeasonRangeFromTitle('Foo Season 1–7 Complete'), { min: 1, max: 7 }); // en-dash range separator
  assert.equal(parseSeasonRangeFromTitle('Some Random Movie (2026)'), null);
});

// Real markup from a live pahe.ink post where the quality/size heading is
// PLAIN TEXT, not wrapped in <b>/<strong> (a second layout pahe.ink uses
// alongside the bold one — confirmed present on ~1/3 of a live sample).
const PLAIN_TEXT_LAYOUT_SAMPLE = `
  <div class="box download"><div class="box-inner-block">
    480p x264 | 400 MB<br />
    <a href="https://teknoasian.com/?ht=plain480">GD</a>
    &nbsp;<br />&nbsp;<br />
    720p x264 | 850 MB<br />
    <a href="https://teknoasian.com/?ht=plain720">GD</a>
  </div></div>
`;

test('parseDownloadOptions detects quality/size from a plain-text heading (no <b>/<strong> wrapper)', () => {
  const opts = parseDownloadOptions(PLAIN_TEXT_LAYOUT_SAMPLE);
  assert.equal(opts.length, 2);
  assert.equal(opts[0].quality, '480p');
  assert.equal(opts[0].sizeLabel, '400 MB');
  assert.equal(opts[1].quality, '720p');
  assert.equal(opts[1].sizeLabel, '850 MB');
});

test('parseDownloadOptions does not mistake a bare resolution mention in prose for a quality heading', () => {
  // "Source ....: 1080p ..." in the technical-spec block contains a quality
  // token but no trailing "| SIZE" — must not become the current label.
  const html = `
    <p>Source .........: 1080p AMZN WEB-DL DD+ 2.0 H.264-playWEB<br /></p>
    <div class="box download"><div class="box-inner-block">
      480p x264 | 400 MB<br />
      <a href="https://teknoasian.com/?ht=real480">GD</a>
    </div></div>
  `;
  const opts = parseDownloadOptions(html);
  assert.equal(opts.length, 1);
  assert.equal(opts[0].quality, '480p');
  assert.equal(opts[0].sizeLabel, '400 MB');
});

// Real markup: a single quality heading covers two differently-sized anchor
// groups ("Per Episode" vs "Batch"), a pattern common on multi-season posts.
const MULTI_TIER_SIZE_SAMPLE = `
  <div class="box download"><div class="box-inner-block">
    <span><b>Season 1 – 720p x264</b></span> | 23 Eps<br />
    &nbsp;<br />
    <b>Per Episode</b> 350 MB<br />
    <a href="https://teknoasian.com/?ht=perep">PD</a>
    &nbsp;<br />&nbsp;<br />
    <b>Batch</b> 7.87 GB<br />
    <a href="https://teknoasian.com/?ht=batch1">MG</a>
    <a href="https://teknoasian.com/?ht=batch2">GD</a>
  </div></div>
`;

test('parseDownloadOptions tracks size per sub-tier — Per Episode and Batch under the same quality heading get their own sizes', () => {
  const opts = parseDownloadOptions(MULTI_TIER_SIZE_SAMPLE);
  assert.equal(opts.length, 3);
  const perEpisode = opts.find((o) => o.provider === 'PD');
  const batch = opts.filter((o) => o.provider === 'MG' || o.provider === 'GD');
  assert.equal(perEpisode.sizeLabel, '350 MB');
  for (const o of batch) assert.equal(o.sizeLabel, '7.87 GB');
  // qualityLabel/season stay tied to the outer heading, not the sub-tier label
  assert.equal(perEpisode.qualityLabel, 'Season 1 – 720p x264');
  assert.equal(batch[0].qualityLabel, 'Season 1 – 720p x264');
});

test('parseDownloadOptions handles a per-episode size range ("350-500 MB")', () => {
  const html = `
    <div class="box download"><div class="box-inner-block">
      <b>720p x264</b> | 8 Eps<br />
      &nbsp;<br />
      <b>Per Episode</b> 350-500 MB<br />
      <a href="https://teknoasian.com/?ht=range">GD</a>
    </div></div>
  `;
  const opts = parseDownloadOptions(html);
  assert.equal(opts.length, 1);
  assert.equal(opts[0].sizeLabel, '350-500 MB');
});

