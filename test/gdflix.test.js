import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isGdflixUrl, classifyFinalLink } from '../src/bypass/resolvers/gdflix.js';

test('isGdflixUrl matches real GDFlix mirrors, including subdomains and various TLDs', () => {
  const shouldMatch = [
    'https://new3.gdflix.io/file/sskeeNk02YGiGSK',
    'https://gdflix.app/file/abc123',
    'https://new2.gdflix.app/file/abc123',
    'https://gdflix.co/file/abc123',
    'https://gdflix.dad/file/abc123',
    'https://gdflix.chat/file/abc123',
    'https://www.gdflix.link/file/abc123',
  ];
  for (const url of shouldMatch) {
    assert.equal(isGdflixUrl(url), true, `expected ${url} to match`);
  }
});

test('isGdflixUrl rejects unrelated hosts that merely contain "gdflix." as a substring', () => {
  // Regression: an earlier unanchored regex (/gdflix\.[a-z]+/) matched
  // "gdflix.example" inside "not-gdflix.example.com", which would have
  // triggered cookie injection (with the user's real GDFlix session)
  // against an untrusted page.
  const shouldNotMatch = [
    'https://not-gdflix.example.com/file/abc123',
    'https://gdflix.attacker.com/file/abc123',
    'https://somegdflixmirror.badsite.net/file/abc123',
    'https://mygdflix.io.evil.com/file/abc123',
    'https://gdflixfake.io/file/abc123',
  ];
  for (const url of shouldNotMatch) {
    assert.equal(isGdflixUrl(url), false, `expected ${url} to NOT match`);
  }
});

test('classifyFinalLink identifies the resolved link type', () => {
  assert.equal(classifyFinalLink('https://drive.google.com/file/d/xyz/view'), 'google-drive');
  assert.equal(classifyFinalLink('https://drive.usercontent.google.com/download?id=xyz'), 'google-drive');
  assert.equal(classifyFinalLink('https://pixeldrain.com/u/abc123'), 'pixeldrain');
  assert.equal(classifyFinalLink('https://foo.workers.dev/dl/abc'), 'worker-proxy');
  assert.equal(classifyFinalLink('https://gdflix.io/direct/abc'), 'direct');
});
