import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isExeyGateUrl } from '../src/bypass/resolvers/exeyGate.js';

test('isExeyGateUrl matches exe.io, exeygo.com, exeo.app, and exey.io hosts', () => {
  for (const url of [
    'https://exe.io/BZKfr5pt',
    'https://exeygo.com/BZKfr5pt?cda_token=abc',
    'https://www.exeygo.com/BZKfr5pt',
    'https://exeo.app/xyz',
    'https://exey.io/xyz',
  ]) {
    assert.equal(isExeyGateUrl(url), true, `expected ${url} to match`);
  }

  for (const url of [
    'https://not-exeygo.com/abc',
    'https://gdflix.io/file/123',
    'https://intercelestial.com/?ht=123',
    'not-a-url',
  ]) {
    assert.equal(isExeyGateUrl(url), false, `expected ${url} NOT to match`);
  }
});
