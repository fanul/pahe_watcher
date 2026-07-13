import { $, api } from './state.js';
import { splitList } from './utils.js';

export function initSettings(refreshAll) {
  const providerSelect = $('#captchaProviderSelect');
  const updateGroupVisibility = () => {
    const val = providerSelect.value;
    $('#cfg2Captcha').classList.toggle('hidden', val !== '2captcha');
    $('#cfgFlareSolverr').classList.toggle('hidden', val !== 'flaresolverr');
    $('#cfgByParr').classList.toggle('hidden', val !== 'byparr');
  };
  providerSelect.addEventListener('change', updateGroupVisibility);

  $('#btnSettings').onclick = async () => {
    const cfg = await api('/config');
    const f = $('#settingsForm');
    f.preferredProviders.value = cfg.watcher.preferredProviders.join(',');
    f.preferredQualities.value = cfg.watcher.preferredQualities.join(',');
    f.preferredCodecs.value = (cfg.watcher.preferredCodecs || []).join(',');
    f.preferredSeriesType.value = cfg.watcher.preferredSeriesType || 'batch';
    f.pollIntervalSeconds.value = cfg.watcher.pollIntervalSeconds;
    f.autoResolve.checked = cfg.watcher.autoResolve;
    f.onlyCompleteSeries.checked = cfg.watcher.onlyCompleteSeries !== false;
    f.browserMode.value = cfg.bypass.browserMode;
    f.initialPageDelaySeconds.value = cfg.bypass.initialPageDelaySeconds || 1.5;
    f.speedUpExclusions.value = (cfg.bypass.speedUpExclusions || []).join(', ');
    f.tabPruningWhitelist.value = (cfg.bypass.tabPruningWhitelist || []).join(', ');
    f.pruneAdTabs.checked = cfg.bypass.pruneAdTabs === true;
    f.injectOuoScript.checked = cfg.bypass.injectOuoScript !== false;

    const stealth = cfg.bypass.stealth || {};
    f.stealth_disableAutomationFlag.checked = stealth.disableAutomationFlag !== false;
    f.stealth_useStealthUserAgent.checked = stealth.useStealthUserAgent !== false;
    f.stealth_maskWebdriver.checked = stealth.maskWebdriver !== false;
    f.stealth_blockAdsAndTrackers.checked = stealth.blockAdsAndTrackers !== false;
    f.stealth_spoofCanvasFingerprint.checked = stealth.spoofCanvasFingerprint === true;
    f.stealth_useNoSandbox.checked = stealth.useNoSandbox !== false;
    
    f.sheetId.value = cfg.sheets.sheetId || '';
    f.serviceAccountKeyContent.value = cfg.sheets.serviceAccountKeyContent || '';
    
    f.captchaProvider.value = cfg.bypass.captchaProvider || 'none';
    f.twoCaptchaApiKey.value = cfg.bypass.twoCaptchaApiKey || '';
    f.flaresolverrUrl.value = cfg.bypass.flaresolverrUrl || '';
    f.byparrUrl.value = cfg.bypass.byparrUrl || '';
    f.startServicesOnStart.checked = cfg.bypass.startServicesOnStart !== false;
    
    f.gdflixEmail.value = cfg.bypass.gdflixEmail || '';
    f.gdflixPassword.value = cfg.bypass.gdflixPassword || '';
    f.gdflixCookies.value = cfg.bypass.gdflixCookies || '';
    
    updateGroupVisibility();
    
    $('#sheetInfo').textContent = cfg.sheets.configured ? `${cfg.sheets.sheetId} / ${cfg.sheets.tab}` : 'not configured';
    $('#settingsDialog').showModal();
  };

  $('#settingsForm').addEventListener('submit', async (e) => {
    if (e.submitter?.value !== 'save') return;
    const f = e.target;
    const patch = {
      watcher: {
        preferredProviders: splitList(f.preferredProviders.value),
        preferredQualities: splitList(f.preferredQualities.value),
        preferredCodecs: splitList(f.preferredCodecs.value),
        preferredSeriesType: f.preferredSeriesType.value,
        onlyCompleteSeries: f.onlyCompleteSeries.checked,
        pollIntervalSeconds: +f.pollIntervalSeconds.value || 300,
        autoResolve: f.autoResolve.checked,
      },
      bypass: {
        browserMode: f.browserMode.value,
        initialPageDelaySeconds: parseFloat(f.initialPageDelaySeconds.value) || 1.5,
        speedUpExclusions: splitList(f.speedUpExclusions.value),
        tabPruningWhitelist: splitList(f.tabPruningWhitelist.value),
        pruneAdTabs: f.pruneAdTabs.checked,
        injectOuoScript: f.injectOuoScript.checked,
        stealth: {
          disableAutomationFlag: f.stealth_disableAutomationFlag.checked,
          useStealthUserAgent: f.stealth_useStealthUserAgent.checked,
          maskWebdriver: f.stealth_maskWebdriver.checked,
          blockAdsAndTrackers: f.stealth_blockAdsAndTrackers.checked,
          spoofCanvasFingerprint: f.stealth_spoofCanvasFingerprint.checked,
          useNoSandbox: f.stealth_useNoSandbox.checked,
        },
        captcha: {
          provider: f.captchaProvider.value,
          twoCaptchaApiKey: f.twoCaptchaApiKey.value,
          flaresolverrUrl: f.flaresolverrUrl.value,
          byparrUrl: f.byparrUrl.value,
          startServicesOnStart: f.startServicesOnStart.checked,
        },
        gdflix: {
          email: f.gdflixEmail.value,
          password: f.gdflixPassword.value,
          cookies: f.gdflixCookies.value,
        }
      },
      sheets: {
        sheetId: f.sheetId.value,
        serviceAccountKeyContent: f.serviceAccountKeyContent.value,
      }
    };
    await api('/config', { method: 'PATCH', body: JSON.stringify(patch) });
    refreshAll();
  });
}
