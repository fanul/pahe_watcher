import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDownloadOptions, selectOptions, checkIsSeries, parseSeasonRangeFromTitle } from '../src/parser/postParser.js';

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

// Real markup from https://pahe.ink/transporter-season-1-2-complete-720p/ —
// a bare "<b>Season N</b>" heading with the quality/codec info as its own
// plain-text run right after (no <b> wrapper on it, and no size anywhere).
const BARE_SEASON_HEADING_SAMPLE = `
  <div class="box download"><div class="box-inner-block">
    <b>Season 1</b> BluRay 720p x264<br />
    <a href="https://teknoasian.com/?ht=s1a">UTB</a>
    <a href="https://teknoasian.com/?ht=s1b">GD1</a>
  </div></div>
  <div class="box download"><div class="box-inner-block">
    <b>Season 2</b> WEB-DL 720p x264<br />
    <a href="https://teknoasian.com/?ht=s2a">UTB</a>
  </div></div>
`;

test('parseDownloadOptions detects quality from a bare "<b>Season N</b>" heading followed by a plain-text quality/codec run, with no size anywhere', () => {
  const opts = parseDownloadOptions(BARE_SEASON_HEADING_SAMPLE);
  assert.equal(opts.length, 3);
  assert.equal(opts[0].quality, '720p');
  assert.equal(opts[0].qualityLabel, 'Season 1 BluRay 720p x264');
  assert.equal(opts[0].season, 1);
  assert.equal(opts[0].sizeLabel, null);
  assert.equal(opts[2].quality, '720p');
  assert.equal(opts[2].qualityLabel, 'Season 2 WEB-DL 720p x264');
  assert.equal(opts[2].season, 2);
});

test('parseDownloadOptions does not leak a bare "Season N" heading into anchors when no quality text follows it', () => {
  const html = `
    <div class="box download"><div class="box-inner-block">
      <b>Season 1</b><br />
      <a href="https://teknoasian.com/?ht=noqual">GD</a>
    </div></div>
  `;
  const opts = parseDownloadOptions(html);
  assert.equal(opts.length, 1);
  assert.equal(opts[0].quality, null);
});

// Real markup from https://pahe.ink/vampire-vs-vampire-1989-bluray-480p-720p-1080p/
// — quality, codec, and size all run together as one plain-text line with no
// "|" separator and no <b> wrapper at all ("480p x264 400 MB<br />").
const NO_PIPE_PLAIN_LABEL_SAMPLE = `
  <p>Source .........: HKG.Blu-ray.REMUX.1080p.AVC.TrueHD.5.1-DIY<br /></p>
  <div class="box download"><div class="box-inner-block">
    480p x264 400 MB<br />
    <a href="https://teknoasian.com/?ht=a480">UTB</a>
  </div></div>
  <div class="box download"><div class="box-inner-block">
    1080p x264 DD5.1 2.31 GB<br />
    <a href="https://teknoasian.com/?ht=a1080">GD</a>
  </div></div>
`;

test('parseDownloadOptions detects quality/codec/size from a plain-text line with no "|" separator at all', () => {
  const opts = parseDownloadOptions(NO_PIPE_PLAIN_LABEL_SAMPLE);
  assert.equal(opts.length, 2);
  assert.equal(opts[0].quality, '480p');
  assert.equal(opts[0].qualityLabel, '480p x264');
  assert.equal(opts[0].sizeLabel, '400 MB');
  assert.equal(opts[1].quality, '1080p');
  assert.equal(opts[1].qualityLabel, '1080p x264 DD5.1');
  assert.equal(opts[1].sizeLabel, '2.31 GB');
});

test('QUALITY_RE recognizes the rarer 540p/1440p resolution tokens (real markup: "Jurassic World (2015)")', () => {
  const html = `
    <div class="box download"><div class="box-inner-block">
      <b>BluRay 480p x264</b> 450 MB<br />
      <a href="https://teknoasian.com/?ht=a">GD</a>
    </div></div>
    <div class="box download"><div class="box-inner-block">
      <b>BluRay 540p x265 HEVC</b> 726 MB<br />
      <a href="https://teknoasian.com/?ht=b">GD</a>
    </div></div>
    <div class="box download"><div class="box-inner-block">
      <b>WEB-DL 1440p x265 HDR DD5.1</b> 3.1 GB<br />
      <a href="https://teknoasian.com/?ht=c">GD</a>
    </div></div>
  `;
  const opts = parseDownloadOptions(html);
  assert.equal(opts.length, 3);
  assert.equal(opts[0].quality, '480p');
  assert.equal(opts[1].quality, '540p');
  assert.equal(opts[2].quality, '1440p');
});

