export function populateSheetsSettings(form, cfg) {
  form.sheetId.value = cfg.sheets.sheetId || '';
  form.serviceAccountKeyContent.value = '';
  form.serviceAccountKeyContent.placeholder = cfg.sheets.hasKey
    ? `Key on file (${cfg.sheets.clientEmail || 'configured'}) — paste new JSON to replace`
    : '{ "type": "service_account", ... }';
  const status = document.getElementById('sheetsKeyJsonStatus');
  if (status) status.textContent = '';
}

export function serializeSheetsSettings(form) {
  const patch = { sheetId: form.sheetId.value };
  if (form.serviceAccountKeyContent.value) {
    patch.serviceAccountKeyContent = form.serviceAccountKeyContent.value;
  }
  return patch;
}

export function initSheetsSettings(form) {
  const btnUpload = document.getElementById('btnUploadSheetsKeyJson');
  const fileInput = document.getElementById('inputSheetsServiceAccountJson');
  const status = document.getElementById('sheetsKeyJsonStatus');

  if (!btnUpload || !fileInput) return;

  btnUpload.addEventListener('click', () => {
    fileInput.value = '';
    fileInput.click();
  });

  fileInput.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      if (parsed.type !== 'service_account' && !parsed.client_email) {
        if (status) status.innerHTML = '<span style="color: var(--danger, #f85149);">⚠ Bukan file Service Account JSON yang valid.</span>';
        return;
      }
      form.serviceAccountKeyContent.value = text;
      if (status) status.innerHTML = `<span style="color: #3fb950;">✅ Terbaca: ${parsed.client_email}</span>`;
    } catch (err) {
      if (status) status.innerHTML = `<span style="color: var(--danger, #f85149);">❌ File JSON tidak valid: ${err.message}</span>`;
    }
  });
}
