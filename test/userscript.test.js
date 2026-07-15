import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getInjectedAutomationScript, AD_HOSTS, ADBLOCK_GATE_HOSTS } from '../src/bypass/userscript.js';

test('getInjectedAutomationScript produces syntactically valid JS (catches template-interpolation bugs)', () => {
  const script = getInjectedAutomationScript({ bypass: {} });
  assert.doesNotThrow(() => new Function(script), 'injected script must parse as valid JS');
});

test('ADBLOCK_GATE_HOSTS is a subset of AD_HOSTS — every host the click-automation targets is also treated as a known ad-chain host', () => {
  for (const host of ADBLOCK_GATE_HOSTS) {
    assert.ok(AD_HOSTS.includes(host), `${host} is in ADBLOCK_GATE_HOSTS but missing from AD_HOSTS`);
  }
});

test('the injected script exposes adblockGateHosts to fallback.js\'s closure and includes the lookalike domains', () => {
  const script = getInjectedAutomationScript({ bypass: {} });
  assert.ok(script.includes('const adblockGateHosts ='), 'adblockGateHosts must be declared in the injected script scope');
  for (const host of ['hosttbuzz.com', 'intercelestial.com', 'policiesreview.com', 'zpserver.com']) {
    assert.ok(script.includes(host), `expected ${host} to appear in the injected script`);
  }
});

test('linegee.net navigation waits 5000ms (not the old 200ms) to give the popup ad time to register before navigating', () => {
  const script = getInjectedAutomationScript({ bypass: {} });
  // The fallback rule's linegee.net branch: setTimeout(() => { window.location.href = ... }, 5000);
  assert.match(script, /window\.location\.href = window\.location\.href \+ atob\(b64\); \}, 5000\)/);
});
