import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isGdflixUrl, classifyFinalLink, resolveGdflix, isMultiupValidateUrl, pickMultiupMirrorLink } from '../src/bypass/resolvers/gdflix.js';

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

test('isMultiupValidateUrl matches multiup.io\'s Cloudflare-Worker validator, not unrelated workers.dev/.r2. hosts', () => {
  const shouldMatch = [
    'https://validate.multiup2.workers.dev/804aadc07dd2117a28a3780353bb9b43',
    'https://validate.multiup.workers.dev/abc123',
    'https://validate.multiup9.workers.dev/abc123',
  ];
  for (const url of shouldMatch) {
    assert.equal(isMultiupValidateUrl(url), true, `expected ${url} to match`);
  }

  const shouldNotMatch = [
    'https://pub-6d2a0fe9201646f1b0108e28c8e31dcd.r2.dev/70c5c8ddd0bddc4ef8b29ec977d2bf48',
    'https://some-other-worker.workers.dev/abc',
    'https://multiup.workers.dev/abc', // missing the "validate." subdomain
    'https://drive.google.com/file/d/xyz/view',
  ];
  for (const url of shouldNotMatch) {
    assert.equal(isMultiupValidateUrl(url), false, `expected ${url} to NOT match`);
  }
});

test('pickMultiupMirrorLink prefers gofile.io, then megaup.net, then 1fichier.com, then mega.nz, over unrelated/ad links', () => {
  // Regression fixture: real hrefs observed on a live multiup mirror-list page
  // (goflix.sbs), including the same-host "/download-fast/" link, which is
  // deliberately excluded — it meta-refreshes into an ad-redirect domain
  // rather than a real mirror.
  const hrefs = [
    'https://goflix.sbs/en/upload/from-computer',
    'https://goflix.sbs/download-fast/804aadc07dd2117a28a3780353bb9b43/file.mkv',
    'https://gofile.io/d/gkCQDn',
    'https://megaup.net/06aca92b5ffc63a09dfa29e1319a255f/file.mkv',
    'https://1fichier.com/?dull7ring7ijjroau3pt&af=62851',
  ];
  assert.equal(pickMultiupMirrorLink(hrefs), 'https://gofile.io/d/gkCQDn');

  assert.equal(
    pickMultiupMirrorLink(['https://megaup.net/x/file.mkv', 'https://1fichier.com/?x']),
    'https://megaup.net/x/file.mkv',
  );

  assert.equal(pickMultiupMirrorLink(['https://1fichier.com/?x']), 'https://1fichier.com/?x');
});

test('pickMultiupMirrorLink returns null when no known mirror host is present', () => {
  assert.equal(pickMultiupMirrorLink([]), null);
  assert.equal(pickMultiupMirrorLink(undefined), null);
  assert.equal(pickMultiupMirrorLink(['https://goflix.sbs/en/upload/from-computer', 'https://goflix.sbs/download-fast/x/y.mkv']), null);
});

test('resolveGdflix follows a multiup validator link through to a real mirror instead of stopping at the intermediate worker URL', async () => {
  // Regression: a job for "The Shadow's Edge (2025)" resolved to
  // https://validate.multiup2.workers.dev/... and got stuck classified as a
  // bare 'worker-proxy' link. It should instead be followed through to the
  // real multiup mirror-list page and resolve to a concrete mirror.
  //
  // No G-Drive button/link exists on the GDFlix page in this fixture, so
  // resolveGdflix falls through to the fallback-button path (step 4), whose
  // click is simulated by having the page's own url() already report the
  // validator URL — matching the broad FINAL_HOST_RE used for fallback clicks.
  const validateUrl = 'https://validate.multiup2.workers.dev/804aadc07dd2117a28a3780353bb9b43';

  const mirrorPage = {
    goto: async () => {},
    evaluate: async (fn) => fn(),
    close: async () => {},
  };
  // The multiup mirror-page's own document — swapped in for mirrorPage.evaluate's
  // `document` global via a tiny shim, since our fake page has no real DOM.
  global.document = {
    querySelectorAll: () => [
      { href: 'https://gofile.io/d/gkCQDn' },
      { href: 'https://megaup.net/x/file.mkv' },
    ],
  };

  const fallbackBtn = {
    click: async () => {},
    evaluate: async (fn) => fn({ tagName: 'A', id: '', textContent: 'ZipDisk' }),
  };
  const mainPage = {
    url: () => validateUrl,
    waitForLoadState: async () => {},
    waitForTimeout: async () => {},
    $: async () => null,
    waitForSelector: async () => fallbackBtn,
    evaluate: async () => null,
    context: () => ({ pages: () => [mainPage], newPage: async () => mirrorPage }),
  };

  try {
    const result = await resolveGdflix(mainPage, {}, { log: () => {} });
    assert.equal(result?.linkType, 'direct');
    assert.equal(result?.finalUrl, 'https://gofile.io/d/gkCQDn');
  } finally {
    delete global.document;
  }
});
