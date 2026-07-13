import fs from 'node:fs';
import path from 'node:path';

export function getPublicSheetsConfig(runtime, sheets) {
  let serviceAccountKeyContent = '';
  try {
    if (fs.existsSync(runtime.sheets.serviceAccountKey)) {
      serviceAccountKeyContent = fs.readFileSync(runtime.sheets.serviceAccountKey, 'utf8');
    }
  } catch {}

  return {
    sheetId: runtime.sheets.sheetId,
    tab: runtime.sheets.tab,
    configured: sheets.enabled,
    serviceAccountKey: runtime.sheets.serviceAccountKey,
    serviceAccountKeyContent,
  };
}

export function applySheetsOverrides(runtime, patch) {
  if (patch.sheets) Object.assign(runtime.sheets, patch.sheets);
}

export function mergeSheetsOverrides(existing, patch) {
  return { ...(existing.sheets || {}), ...(patch.sheets || {}) };
}

export function handleSheetsKeyFile(runtime, patch, log) {
  if (patch?.sheets && patch.sheets.serviceAccountKeyContent !== undefined) {
    const keyContent = patch.sheets.serviceAccountKeyContent;
    const keyPath = runtime.sheets.serviceAccountKey;
    if (keyContent) {
      try {
        fs.mkdirSync(path.dirname(keyPath), { recursive: true });
        fs.writeFileSync(keyPath, keyContent, 'utf8');
        log.info(`Wrote Google Sheets Service Account Key to ${keyPath}`);
      } catch (err) {
        log.error(`Failed to write Service Account Key to ${keyPath}`, { error: err.message });
      }
    } else {
      try {
        if (fs.existsSync(keyPath)) {
          fs.unlinkSync(keyPath);
          log.info(`Deleted Google Sheets Service Account Key file ${keyPath}`);
        }
      } catch (err) {
        log.error(`Failed to delete Service Account Key file ${keyPath}`, { error: err.message });
      }
    }
    delete patch.sheets.serviceAccountKeyContent;
  }
}
