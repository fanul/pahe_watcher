import { $, api } from '../state.js';

export function populateDriveBackupSettings(form, cfg) {
  form.driveBackupFolderId.value = cfg.driveBackup?.folderId || '';
  form.driveBackupOauthClientId.value = cfg.driveBackup?.oauthClientId || '';
  form.driveBackupOauthClientSecret.value = cfg.driveBackup?.oauthClientSecret || '';

  const hint = document.getElementById('driveOauthRedirectHint');
  if (hint) hint.textContent = `${window.location.origin}/oauth/drive/callback`;

  const info = document.getElementById('driveBackupConnectedInfo');
  if (info) info.textContent = cfg.driveBackup?.connected ? '✅ connected' : 'not connected';

  const jsonStatus = document.getElementById('driveOauthJsonStatus');
  if (jsonStatus) jsonStatus.textContent = '';
}

export function parseAndApplyOauthJson(rawText, form) {
  const status = document.getElementById('driveOauthJsonStatus');
  try {
    const text = typeof rawText === 'string' ? rawText.trim() : JSON.stringify(rawText);
    if (!text) return false;
    const json = JSON.parse(text);
    const creds = json.web || json.installed || json;
    const clientId = creds.client_id || creds.clientId;
    const clientSecret = creds.client_secret || creds.clientSecret;

    if (!clientId || !clientSecret) {
      if (status) {
        status.innerHTML = '<span style="color: var(--danger, #f85149);">❌ File JSON tidak memiliki client_id atau client_secret yang valid.</span>';
      }
      return false;
    }

    form.driveBackupOauthClientId.value = clientId;
    form.driveBackupOauthClientSecret.value = clientSecret;

    // Check redirect URI against current host callback
    const redirectUris = creds.redirect_uris || creds.redirectUris || [];
    const currentOrigin = window.location.origin;
    const expectedCallback = `${currentOrigin}/oauth/drive/callback`;
    const hasExpectedCallback = redirectUris.some((uri) => uri === expectedCallback);

    if (redirectUris.length > 0 && !hasExpectedCallback) {
      if (status) {
        status.innerHTML = `<span style="color: #d29922;">⚠ Client ID & Secret terisi! Namun di Google Cloud Console belum ada Authorized Redirect URI: <code>${expectedCallback}</code></span>`;
      }
    } else {
      if (status) {
        status.innerHTML = `<span style="color: #3fb950;">✅ OAuth JSON valid: Client ID & Secret otomatis terisi!</span>`;
      }
    }
    return true;
  } catch (err) {
    if (status) {
      status.innerHTML = `<span style="color: var(--danger, #f85149);">❌ JSON tidak valid: ${err.message}</span>`;
    }
    return false;
  }
}

export function serializeDriveBackupSettings(form) {
  return {
    folderId: form.driveBackupFolderId.value,
    oauthClientId: form.driveBackupOauthClientId.value,
    oauthClientSecret: form.driveBackupOauthClientSecret.value,
  };
}

/** Refreshes the Drive backup dropdown — call whenever the Settings dialog opens, not just once at page load. */
export async function refreshDriveBackupList() {
  const select = $('#driveBackupList');
  const status = $('#driveBackupStatus');
  if (!select) return;
  select.innerHTML = '<option value="">Loading backups…</option>';
  try {
    const res = await api('/backup/drive/list');
    const files = res.files || [];
    if (files.length === 0) {
      select.innerHTML = '<option value="">(no backups on Drive yet)</option>';
      return;
    }
    select.innerHTML = files
      .map((f) => `<option value="${f.id}">${f.name} — ${new Date(f.createdTime).toLocaleString()}</option>`)
      .join('');
  } catch (err) {
    select.innerHTML = '<option value="">(failed to load)</option>';
    if (status) status.textContent = `List failed: ${err.message}`;
  }
}

