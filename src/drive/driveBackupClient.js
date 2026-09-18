import { Readable } from 'node:stream';
import { google } from 'googleapis';
import { createLogger } from '../core/logger.js';

const log = createLogger('driveBackup');

const BACKUP_MIME = 'application/zip';
const NAME_PREFIX = 'pahe-watcher-backup-';
export const DRIVE_OAUTH_SCOPES = ['https://www.googleapis.com/auth/drive'];

/**
 * The OAuth redirect URI must be byte-identical between the auth-url
 * request and the callback request (and must exactly match what's
 * registered in the Google Cloud OAuth client) — derived from the incoming
 * request's own host so it naturally matches however this app is actually
 * being reached (localhost, a LAN IP, a different port), instead of a
 * separately-configured value that could drift out of sync.
 */
export function buildRedirectUri(req) {
  return `${req.protocol}://${req.get('host')}/oauth/drive/callback`;
}

/**
 * Google Drive backup sink — OAuth2 with the operator's own Google account,
 * NOT a service account. Confirmed live: service accounts have no storage
 * quota of their own in a regular "My Drive" folder — files.create fails
 * with "Service Accounts do not have storage quota" even when the folder
 * is correctly shared with the service account as Editor. Shared Drives
 * (which give service accounts a quota-free place to write) are a paid
 * Google Workspace feature, not available on a plain @gmail.com account.
 * OAuth2 sidesteps this entirely: the backup files are created under the
 * authorizing user's own account and count against their own quota, same
 * as if they'd uploaded them by hand.
 *
 * See routes/api.js for the /backup/drive/oauth/url and .../callback
 * endpoints that drive the one-time consent flow this class's refreshToken
 * comes from.
 */
