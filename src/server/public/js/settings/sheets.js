export function populateSheetsSettings(form, cfg) {
  form.sheetId.value = cfg.sheets.sheetId || '';
  form.serviceAccountKeyContent.value = '';
  form.serviceAccountKeyContent.placeholder = cfg.sheets.hasKey
    ? `Key on file (${cfg.sheets.clientEmail || 'configured'}) — paste new JSON to replace`
    : '{ "type": "service_account", ... }';
}

export function serializeSheetsSettings(form) {
  const patch = { sheetId: form.sheetId.value };
  if (form.serviceAccountKeyContent.value) {
    patch.serviceAccountKeyContent = form.serviceAccountKeyContent.value;
  }
  return patch;
}