/** Wires the Backup & Restore fieldset's Google Drive buttons. Called once at page init. */
export function initDriveBackupSettings(form, refreshAll) {
  const btnConnect = $('#btnConnectDriveBackup');
  const btnTest = $('#btnTestDriveBackup');
  const btnSync = $('#btnSyncDriveBackup');
  const btnUpload = $('#btnUploadDriveBackup');
  const btnRestore = $('#btnRestoreDriveBackup');
  const select = $('#driveBackupList');
  const status = $('#driveBackupStatus');

  const btnUploadOauth = $('#btnUploadDriveOauthJson');
  const fileInputOauth = $('#inputDriveOauthJson');
  const btnPasteOauth = $('#btnPasteDriveOauthJson');

  btnUploadOauth?.addEventListener('click', () => {
    if (fileInputOauth) {
      fileInputOauth.value = '';
      fileInputOauth.click();
    }
  });

  fileInputOauth?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      parseAndApplyOauthJson(text, form);
    } catch (err) {
      const jsonStatus = document.getElementById('driveOauthJsonStatus');
      if (jsonStatus) jsonStatus.innerHTML = `<span style="color: var(--danger, #f85149);">❌ Gagal membaca file: ${err.message}</span>`;
    }
  });

  btnPasteOauth?.addEventListener('click', async () => {
    try {
      let text = '';
      if (navigator.clipboard?.readText) {
        text = await navigator.clipboard.readText();
      }
      if (!text) {
        text = window.prompt('Paste isi file client_secret_*.json di sini:');
      }
      if (text) {
        parseAndApplyOauthJson(text, form);
      }
    } catch {
      const text = window.prompt('Paste isi file client_secret_*.json di sini:');
      if (text) parseAndApplyOauthJson(text, form);
    }
  });

  const setStatus = (msg) => { if (status) status.textContent = msg; };

  btnConnect?.addEventListener('click', async () => {
    setStatus('Saving Client ID/Secret…');
    try {
      // The Client ID/Secret just typed into the form haven't been saved
      // yet — Connect is a standalone button, not the form's Save submit —
      // so without this the backend would still be using whatever (possibly
      // blank) credentials it had before, and 400 on the very next call.
      await api('/config', { method: 'PATCH', body: JSON.stringify({ driveBackup: serializeDriveBackupSettings(form) }) });

      setStatus('Opening Google sign-in…');
      const res = await api('/backup/drive/oauth/url');
      // Opens in a new tab — the callback lands on this same server, but
      // the Settings dialog (and this in-progress form) shouldn't get
      // navigated away from.
      window.open(res.url, '_blank', 'noopener');
      setStatus('Finish signing in in the new tab, then reopen Settings to see "connected".');
    } catch (err) {
      setStatus(`Failed to start sign-in: ${err.message}`);
    }
  });

  btnTest?.addEventListener('click', async () => {
    setStatus('Testing…');
    const result = await api('/backup/drive/test');
    setStatus(result.ok ? `Connected — folder "${result.folderName}"` : `Failed: ${result.reason}`);
  });

  btnSync?.addEventListener('click', async () => {
    btnSync.disabled = true;
    const oldText = btnSync.textContent;
    btnSync.textContent = '⏳ Syncing…';
    setStatus('Syncing (mengunduh copy dari Drive, menggabungkan data, mengunggah kembali)…');
    try {
      const res = await api('/backup/drive/sync', { method: 'POST' });
      const { posts, postOptions, jobs } = res.pulled;
      setStatus(`✅ Synced — pulled ${posts} post(s) (+${postOptions} option row(s)) and ${jobs} job(s) from Drive; pushed the merged result back.`);
      if (refreshAll) refreshAll();
    } catch (err) {
      setStatus(`❌ Sync failed: ${err.message}`);
    } finally {
      btnSync.disabled = false;
      btnSync.textContent = oldText;
    }
  });

  btnUpload?.addEventListener('click', async () => {
    btnUpload.disabled = true;
    const oldText = btnUpload.textContent;
    btnUpload.textContent = '⏳ Uploading…';
    setStatus('Uploading…');
    try {
      const res = await api('/backup/drive/upload', { method: 'POST' });
      setStatus(`Uploaded: ${res.file.name}`);
      refreshDriveBackupList();
    } catch (err) {
      setStatus(`Upload failed: ${err.message}`);
    } finally {
      btnUpload.disabled = false;
      btnUpload.textContent = oldText;
    }
  });

  btnRestore?.addEventListener('click', async () => {
    const fileId = select?.value;
    if (!fileId) return setStatus('Pick a backup from the list first.');
    const proceed = window.confirm(
      'This replaces the ENTIRE database and settings with the selected Drive backup, then restarts the server. This cannot be undone. Continue?',
    );
    if (!proceed) return;

    setStatus('Restoring…');
    try {
      await api('/backup/drive/restore', { method: 'POST', body: JSON.stringify({ fileId }) });
      setStatus('Restored. Server is restarting…');
      waitForRestart();
    } catch (err) {
      setStatus(`Restore failed: ${err.message}`);
    }
  });
}

/** Polls /api/status until the (restarted) server responds again, then reloads the page. */
function waitForRestart() {
  let attempts = 0;
  const poll = setInterval(async () => {
    attempts += 1;
    try {
      await api('/status');
      clearInterval(poll);
      window.location.reload();
    } catch {
      // server still down between the shutdown and the restart — keep polling
    }
    if (attempts > 120) clearInterval(poll); // ~2 minutes, give up quietly
  }, 1000);
}
