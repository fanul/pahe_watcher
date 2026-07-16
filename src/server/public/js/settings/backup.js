import { $, token, authHeaders } from '../state.js';

/** Wires the Backup & Restore fieldset's Export/Import buttons in the Settings dialog. */
export function initBackupSettings() {
  const btnExport = $('#btnExportBackup');
  const btnImport = $('#btnImportBackup');
  const fileInput = $('#inputImportBackup');
  const status = $('#backupStatus');

  btnExport?.addEventListener('click', () => {
    const qs = token ? `?token=${encodeURIComponent(token)}` : '';
    window.location.href = `/api/backup/export${qs}`;
  });

  btnImport?.addEventListener('click', () => fileInput?.click());

  fileInput?.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file) return;

    const proceed = window.confirm(
      'This replaces the ENTIRE database and settings with the contents of this backup, then restarts the server. This cannot be undone. Continue?',
    );
    if (!proceed) return;

    if (status) status.textContent = 'Uploading…';
    try {
      const qs = token ? `?token=${encodeURIComponent(token)}` : '';
      const res = await fetch(`/api/backup/import${qs}`, {
        method: 'POST',
        headers: { ...authHeaders },
        body: file,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

      if (status) status.textContent = 'Restored. Server is restarting…';
      waitForRestart();
    } catch (err) {
      if (status) status.textContent = `Import failed: ${err.message}`;
    }
  });
}

/** Polls /api/status until the (restarted) server responds again, then reloads the page. */
function waitForRestart() {
  const qs = token ? `?token=${encodeURIComponent(token)}` : '';
  let attempts = 0;
  const poll = setInterval(async () => {
    attempts += 1;
    try {
      const res = await fetch(`/api/status${qs}`, { headers: { ...authHeaders } });
      if (res.ok) {
        clearInterval(poll);
        window.location.reload();
      }
    } catch {
      // server still down between the shutdown and the restart — keep polling
    }
    if (attempts > 120) clearInterval(poll); // ~2 minutes, give up quietly
  }, 1000);
}