export class DriveBackupClient {
  constructor({ clientId, clientSecret, refreshToken, folderId, redirectUri }) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.refreshToken = refreshToken;
    this.folderId = folderId;
    this.redirectUri = redirectUri;
    this.drive = null;
  }

  get enabled() {
    return Boolean(this.clientId && this.clientSecret && this.refreshToken && this.folderId);
  }

  get authorized() {
    return Boolean(this.clientId && this.clientSecret && this.refreshToken);
  }

  _oauthClient(redirectUri) {
    return new google.auth.OAuth2(this.clientId, this.clientSecret, redirectUri || this.redirectUri);
  }

  /** Where to send the user to grant access. Requires clientId/clientSecret already saved. */
  buildAuthUrl(redirectUri) {
    if (!this.clientId || !this.clientSecret) {
      throw new Error('Set OAuth Client ID and Client Secret first (Settings → Backup & Restore).');
    }
    const client = this._oauthClient(redirectUri);
    return client.generateAuthUrl({
      access_type: 'offline', // required to get a refresh_token back at all
      prompt: 'consent', // forces a refresh_token every time, not just on first-ever grant
      scope: DRIVE_OAUTH_SCOPES,
    });
  }

  /** Exchanges a one-time auth code (from the callback) for a refresh token, and stores it on this instance. */
  async completeAuth(code, redirectUri) {
    const client = this._oauthClient(redirectUri);
    const { tokens } = await client.getToken(code);
    if (!tokens.refresh_token) {
      throw new Error(
        'Google did not return a refresh token. If you already authorized this app before, revoke access at ' +
          'https://myaccount.google.com/permissions and try again — Google only issues a refresh token on the ' +
          'first consent for a given client.',
      );
    }
    this.refreshToken = tokens.refresh_token;
    this.drive = null;
    return tokens.refresh_token;
  }

  async _client() {
    if (this.drive) return this.drive;
    if (!this.authorized) {
      throw new Error('Drive backup not authorized: connect a Google account (Settings → Backup & Restore).');
    }
    const client = this._oauthClient();
    client.setCredentials({ refresh_token: this.refreshToken });
    this.drive = google.drive({ version: 'v3', auth: client });
    return this.drive;
  }

  /** Upload a backup zip buffer as a new file in the configured folder. */
  async upload(buffer, filename) {
    if (!this.folderId) throw new Error('Set a Drive folder ID first (Settings → Backup & Restore).');
    const drive = await this._client();
    const name = filename || `${NAME_PREFIX}${new Date().toISOString().replace(/[:.]/g, '-')}.zip`;
    const res = await drive.files.create({
      requestBody: { name, parents: [this.folderId] },
      media: { mimeType: BACKUP_MIME, body: Readable.from(buffer) },
      fields: 'id, name, createdTime, size',
      supportsAllDrives: true,
    });
    log.info('Uploaded backup to Google Drive', { name, id: res.data.id });
    return res.data;
  }

  /** List backups in the configured folder, newest first. */
  async list() {
    if (!this.folderId) return [];
    const drive = await this._client();
    const res = await drive.files.list({
      q: `'${this.folderId}' in parents and trashed = false and name contains '${NAME_PREFIX}'`,
      orderBy: 'createdTime desc',
      fields: 'files(id, name, createdTime, size)',
      pageSize: 50,
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
    });
    return res.data.files || [];
  }

  /** Download a specific backup's raw zip bytes by Drive file ID. */
  async download(fileId) {
    const drive = await this._client();
    const res = await drive.files.get(
      { fileId, alt: 'media', supportsAllDrives: true },
      { responseType: 'arraybuffer' },
    );
    return Buffer.from(res.data);
  }

  /**
   * Find a file by its EXACT name in the configured folder (not the
   * NAME_PREFIX substring match `list()` uses for timestamped backups) —
   * used by the db-sync feature, which keeps one canonical, overwritten
   * file rather than accumulating a new one every run.
   */
  async findFile(name) {
    if (!this.folderId) return null;
    const drive = await this._client();
    const res = await drive.files.list({
      q: `'${this.folderId}' in parents and trashed = false and name = '${name.replace(/'/g, "\\'")}'`,
      orderBy: 'createdTime desc',
      fields: 'files(id, name, createdTime, size)',
      pageSize: 1,
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
    });
    return res.data.files?.[0] || null;
  }

  /** Downloads by exact filename; returns null (never throws) if no such file exists yet — the expected state before the very first sync. */
  async downloadByName(name) {
    const file = await this.findFile(name);
    if (!file) return null;
    return this.download(file.id);
  }

  /** Creates the named file if it doesn't exist yet, otherwise overwrites its content in place — keeps exactly one copy in Drive instead of a new file per sync. */
  async uploadOrReplace(buffer, name, mimeType = 'application/x-sqlite3') {
    if (!this.folderId) throw new Error('Set a Drive folder ID first (Settings → Backup & Restore).');
    const drive = await this._client();
    const existing = await this.findFile(name);
    if (existing) {
      const res = await drive.files.update({
        fileId: existing.id,
        media: { mimeType, body: Readable.from(buffer) },
        fields: 'id, name, modifiedTime, size',
        supportsAllDrives: true,
      });
      log.info('Replaced existing file on Google Drive', { name, id: res.data.id });
      return res.data;
    }
    const res = await drive.files.create({
      requestBody: { name, parents: [this.folderId] },
      media: { mimeType, body: Readable.from(buffer) },
      fields: 'id, name, createdTime, size',
      supportsAllDrives: true,
    });
    log.info('Uploaded new file to Google Drive', { name, id: res.data.id });
    return res.data;
  }

  /** Lightweight connectivity check for the GUI status panel. */
  async testConnection() {
    if (!this.authorized) return { ok: false, reason: 'not-authorized' };
    if (!this.folderId) return { ok: false, reason: 'no-folder-configured' };
    try {
      const drive = await this._client();
      const res = await drive.files.get({
        fileId: this.folderId,
        fields: 'id, name, mimeType',
        supportsAllDrives: true,
      });
      if (res.data.mimeType !== 'application/vnd.google-apps.folder') {
        return { ok: false, reason: `"${this.folderId}" is not a folder` };
      }
      return { ok: true, folderName: res.data.name };
    } catch (err) {
      return { ok: false, reason: String(err.message || err) };
    }
  }
}

export default DriveBackupClient;
