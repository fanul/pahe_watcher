import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDownloadOptions, selectOptions, checkIsSeries } from '../src/parser/postParser.js';

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

