export function populateSheetsSettings(form, cfg) {
  form.sheetId.value = cfg.sheets.sheetId || '';
  form.serviceAccountKeyContent.value = cfg.sheets.serviceAccountKeyContent || '';
}

export function serializeSheetsSettings(form) {
  return {
    sheetId: form.sheetId.value,
    serviceAccountKeyContent: form.serviceAccountKeyContent.value,
  };
}
