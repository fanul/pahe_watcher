// settings.js handles loading and saving settings by orchestrating sub-modules.
import { $, api } from './state.js';
import { populateWatcherSettings, serializeWatcherSettings } from './settings/watcher.js';
import { populateBypassSettings, serializeBypassSettings } from './settings/bypass.js';
import { populateSheetsSettings, serializeSheetsSettings } from './settings/sheets.js';
import { populateCaptchaSettings, serializeCaptchaSettings, updateGroupVisibility } from './settings/captcha.js';
import { populateGdflixSettings, serializeGdflixSettings, initGdflixSettings } from './settings/gdflix.js';
import { populateGoogleSettings, serializeGoogleSettings } from './settings/google.js';
import { populateSyncSettings, serializeSyncSettings } from './settings/sync.js';

export function applyLayoutMode() {
  const mode = localStorage.getItem('layoutMode') || 'stay-on-top';
  if (mode === 'stay-on-top') {
    document.body.classList.add('layout-stay-on-top');
  } else {
    document.body.classList.remove('layout-stay-on-top');
  }
}

export function initSettings(refreshAll) {
  const providerSelect = $('#captchaProviderSelect');
  const f = $('#settingsForm');

  providerSelect.addEventListener('change', () => updateGroupVisibility(f));
  initGdflixSettings(f);

  $('#btnSettings').onclick = async () => {
    const cfg = await api('/config');
    
    // Populate form fields from configuration categories
    populateWatcherSettings(f, cfg);
    populateBypassSettings(f, cfg);
    populateSheetsSettings(f, cfg);
    populateCaptchaSettings(f, cfg);
    populateGdflixSettings(f, cfg);
    populateGoogleSettings(f, cfg);
    populateSyncSettings(f, cfg);

    // Populate layout mode
    const layoutMode = localStorage.getItem('layoutMode') || 'stay-on-top';
    const layoutSelect = f.querySelector('[name="layoutStickyMode"]');
    if (layoutSelect) {
      layoutSelect.value = layoutMode;
    }

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
        gdflix: serializeGdflixSettings(f),
        google: serializeGoogleSettings(f)
      },
      sheets: serializeSheetsSettings(f),
      sync: serializeSyncSettings(f)
    };

    // Save layout mode
    const layoutSelect = f.querySelector('[name="layoutStickyMode"]');
    if (layoutSelect) {
      localStorage.setItem('layoutMode', layoutSelect.value);
      applyLayoutMode();
    }

    await api('/config', { method: 'PATCH', body: JSON.stringify(patch) });
    refreshAll();
  });
}
