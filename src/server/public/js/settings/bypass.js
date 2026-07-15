import { splitList } from '../utils.js';

export function populateBypassSettings(form, cfg) {
  form.browserMode.value = cfg.bypass.browserMode;
  form.cdpEnabled.checked = cfg.bypass.cdpEnabled === true;
  form.cdpUrl.value = cfg.bypass.cdpUrl || '';
  form.initialPageDelaySeconds.value = cfg.bypass.initialPageDelaySeconds || 1.5;
  form.speedUpExclusions.value = (cfg.bypass.speedUpExclusions || []).join(', ');
  form.tabPruningWhitelist.value = (cfg.bypass.tabPruningWhitelist || []).join(', ');
  form.pruneAdTabs.checked = cfg.bypass.pruneAdTabs === true;
  form.injectOuoScript.checked = cfg.bypass.injectOuoScript !== false;
  form.speedUpPahe.checked = cfg.bypass.speedUpPahe !== false;
  form.removeOuoAds.checked = cfg.bypass.removeOuoAds !== false;

  const stealth = cfg.bypass.stealth || {};
  form.stealth_disableAutomationFlag.checked = stealth.disableAutomationFlag !== false;
  form.stealth_useStealthUserAgent.checked = stealth.useStealthUserAgent !== false;
  form.stealth_maskWebdriver.checked = stealth.maskWebdriver !== false;
  form.stealth_blockAdsAndTrackers.checked = stealth.blockAdsAndTrackers !== false;
  form.stealth_spoofCanvasFingerprint.checked = stealth.spoofCanvasFingerprint === true;
  form.stealth_useNoSandbox.checked = stealth.useNoSandbox !== false;
}

export function serializeBypassSettings(form) {
  return {
    browserMode: form.browserMode.value,
    cdpEnabled: form.cdpEnabled.checked,
    cdpUrl: form.cdpUrl.value.trim(),
    initialPageDelaySeconds: parseFloat(form.initialPageDelaySeconds.value) || 1.5,
    speedUpExclusions: splitList(form.speedUpExclusions.value),
    tabPruningWhitelist: splitList(form.tabPruningWhitelist.value),
    pruneAdTabs: form.pruneAdTabs.checked,
    injectOuoScript: form.injectOuoScript.checked,
    speedUpPahe: form.speedUpPahe.checked,
    removeOuoAds: form.removeOuoAds.checked,
    stealth: {
      disableAutomationFlag: form.stealth_disableAutomationFlag.checked,
      useStealthUserAgent: form.stealth_useStealthUserAgent.checked,
      maskWebdriver: form.stealth_maskWebdriver.checked,
      blockAdsAndTrackers: form.stealth_blockAdsAndTrackers.checked,
      spoofCanvasFingerprint: form.stealth_spoofCanvasFingerprint.checked,
      useNoSandbox: form.stealth_useNoSandbox.checked,
    }
  };
}
