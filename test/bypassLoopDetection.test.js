import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trackUrlRepeat, STUCK_LOOP_THRESHOLD } from '../src/bypass/index.js';

test('trackUrlRepeat fires exactly once, on the Nth consecutive identical URL', () => {
  const state = { lastUrl: null, repeatCount: 0 };
  const url = 'https://linegee.net/96DXF';

  let fired = 0;
  for (let i = 1; i <= STUCK_LOOP_THRESHOLD + 3; i++) {
    if (trackUrlRepeat(state, url)) fired++;
  }
  assert.equal(fired, 1, 'should fire exactly once, not on every tick past the threshold');
  assert.equal(state.repeatCount, STUCK_LOOP_THRESHOLD + 3);
});

test('trackUrlRepeat never fires for a chain that keeps landing on distinct URLs', () => {
  const state = { lastUrl: null, repeatCount: 0 };
  const urls = [
    'https://teknoasian.com/?ht=abc',
    'https://teknoasian.com/',
    'https://linegee.net/96DXF',
    'https://linegee.net/96DXF?ddx=xyz', // a distinct URL — real forward progress
    'https://gdflix.io/file/xyz',
  ];
  for (const u of urls) {
    assert.equal(trackUrlRepeat(state, u), false);
  }
});

test('trackUrlRepeat resets the count when the URL changes, then can still fire again later', () => {
  const state = { lastUrl: null, repeatCount: 0 };
  const stuckUrl = 'https://linegee.net/96DXF';

  // Repeats up to just below the threshold...
  for (let i = 1; i < STUCK_LOOP_THRESHOLD; i++) {
    assert.equal(trackUrlRepeat(state, stuckUrl), false);
  }
  // ...then genuinely moves on (real progress, not a loop).
  assert.equal(trackUrlRepeat(state, 'https://gdflix.io/file/xyz'), false);
  assert.equal(state.repeatCount, 1);

  // If it gets stuck again on a *different* URL later in the chain, detection still works.
  for (let i = 1; i < STUCK_LOOP_THRESHOLD; i++) {
    assert.equal(trackUrlRepeat(state, 'https://another-shortener.example/x'), false);
  }
  assert.equal(trackUrlRepeat(state, 'https://another-shortener.example/x'), true);
});
