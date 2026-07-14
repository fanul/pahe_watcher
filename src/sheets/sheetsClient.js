import fs from 'node:fs';
import { google } from 'googleapis';
import { createLogger } from '../core/logger.js';
import { bus } from '../core/eventBus.js';

const log = createLogger('sheets');

const HEADER = [
  'Resolved At',
  'Title',
  'Provider',
  'Quality',
  'Size',
  'Final Link',
  'Link Type',
  'Post URL',
  'Source (entry) URL',
];

/**
 * Google Sheets sink. Uses a service account key (share the sheet with the
 * service-account email as Editor). Appends one row per resolved download.
 */
export class SheetsClient {
  constructor({ keyFile, sheetId, tab }) {
    this.keyFile = keyFile;
    this.sheetId = sheetId;
    this.tab = tab || 'Downloads';
    this.sheets = null;
    this._headerEnsured = false;
  }

  get enabled() {
    return Boolean(this.sheetId && this.keyFile && fs.existsSync(this.keyFile));
  }

  async _client() {
    if (this.sheets) return this.sheets;
    if (!this.enabled) {
      throw new Error(
        'Sheets not configured: set GOOGLE_SHEET_ID and provide a valid GOOGLE_SERVICE_ACCOUNT_KEY file',
      );
    }
    const auth = new google.auth.GoogleAuth({
      keyFile: this.keyFile,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    const authClient = await auth.getClient();
    this.sheets = google.sheets({ version: 'v4', auth: authClient });
    return this.sheets;
  }

  async _ensureHeader() {
    if (this._headerEnsured) return;
    const sheets = await this._client();
    const range = `${this.tab}!A1:I1`;
    try {
      const res = await sheets.spreadsheets.values.get({ spreadsheetId: this.sheetId, range });
      const row = res.data.values?.[0];
      if (!row || row.length === 0) {
        await sheets.spreadsheets.values.update({
          spreadsheetId: this.sheetId,
          range,
          valueInputOption: 'RAW',
          requestBody: { values: [HEADER] },
        });
        log.info('Wrote header row to sheet');
      }
    } catch (err) {
      // If the sheet tab does not exist, Google API throws a 400 error containing "Unable to parse range"
      const isRangeError = err.message && (
        err.message.includes('Unable to parse range') || 
        err.message.includes('parse range')
      );
      if (isRangeError) {
        log.info(`Sheet tab "${this.tab}" not found, creating it...`);
        try {
          await sheets.spreadsheets.batchUpdate({
            spreadsheetId: this.sheetId,
            requestBody: {
              requests: [
                {
                  addSheet: {
                    properties: {
                      title: this.tab,
                    },
                  },
                },
              ],
            },
          });
          // Now write the header
          await sheets.spreadsheets.values.update({
            spreadsheetId: this.sheetId,
            range,
            valueInputOption: 'RAW',
            requestBody: { values: [HEADER] },
          });
          log.info(`Created sheet tab "${this.tab}" and wrote header row`);
        } catch (createErr) {
          log.error('Failed to automatically create sheet tab', { error: String(createErr) });
          throw err; // throw original range error if we failed to create
        }
      } else {
        throw err;
      }
    }
    this._headerEnsured = true;
  }

  /**
   * Append one resolved download to the sheet.
   * @param {object} row
   */
  async appendResolved(row) {
    await this._ensureHeader();
    const sheets = await this._client();
    const values = [[
      row.resolvedAt || new Date().toISOString(),
      row.title || '',
      row.provider || '',
      row.quality || '',
      row.sizeLabel || '',
      row.finalUrl || '',
      row.linkType || '',
      row.postLink || '',
      row.sourceUrl || '',
    ]];
    await sheets.spreadsheets.values.append({
      spreadsheetId: this.sheetId,
      range: `${this.tab}!A:I`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values },
    });
    bus.emit('sheet:appended', { row });
    log.info('Appended row to sheet', { title: row.title, provider: row.provider });
  }

  /** Lightweight connectivity check for the GUI status panel. */
  async testConnection() {
    if (!this.enabled) return { ok: false, reason: 'not-configured' };
    try {
      const sheets = await this._client();
      const res = await sheets.spreadsheets.get({ spreadsheetId: this.sheetId, fields: 'properties.title' });
      return { ok: true, title: res.data.properties?.title };
    } catch (err) {
      return { ok: false, reason: String(err.message || err) };
    }
  }
}

export default SheetsClient;
