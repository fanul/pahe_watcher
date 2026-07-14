import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isGoogleAuthHost, isGoogleDriveHost, ensureGoogleLogin } from '../src/bypass/resolvers/googleDrive.js';

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

test('ensureGoogleLogin: public file with no sign-in wall is a quick no-op', async () => {
  let addCookiesCalled = false;
  const page = {
    url: () => 'https://drive.google.com/file/d/xyz/view',
    evaluate: async () => 'ok',
    context: () => ({ addCookies: async () => { addCookiesCalled = true; } }),
    reload: async () => {},
  };
  const result = await ensureGoogleLogin(page, { cookies: 'SID=abc' }, { log: () => {} });
  assert.equal(result.loggedIn, true);
  assert.equal(addCookiesCalled, false, 'cookies should never be touched when no wall is present');
});

test('ensureGoogleLogin: sign-in wall + configured cookies authenticates, scoped to .google.com', async () => {
  let statusCallCount = 0;
  let injectedDomain = null;
  const page = {
    url: () => 'https://drive.google.com/file/d/xyz/view',
    evaluate: async () => { statusCallCount++; return statusCallCount === 1 ? 'signed-out' : 'ok'; },
    context: () => ({ addCookies: async (cookies) => { injectedDomain = cookies[0]?.domain; } }),
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
    context: () => ({ addCookies: async () => {} }),
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
    context: () => ({ addCookies: async (cookies) => { injectedDomain = cookies[0]?.domain; } }),
    reload: async () => {},
  };
  const jsonCookies = JSON.stringify([{ domain: 'accounts.google.com', name: 'SID', value: 'x' }]);
  const result = await ensureGoogleLogin(page, { cookies: jsonCookies }, { log: () => {} });
  assert.equal(result.loggedIn, true);
  assert.equal(injectedDomain, '.google.com');
});
