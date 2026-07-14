import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isGdflixUrl, classifyFinalLink, resolveGdflix } from '../src/bypass/resolvers/gdflix.js';

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

test('resolveGdflix: clicking G-Drive Link waits for an actual Drive URL, ignoring an unrelated tab with a worker-proxy link', async () => {
  // Regression: clickAndAwaitLink used to accept ANY FINAL_HOST_RE match
  // (including pixeldrain/.r2.dev/workers.dev) regardless of which button
  // triggered the click. If some other already-open tab (ad popup, a
  // different mirror link on the same page) happened to carry a
  // workers.dev/.r2.dev URL, that got grabbed instead of the real Drive
  // link the G-Drive Link button was supposed to produce.
  let driveLinkRevealed = false;
  setTimeout(() => { driveLinkRevealed = true; }, 200);

  const primaryBtn = {
    click: async () => {},
    evaluate: async (fn) => fn({ tagName: 'BUTTON', id: 'ddl', textContent: 'G-Drive Link [10GBPS]' }),
  };
  const adPopupPage = {
    url: () => 'https://pub-6d2a0fe9201646f1b0108e28c8e31dcd.r2.dev/70c5c8ddd0bddc4ef8b29ec977d2bf48?token=123',
    evaluate: async () => null,
    close: async () => {},
  };
  const mainPage = {
    url: () => 'https://new3.gdflix.io/file/sskeeNk02YGiGSK',
    waitForLoadState: async () => {},
    waitForTimeout: async (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 20))),
    $: async (sel) => (sel.includes('G-Drive Link') || sel === 'button#ddl' || sel === '#ddl' ? primaryBtn : null),
    evaluate: async (fn, arg) => {
      if (typeof arg === 'string') {
        return driveLinkRevealed ? 'https://drive.google.com/file/d/REAL123/view?usp=sharing' : null;
      }
      return null; // login-gate scan
    },
    context: () => ({ pages: () => [mainPage, adPopupPage] }),
  };

  const result = await resolveGdflix(mainPage, {}, { log: () => {} });
  assert.equal(result?.linkType, 'google-drive');
  assert.equal(result?.finalUrl, 'https://drive.google.com/file/d/REAL123/view?usp=sharing');
});
