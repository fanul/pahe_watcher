import { createRequire } from 'node:module';
import { createLogger } from '../core/logger.js';

const log = createLogger('jdownloader');

// myjdownloader's published ESM build (dist/index.js) re-exports via
// `export { default } from './JDownloader'` with no file extension, which
// Node's strict ESM resolver rejects (confirmed live: `import JDownloader
// from 'myjdownloader'` throws ERR_MODULE_NOT_FOUND under "type": "module").
// Its CJS build doesn't have this problem — extensionless requires resolve
// fine there — so pull that in via createRequire instead of a normal import.
const require = createRequire(import.meta.url);
const JDownloader = require('myjdownloader').default;

/**
 * My.JDownloader sink. Pushes a resolved download link straight into the
 * configured device's linkgrabber so it starts downloading automatically —
 * no manual paste into JDownloader needed.
 *
 * Uses the `myjdownloader` npm package (2 small, focused deps: aes-js +
 * pkcs7-padding) rather than the older `jdownloader-api` package, which
 * pulls in the deprecated `request`/`request-promise` chain carrying 2
 * critical SSRF/form-data vulnerabilities — confirmed via `npm audit`
 * before choosing this one; installing it introduced zero new advisories
 * against this project's existing baseline.
 */
export class JDownloaderClient {
  constructor({ email, password, deviceName, autostart = true }) {
    this.email = email;
    this.password = password;
    this.deviceName = deviceName;
    this.autostart = autostart;
    this._client = null;
    this._deviceId = null;
  }

  get enabled() {
    return Boolean(this.email && this.password);
  }

  async _connect() {
    if (this._client) return this._client;
    if (!this.enabled) {
      throw new Error('JDownloader not configured: set JDOWNLOADER_EMAIL and JDOWNLOADER_PASSWORD');
    }
    const client = new JDownloader(this.email, this.password);
    await client.connect();
    this._client = client;
    return client;
  }

  async _resolveDeviceId() {
    if (this._deviceId) return this._deviceId;
    const client = await this._connect();
    const raw = await client.listDevices();
    const devices = Array.isArray(raw) ? raw : raw?.list || [];
    if (devices.length === 0) {
      throw new Error('No JDownloader devices found on this My.JDownloader account');
    }
    // Case-insensitive — confirmed live the device name as typed into
    // Settings ("JDOWNLOADER@DOCKER") didn't match My.JDownloader's actual
    // casing ("JDownloader@Docker"), a friction point with no security
    // reason to be strict about.
    const device = this.deviceName
      ? devices.find((d) => d.name?.toLowerCase() === this.deviceName.toLowerCase())
      : devices[0];
    if (!device) {
      throw new Error(
        `JDownloader device "${this.deviceName}" not found. Available: ${devices.map((d) => d.name).join(', ')}`,
      );
    }
    this._deviceId = device.id;
    return this._deviceId;
  }

  /** Push a single resolved link into JDownloader's linkgrabber. */
  async addLink(url, { packageName } = {}) {
    const client = await this._connect();
    const deviceId = await this._resolveDeviceId();
    await client.linkgrabberV2.addLinks(deviceId, [url], {
      autostart: this.autostart,
      packageName,
    });
    log.info('Pushed link to JDownloader', { url, packageName });
  }

  /**
   * Current status of every package in the device's download list (moved
   * there automatically once autostart picks a crawled link up) — used to
   * track a pushed job's real download progress, not just whether the push
   * itself succeeded. `saveTo` is JDownloader's actual on-disk destination
   * path for that package, when the API is willing to report it.
   */
  async listDownloadPackages() {
    const client = await this._connect();
    const deviceId = await this._resolveDeviceId();
    return client.downloadsV2.queryPackages(deviceId, undefined, {
      name: true,
      status: true,
      bytesLoaded: true,
      bytesTotal: true,
      saveTo: true,
      finished: true,
      running: true,
      enabled: true,
    });
  }

  /** Lightweight connectivity check for the GUI status panel. */
  async testConnection() {
    if (!this.enabled) return { ok: false, reason: 'not-configured' };
    try {
      const client = await this._connect();
      const raw = await client.listDevices();
      const devices = Array.isArray(raw) ? raw : raw?.list || [];
      const deviceNames = devices.map((d) => d.name);
      const matches = !this.deviceName || deviceNames.some((n) => n?.toLowerCase() === this.deviceName.toLowerCase());
      if (!matches) {
        return { ok: false, reason: `Device "${this.deviceName}" not found. Available: ${deviceNames.join(', ')}` };
      }
      return { ok: true, devices: deviceNames };
    } catch (err) {
      return { ok: false, reason: String(err.message || err) };
    }
  }

  async close() {
    if (this._client) {
      await this._client.disconnect().catch(() => {});
      this._client = null;
      this._deviceId = null;
    }
  }
}

export default JDownloaderClient;
