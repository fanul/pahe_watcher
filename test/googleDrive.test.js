import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isGoogleAuthHost, isGoogleDriveHost, ensureGoogleLogin, normalizeGoogleDriveLink } from '../src/bypass/resolvers/googleDrive.js';

test('isGoogleAuthHost / isGoogleDriveHost match real Google hosts and reject look-alikes', () => {
  assert.equal(isGoogleAuthHost('https://accounts.google.com/ServiceLogin?continue=x'), true);
  assert.equal(isGoogleAuthHost('https://accounts.google.com/signin/v2/identifier'), true);
  assert.equal(isGoogleDriveHost('https://drive.google.com/file/d/xyz/view'), true);
  assert.equal(isGoogleDriveHost('https://docs.google.com/document/d/xyz'), true);
  assert.equal(isGoogleDriveHost('https://drive.usercontent.google.com/download?id=xyz'), true);

  // Regression: anchored the same way as the GDFlix host-match fix — a
  // hostname must have "google.com" as an actual label boundary, not just
  // contain the substring anywhere.
  assert.equal(isGoogleAuthHost('https://accounts.google.com.evil.com/x'), false);
  assert.equal(isGoogleDriveHost('https://not-google.com/accounts.google.com'), false);
});

test('ensureGoogleLogin: public file with no sign-in wall and no cookies configured is a quick no-op', async () => {
  let addCookiesCalled = false;
  const page = {
    url: () => 'https://drive.google.com/file/d/xyz/view',
    evaluate: async () => 'ok',
    context: () => ({ addCookies: async () => { addCookiesCalled = true; }, clearCookies: async () => {} }),
    reload: async () => {},
  };
  const result = await ensureGoogleLogin(page, {}, { log: () => {} });
  assert.equal(result.loggedIn, true);
  assert.equal(addCookiesCalled, false, 'cookies should never be touched when none are configured');
});

test('ensureGoogleLogin: already signed in but cookies ARE configured still reasserts the configured account', async () => {
  // Regression: a persistent browser profile can carry a long-lived Google
  // session for a DIFFERENT account than the one configured in Settings.
  // getGoogleLoginStatus() reports "ok" either way, so relying on that alone
  // meant the configured cookies were silently never used. Whenever cookies
  // are configured, they must win over whatever session already exists.
  let clearedDomains = [];
  let addCookiesCalled = false;
  const page = {
    url: () => 'https://drive.google.com/file/d/xyz/view',
    evaluate: async () => 'ok',
    context: () => ({
      addCookies: async () => { addCookiesCalled = true; },
      clearCookies: async ({ domain }) => { clearedDomains.push(domain); },
    }),
    reload: async () => {},
  };
  const result = await ensureGoogleLogin(page, { cookies: 'SID=abc' }, { log: () => {} });
  assert.equal(result.loggedIn, true);
  assert.equal(addCookiesCalled, true, 'configured cookies must be (re)injected even if a stale session already reads as logged in');
  assert.deepEqual(clearedDomains.sort(), ['.google.com', 'google.com'], 'stale session must be cleared before the configured account is injected');
});

test('ensureGoogleLogin: skips the clear+reinject round trip once the configured cookies are already applied for this profile', async () => {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pahe-google-fp-'));
  try {
    let addCookiesCalls = 0;
    let clearCookiesCalls = 0;
    const page = {
      url: () => 'https://drive.google.com/file/d/xyz/view',
      evaluate: async () => 'ok', // session already reads as logged-in
      context: () => ({
        addCookies: async () => { addCookiesCalls++; },
        clearCookies: async () => { clearCookiesCalls++; },
      }),
      reload: async () => {},
    };
    const credentials = { cookies: 'SID=abc', profileDir };

    // First call: no fingerprint on disk yet -> must reassert once and persist it.
    const first = await ensureGoogleLogin(page, credentials, { log: () => {} });
    assert.equal(first.loggedIn, true);
    assert.equal(addCookiesCalls, 1, 'first run for this profile must inject the configured cookies');
    assert.equal(clearCookiesCalls > 0, true);

    // Second call with the SAME cookie string and profile: fingerprint matches
    // and session still reads "ok" -> must skip touching cookies entirely.
    const second = await ensureGoogleLogin(page, credentials, { log: () => {} });
    assert.equal(second.loggedIn, true);
    assert.equal(addCookiesCalls, 1, 'unchanged cookies + already-ok session must not reinject');

    // Third call: cookies changed in Settings -> fingerprint mismatch -> must reassert again.
    const third = await ensureGoogleLogin(page, { cookies: 'SID=newvalue', profileDir }, { log: () => {} });
    assert.equal(third.loggedIn, true);
    assert.equal(addCookiesCalls, 2, 'a changed configured cookie string must trigger reassertion even if session still reads ok');
  } finally {
    fs.rmSync(profileDir, { recursive: true, force: true });
  }
});

