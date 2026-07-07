import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDownloadOptions, selectOptions } from '../src/parser/postParser.js';

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
