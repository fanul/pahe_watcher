// settings.js handles loading and saving settings by orchestrating sub-modules.
import { $, api } from './state.js';
import { populateWatcherSettings, serializeWatcherSettings } from './settings/watcher.js';
import { populateBypassSettings, serializeBypassSettings } from './settings/bypass.js';
import { populateSheetsSettings, serializeSheetsSettings } from './settings/sheets.js';
import { populateJdownloaderSettings, serializeJdownloaderSettings } from './settings/jdownloader.js';
import { populateCaptchaSettings, serializeCaptchaSettings, updateGroupVisibility } from './settings/captcha.js';
import { populateGdflixSettings, serializeGdflixSettings, initGdflixSettings } from './settings/gdflix.js';
import { populateGoogleSettings, serializeGoogleSettings } from './settings/google.js';
import { populateSyncSettings, serializeSyncSettings } from './settings/sync.js';
import { populateDeadLinkReportSettings, serializeDeadLinkReportSettings } from './settings/deadLinkReport.js';
import { initBackupSettings } from './settings/backup.js';
import { populateDriveBackupSettings, serializeDriveBackupSettings, initDriveBackupSettings, refreshDriveBackupList } from './settings/driveBackup.js';

export function applyLayoutMode() {
  const mode = localStorage.getItem('layoutMode') || 'stay-on-top';
  if (mode === 'stay-on-top') {
    document.body.classList.add('layout-stay-on-top');
  } else {
    document.body.classList.remove('layout-stay-on-top');
  }
}

/**
 * Opens a real login page in the watcher's own persistent browser profile
 * (the same one every job runs through) instead of asking the operator to
 * export/paste cookies. Confirmed live that pasted Google cookies routinely
 * fail even when fresh — Google's SIDCC cookie family binds a session to
 * the network it was issued from, so a cookie transplanted from a
 * different machine gets silently rejected. Logging in right here sidesteps
 * that: the session becomes native to this machine, and the resolvers'
 * existing "already logged in" fast path picks it up automatically.
 */
async function openLoginHelper(url) {
  try {
    await api('/browser/open-login', { method: 'POST', body: JSON.stringify({ url }) });
    alert('Jendela browser sudah dibuka — selesaikan login di situ. Sesinya otomatis tersimpan, tidak perlu paste cookie lagi.');
  } catch (err) {
    alert(`Gagal membuka halaman login: ${err.message}`);
  }
}

export function initSettings(refreshAll) {
  const providerSelect = $('#captchaProviderSelect');
  const f = $('#settingsForm');

  providerSelect.addEventListener('change', () => updateGroupVisibility(f));
  initGdflixSettings(f);
  initBackupSettings();
  initDriveBackupSettings(f);

  const btnGoogleLogin = $('#btnOpenGoogleLogin');
  if (btnGoogleLogin) btnGoogleLogin.onclick = () => openLoginHelper('https://accounts.google.com/signin');

  const btnGdflixLogin = $('#btnOpenGdflixLogin');
  if (btnGdflixLogin) btnGdflixLogin.onclick = () => openLoginHelper('https://new4.gdflix.io/login');

  const btnTestJdownloader = $('#btnTestJdownloader');
  if (btnTestJdownloader) {
    btnTestJdownloader.onclick = async () => {
      const result = await api('/jdownloader/test');
      if (result.ok) {
        alert(`Terhubung! Device: ${(result.devices || []).join(', ') || '(tidak ada device)'}`);
      } else {
        alert(`Gagal terhubung: ${result.reason}`);
      }
    };
  }

  $('#btnSettings').onclick = async () => {
    const cfg = await api('/config');

    // Populate form fields from configuration categories
    populateWatcherSettings(f, cfg);
    populateBypassSettings(f, cfg);
    populateSheetsSettings(f, cfg);
    populateJdownloaderSettings(f, cfg);
    populateDriveBackupSettings(f, cfg);
    refreshDriveBackupList();
    populateCaptchaSettings(f, cfg);
    populateGdflixSettings(f, cfg);
    populateGoogleSettings(f, cfg);
    populateSyncSettings(f, cfg);
    populateDeadLinkReportSettings(f, cfg);

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
      jdownloader: serializeJdownloaderSettings(f),
      driveBackup: serializeDriveBackupSettings(f),
      sync: serializeSyncSettings(f),
      deadLinkReport: serializeDeadLinkReportSettings(f)
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
