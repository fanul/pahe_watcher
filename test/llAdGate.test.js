import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readButtonState, findClickableInstance, sweepToExtreme } from '../src/bypass/resolvers/llAdGate.js';

test('readButtonState prefers a visible uncovered middle button over a hidden 0x0 decoy', async () => {
  const hiddenBtn = {
    textContent: 'Continue',
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }),
  };
  const middleBtn = {
    textContent: 'Continue',
    getBoundingClientRect: () => ({ left: 500, top: 350, width: 160, height: 44 }),
  };

  global.window = {
    innerWidth: 1366,
    innerHeight: 768,
    scrollY: 900,
    getComputedStyle: (el) =>
      el === hiddenBtn
        ? { display: 'none', visibility: 'hidden', opacity: '0' }
        : { display: 'inline-block', visibility: 'visible', opacity: '1' },
  };
  global.document = {
    querySelectorAll: (sel) => (sel === '.myButton' ? [hiddenBtn, middleBtn] : []),
    getElementById: () => null,
    elementFromPoint: (x, y) => (x >= 500 && x <= 660 && y >= 350 && y <= 394 ? middleBtn : null),
  };

  const fakeFrame = {
    evaluate: async (fn, arg) => fn(arg),
  };
  const fakePage = {
    frames: () => [fakeFrame],
    mainFrame: () => fakeFrame,
  };

  try {
    const state = await readButtonState(fakePage);
    assert.equal(state.targetIndex, 1);
    assert.equal(state.targetVisible, true);
    assert.equal(state.targetCentered, true);
    assert.equal(state.targetUncovered, true);
  } finally {
    delete global.window;
    delete global.document;
  }
});

test('findClickableInstance rejects an ad overlay even with cursor:pointer, and finds a clear side point when center is covered', async () => {
  const adOverlay = { id: 'ad-overlay', contains: () => false };
  const btn = {
    textContent: 'Generate Link',
    contains: () => false,
    getBoundingClientRect: () => ({ left: 400, top: 360, width: 200, height: 50 }),
  };

  global.window = {
    innerWidth: 1366,
    innerHeight: 768,
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1', cursor: 'pointer' }),
  };

  // Case 1: entire button is covered by an ad overlay with cursor:pointer -> must return null
  global.document = {
    querySelectorAll: () => [btn],
    elementFromPoint: () => adOverlay,
  };

  const fakeFrame = {
    evaluate: async (fn, arg) => fn(arg),
  };

  try {
    const blocked = await findClickableInstance(fakeFrame, '.myButton', 'generate link');
    assert.equal(blocked, null);

    // Case 2: only the exact center (500, 385) is covered by a small floating ad, left quarter (450, 385) is clear
    global.document.elementFromPoint = (x, y) => {
      if (Math.abs(x - 500) < 10 && Math.abs(y - 385) < 10) return adOverlay;
      return btn;
    };

    const clear = await findClickableInstance(fakeFrame, '.myButton', 'generate link');
    assert.deepEqual(clear, { index: 0, position: { x: 50, y: 25 } });
  } finally {
    delete global.window;
    delete global.document;
  }
});

test('sweepToExtreme steps incrementally (< viewport height) and stops mid-sweep when checkFn finds target', async () => {
  const wheelDeltas = [];
  let scrolled = 0;
  const fakePage = {
    viewportSize: () => ({ width: 1366, height: 768 }),
    mouse: {
      move: async () => {},
      wheel: async (_dx, dy) => {
        wheelDeltas.push(dy);
        scrolled += dy;
      },
    },
    evaluate: async () => `${scrolled}`,
    waitForTimeout: async () => {},
  };

  const found = await sweepToExtreme(fakePage, 'down', Date.now() + 5000, async () => {
    if (scrolled >= 900) {
      return { hasWb: false, targetIndex: 0, targetVisible: true };
    }
    return null;
  });

  assert.equal(found?.targetIndex, 0);
  assert.equal(found?.targetVisible, true);
  assert.deepEqual(wheelDeltas, [450, 450]);
});
