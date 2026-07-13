// settings.js handles loading and saving settings by orchestrating sub-modules.
import { $, api } from './state.js';
import { populateWatcherSettings, serializeWatcherSettings } from './settings/watcher.js';
import { populateBypassSettings, serializeBypassSettings } from './settings/bypass.js';
import { populateSheetsSettings, serializeSheetsSettings } from './settings/sheets.js';
import { populateCaptchaSettings, serializeCaptchaSettings, updateGroupVisibility } from './settings/captcha.js';
import { populateGdflixSettings, serializeGdflixSettings } from './settings/gdflix.js';

export function initSettings(refreshAll) {
  const providerSelect = $('#captchaProviderSelect');
  const f = $('#settingsForm');

  providerSelect.addEventListener('change', () => updateGroupVisibility(f));

  $('#btnSettings').onclick = async () => {
    const cfg = await api('/config');
    
    // Populate form fields from configuration categories
    populateWatcherSettings(f, cfg);
    populateBypassSettings(f, cfg);
    populateSheetsSettings(f, cfg);
    populateCaptchaSettings(f, cfg);
    populateGdflixSettings(f, cfg);

    $('#sheetInfo').textContent = cfg.sheets.configured ? `${cfg.sheets.sheetId} / ${cfg.sheets.tab}` : 'not configured';
    $('#settingsDialog').showModal();
  };

  f.addEventListener('submit', async (e) => {
    if (e.submitter?.value !== 'save') return;
    
    // Construct config override patch payload
    const patch = {
      watcher: serializeWatcherSettings(f),
      bypass: {
        ...serializeBypassSettings(f),
        captcha: serializeCaptchaSettings(f),
        gdflix: serializeGdflixSettings(f)
      },
      sheets: serializeSheetsSettings(f)
    };

    await api('/config', { method: 'PATCH', body: JSON.stringify(patch) });
    refreshAll();
  });
}