// Real markup: pahe.ink's SD/HD-tab layout puts the quality in its own
// colored <span> (not <b>), separate from the "| N Eps" episode count and the
// later "<b>Batch</b> SIZE" sub-heading that carries the actual size.
const STANDALONE_SPAN_QUALITY_SAMPLE = `
  <div class="box download"><div class="box-inner-block">
    <span style="color: #00ccff;">480p</span> | 10 Eps<br />
    <b>Batch</b> 1.58 GB<br />
    <a href="https://teknoasian.com/?ht=sd">GD</a>
  </div></div>
  <div class="box download"><div class="box-inner-block">
    <span style="color: #00ccff;">720p</span> | 10 Eps<br />
    <b>Batch</b> 3.47 GB<br />
    <a href="https://teknoasian.com/?ht=hd">GD</a>
  </div></div>
`;

test('parseDownloadOptions detects a quality token that stands alone in its own <span> (SD/HD tab layout)', () => {
  const opts = parseDownloadOptions(STANDALONE_SPAN_QUALITY_SAMPLE);
  assert.equal(opts.length, 2);
  assert.equal(opts[0].quality, '480p');
  assert.equal(opts[0].sizeLabel, '1.58 GB');
  assert.equal(opts[1].quality, '720p');
  assert.equal(opts[1].sizeLabel, '3.47 GB');
});

test('parseDownloadOptions does not mistake the "Source ....: 1080p ..." tech-spec line for a standalone quality span', () => {
  const html = `
    <p>Source .........: 1080p AMZN WEB-DL DD+ 2.0 H.264-playWEB<br /></p>
    <div class="box download"><div class="box-inner-block">
      <b>Per Episode</b> 300 MB<br />
      <a href="https://teknoasian.com/?ht=x">GD</a>
    </div></div>
  `;
  const opts = parseDownloadOptions(html);
  assert.equal(opts.length, 1);
  assert.equal(opts[0].quality, null); // no postTitle passed — nothing to fall back to
});

// Real markup from https://pahe.ink/chuck-season-1-5-complete-bluray-720p/ —
// a second quality tier ("1080p x264 6CH") sits in its own <div class="box
// download"> right after a "<b>Season 1</b> 720p" tier, under the same
// season tab-pane, but has NO "<b>Season N</b>" heading of its own, NO pipe,
// and NO size anywhere near it (the real size, if any, only shows up later
// via its own "<b>Batch</b> SIZE" sub-heading). Regression: this used to be
// silently unrecognized as a heading at all, so its anchors inherited the
// *previous* tier's stale quality/label instead of forming their own group.
const SEASON_WITH_UNHEADED_SECOND_TIER_SAMPLE = `
  <div class="box download"><div class="box-inner-block">
    <b>Season 1</b> 720p<br />
    <b>Per Episode</b><br />
    <a href="https://teknoasian.com/?ht=s1-720-pe">1D</a>
    <b>Batch</b><br />
    <a href="https://teknoasian.com/?ht=s1-720-batch">GD</a>
  </div></div>
  <div class="box download"><div class="box-inner-block">
    1080p x264 6CH<br />
    <b>Per Episode</b><br />
    <a href="https://teknoasian.com/?ht=s1-1080-pe">1D</a>
    <b>Batch</b> 11.89 GB<br />
    <a href="https://teknoasian.com/?ht=s1-1080-batch">GD</a>
  </div></div>
`;

test('a second quality tier with no season heading of its own gets its own group instead of inheriting the previous tier\'s stale quality', () => {
  const opts = parseDownloadOptions(SEASON_WITH_UNHEADED_SECOND_TIER_SAMPLE);
  assert.equal(opts.length, 4);

  assert.equal(opts[0].quality, '720p');
  assert.equal(opts[0].qualityLabel, 'Season 1 720p');
  assert.equal(opts[0].season, 1);
  assert.equal(opts[0].sizeLabel, null); // genuinely no size for this tier

  assert.equal(opts[1].quality, '720p');
  assert.equal(opts[1].qualityLabel, 'Season 1 720p');
  assert.equal(opts[1].season, 1);

  // The 1080p tier — must NOT still read as "720p"/the old label, and must
  // still correctly inherit season 1 (no new season heading appeared).
  assert.equal(opts[2].quality, '1080p');
  assert.equal(opts[2].qualityLabel, '1080p x264 6CH');
  assert.equal(opts[2].season, 1);
  assert.equal(opts[2].sizeLabel, null); // Per Episode tier has no size

  assert.equal(opts[3].quality, '1080p');
  assert.equal(opts[3].qualityLabel, '1080p x264 6CH');
  assert.equal(opts[3].season, 1);
  assert.equal(opts[3].sizeLabel, '11.89 GB'); // Batch tier does have one
});