test('ensureGoogleLogin: sign-in wall + configured cookies authenticates, scoped to .google.com', async () => {
  let statusCallCount = 0;
  let injectedDomain = null;
  const page = {
    url: () => 'https://drive.google.com/file/d/xyz/view',
    evaluate: async () => { statusCallCount++; return statusCallCount === 1 ? 'signed-out' : 'ok'; },
    context: () => ({
      addCookies: async (cookies) => { injectedDomain = cookies[0]?.domain; },
      clearCookies: async () => {},
    }),
    reload: async () => {},
  };
  const result = await ensureGoogleLogin(page, { cookies: 'SID=abc; HSID=def' }, { log: () => {} });
  assert.equal(result.loggedIn, true);
  assert.equal(result.method, 'cookies');
  assert.equal(injectedDomain, '.google.com');
});

test('ensureGoogleLogin: sign-in wall with no cookies configured skips gracefully (never throws)', async () => {
  const page = {
    url: () => 'https://accounts.google.com/ServiceLogin',
    evaluate: async () => 'signin-page',
    context: () => ({ addCookies: async () => {}, clearCookies: async () => {} }),
    reload: async () => {},
  };
  const result = await ensureGoogleLogin(page, {}, { log: () => {} });
  assert.equal(result.loggedIn, false);
  assert.equal(result.skipped, true);
});

test('ensureGoogleLogin: cookies exported from a different Google subdomain still get remapped and work', async () => {
  let statusCallCount = 0;
  let injectedDomain = null;
  const page = {
    url: () => 'https://drive.google.com/file/d/xyz/view',
    evaluate: async () => { statusCallCount++; return statusCallCount === 1 ? 'signed-out' : 'ok'; },
    context: () => ({
      addCookies: async (cookies) => { injectedDomain = cookies[0]?.domain; },
      clearCookies: async () => {},
    }),
    reload: async () => {},
  };
  const jsonCookies = JSON.stringify([{ domain: 'accounts.google.com', name: 'SID', value: 'x' }]);
  const result = await ensureGoogleLogin(page, { cookies: jsonCookies }, { log: () => {} });
  assert.equal(result.loggedIn, true);
  assert.equal(injectedDomain, '.google.com');
});

test('normalizeGoogleDriveLink: rewrites the "open" (view) page to the direct-download form', () => {
  // Regression: reported case — the resolver captured an /open?id=... URL,
  // which shows a viewer/confirmation page instead of triggering a download.
  const input = 'https://drive.usercontent.google.com/open?id=1kltbgljiDBaofuiDu7TZJlBKY-kDlPg_&authuser=0';
  const out = new URL(normalizeGoogleDriveLink(input));
  assert.equal(out.hostname, 'drive.usercontent.google.com');
  assert.equal(out.pathname, '/download');
  assert.equal(out.searchParams.get('id'), '1kltbgljiDBaofuiDu7TZJlBKY-kDlPg_');
  assert.equal(out.searchParams.get('export'), 'download');
  assert.equal(out.searchParams.get('authuser'), '0');
});

test('normalizeGoogleDriveLink: leaves an already-correct download link unchanged', () => {
  const correct = 'https://drive.usercontent.google.com/download?id=1tYCC8uBXyi69ssbjHEOlv1phBohjlTdU&export=download&authuser=0';
  assert.equal(normalizeGoogleDriveLink(correct), correct);
});

test('normalizeGoogleDriveLink: converts a classic share link (/file/d/{id}/view) to direct-download form', () => {
  const out = new URL(normalizeGoogleDriveLink('https://drive.google.com/file/d/1abcXYZ/view?usp=sharing'));
  assert.equal(out.hostname, 'drive.usercontent.google.com');
  assert.equal(out.pathname, '/download');
  assert.equal(out.searchParams.get('id'), '1abcXYZ');
  assert.equal(out.searchParams.get('export'), 'download');
});

test('normalizeGoogleDriveLink: adds export=download to a legacy /uc link missing it', () => {
  const out = new URL(normalizeGoogleDriveLink('https://drive.google.com/uc?id=1abcXYZ'));
  assert.equal(out.searchParams.get('export'), 'download');
});

test('normalizeGoogleDriveLink: leaves unrelated URLs untouched', () => {
  const other = 'https://pixeldrain.com/u/abc123';
  assert.equal(normalizeGoogleDriveLink(other), other);
});
