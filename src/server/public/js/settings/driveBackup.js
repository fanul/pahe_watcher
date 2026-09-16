import { $, api } from '../state.js';

export function populateDriveBackupSettings(form, cfg) {
  form.driveBackupFolderId.value = cfg.driveBackup?.folderId || '';
  form.driveBackupOauthClientId.value = cfg.driveBackup?.oauthClientId || '';
  form.driveBackupOauthClientSecret.value = cfg.driveBackup?.oauthClientSecret || '';

  const hint = document.getElementById('driveOauthRedirectHint');
  if (hint) hint.textContent = `${window.location.origin}/oauth/drive/callback`;

  const info = document.getElementById('driveBackupConnectedInfo');
  if (info) info.textContent = cfg.driveBackup?.connected ? '✅ connected' : 'not connected';
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
export function initDriveBackupSettings(form) {
  const btnConnect = $('#btnConnectDriveBackup');
  const btnTest = $('#btnTestDriveBackup');
  const btnUpload = $('#btnUploadDriveBackup');
  const btnRestore = $('#btnRestoreDriveBackup');
  const select = $('#driveBackupList');
  const status = $('#driveBackupStatus');

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

  btnUpload?.addEventListener('click', async () => {
    setStatus('Uploading…');
    try {
      const res = await api('/backup/drive/upload', { method: 'POST' });
      setStatus(`Uploaded: ${res.file.name}`);
      refreshDriveBackupList();
    } catch (err) {
      setStatus(`Upload failed: ${err.message}`);
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