// Real markup: single-quality releases (e.g. "Quicksand Season 1 Complete NF
// WEB-DL 720p") sometimes never restate the resolution anywhere inside the
// download box at all — just "<b>Per Episode</b> SIZE"/"<b>Batch</b> SIZE"
// with no heading. pahe.ink states it once, in the title, and that's it.
const TITLE_ONLY_QUALITY_SAMPLE = `
  <div class="box download"><div class="box-inner-block">
    <b>Per Episode</b> 300-350 MB<br />
    <a href="https://teknoasian.com/?ht=a">1D</a>
  </div></div>
  <div class="box download"><div class="box-inner-block">
    <b>Batch</b> 1.95 GB (6 Eps)<br />
    <a href="https://teknoasian.com/?ht=b">UTB</a>
  </div></div>
`;

test('parseDownloadOptions falls back to the post title\'s quality when the download box never states one and the title is unambiguous', () => {
  const opts = parseDownloadOptions(TITLE_ONLY_QUALITY_SAMPLE, 'Quicksand Season 1 Complete NF WEB-DL 720p');
  assert.equal(opts.length, 2);
  assert.equal(opts[0].quality, '720p');
  assert.equal(opts[1].quality, '720p');
});

test('the title fallback does not fire without a title, and does not guess when the title names more than one quality', () => {
  const noTitle = parseDownloadOptions(TITLE_ONLY_QUALITY_SAMPLE);
  assert.equal(noTitle[0].quality, null);

  const ambiguousTitle = parseDownloadOptions(TITLE_ONLY_QUALITY_SAMPLE, 'Some Show Season 1 Complete BluRay 480p, 720p & 1080p');
  assert.equal(ambiguousTitle[0].quality, null);
  assert.equal(ambiguousTitle[1].quality, null);
});

test('the title fallback never overwrites a quality this pass already resolved correctly', () => {
  const html = `
    <div class="box download"><div class="box-inner-block">
      <b>480p x264</b> 400 MB<br />
      <a href="https://teknoasian.com/?ht=a">GD</a>
    </div></div>
  `;
  // A misleading title naming a *different* quality than the one already
  // correctly parsed — the fallback only ever fills genuinely null options,
  // so this must be left untouched.
  const opts = parseDownloadOptions(html, 'Some Movie (2020) BluRay 720p');
  assert.equal(opts[0].quality, '480p');
});

// Real markup from https://pahe.ink/vikings-season-1-4/ — a codec-only bold
// tag ("<strong>x264</strong>") appearing mid-line, after the quality was
// already established as plain text just before it. The old code treated
// ANY bold tag matching CODEC_RE as a full heading and overwrote
// currentLabel/currentQuality with just the codec, silently nulling out a
// quality (and, since season was folded into currentLabel, the season too)
// this pass had already correctly resolved.
const CODEC_ONLY_BOLD_TAG_SAMPLE = `
  <div class="box download"><div class="box-inner-block">
    <b>Season 1</b><br />
    720p <strong>x264 </strong>| 3.42 GB<br />
    <a href="https://teknoasian.com/?ht=s1a">GD</a>
  </div></div>
  <div class="box download"><div class="box-inner-block">
    720p <strong>x265 10-Bit</strong> | 2.73 GB<br />
    <a href="https://teknoasian.com/?ht=s1b">GD</a>
  </div></div>
  <div class="box download"><div class="box-inner-block">
    <b>Season 2</b><br />
    1080p <strong>x264</strong> | 5.1 GB<br />
    <a href="https://teknoasian.com/?ht=s2a">GD</a>
  </div></div>
`;

test('a codec-only bold tag (e.g. "720p <strong>x264</strong> | 3.42 GB") augments the running label instead of nulling out an already-resolved quality', () => {
  const opts = parseDownloadOptions(CODEC_ONLY_BOLD_TAG_SAMPLE);
  assert.equal(opts.length, 3);
  assert.equal(opts[0].quality, '720p');
  assert.equal(opts[0].qualityLabel, 'Season 1 720p x264');
  assert.equal(opts[0].season, 1);
  assert.equal(opts[0].sizeLabel, '3.42 GB');
});

test('season persists across a second quality tier under the same bare "Season N" heading, even with no season heading repeated for that tier', () => {
  const opts = parseDownloadOptions(CODEC_ONLY_BOLD_TAG_SAMPLE);
  // Second tier ("720p x265 10-Bit | 2.73 GB") has no <b>Season N</b> of its
  // own — it's still under Season 1's block from the first tier.
  assert.equal(opts[1].quality, '720p');
  assert.equal(opts[1].qualityLabel, '720p x265 10-Bit');
  assert.equal(opts[1].season, 1);
  assert.equal(opts[1].sizeLabel, '2.73 GB');
});

test('a new "Season N" heading correctly overrides the persisted season for later tiers', () => {
  const opts = parseDownloadOptions(CODEC_ONLY_BOLD_TAG_SAMPLE);
  assert.equal(opts[2].quality, '1080p');
  assert.equal(opts[2].season, 2);
  assert.equal(opts[2].sizeLabel, '5.1 GB');
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

