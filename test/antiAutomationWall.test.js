import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAntiAutomationWallPage } from '../src/bypass/antiAutomationWall.js';

test('isAntiAutomationWallPage matches the intercelestial.com/teknoasian.com "LL" ad-gate wall phrasing', () => {
  const shouldMatch = [
    'Ad blocker or auto-click script detected',
    "Ads on this site are blocked, or a script is pressing the buttons for you, so the link can't be unlocked. Disable your ad blocker and any userscript (Tampermonkey, Violentmonkey) for this site, then tap the button.",
    'Please turn off the auto-click script',
    'A script is clicking for you',
    'A userscript or browser extension is pressing the buttons on this page for you, so the link cannot be delivered.',
    'A userscript is controlling this page',
    'Tampermonkey (or a similar userscript extension) is running a script that presses the buttons for you, skips the countdown and hides the ads on this page.',
    'Switch it off for this site, then open your download link again from the main page to continue.',
  ];
  for (const text of shouldMatch) {
    assert.equal(isAntiAutomationWallPage(text), true, `expected "${text}" to be detected as the anti-automation wall`);
  }
});

test('isAntiAutomationWallPage does not false-positive on ordinary page text', () => {
  const shouldNotMatch = [
    'Please verify that you are human',
    'Click To Verify',
    'Your download will begin shortly.',
    '',
    null,
    undefined,
  ];
  for (const text of shouldNotMatch) {
    assert.equal(isAntiAutomationWallPage(text), false, `expected "${text}" to NOT be detected as the wall`);
  }
});
