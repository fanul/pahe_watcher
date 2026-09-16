import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import { createLogger } from '../core/logger.js';
import { bus } from '../core/eventBus.js';
import { createApiRouter } from './routes/api.js';
import { buildRedirectUri } from '../drive/driveBackupClient.js';

const log = createLogger('server');
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/**
 * HTTP + WebSocket server. Serves the static GUI, mounts the REST API, and
 * broadcasts every bus event over WS so the dashboard updates live.
 */
export function createServer(app) {
  const { runtime } = app;
  const expressApp = express();
  expressApp.use(express.json({ limit: '1mb' }));

  // Optional shared-secret auth for API + WS.
  const token = runtime.server.guiToken;
  if (token) {
    expressApp.use('/api', (req, res, next) => {
      const provided = req.get('x-gui-token') || req.query.token;
      if (provided !== token) return res.status(401).json({ error: 'unauthorized' });
      next();
    });
  }

  // Deliberately outside /api — this is Google redirecting the user's own
  // browser back here as a plain top-level navigation, not a fetch() call,
  // so it never carries the x-gui-token header the /api guard requires.
  // Safe to leave unauthenticated: the `code` param is single-use and
  // short-lived, and useless without this server's own OAuth client secret.
  expressApp.get('/oauth/drive/callback', async (req, res) => {
    const { code, error } = req.query;
    if (error) {
      return res.status(400).send(`<html><body style="font-family:sans-serif;padding:40px">Authorization failed: ${escapeHtml(error)}. You can close this tab.</body></html>`);
    }
    if (!code) {
      return res.status(400).send('Missing code');
    }
    try {
      const redirectUri = buildRedirectUri(req);
      const refreshToken = await app.driveBackup.completeAuth(code, redirectUri);
      await app.updateConfig({ driveBackup: { oauthRefreshToken: refreshToken } });
      res.send('<html><body style="font-family:sans-serif;padding:40px"><h2>✅ Google Drive connected</h2><p>You can close this tab and go back to pahe-watcher.</p></body></html>');
    } catch (err) {
      log.error('Drive OAuth callback failed', { error: String(err) });
      res.status(500).send(`<html><body style="font-family:sans-serif;padding:40px">Failed to complete authorization: ${escapeHtml(err.message)}</body></html>`);
    }
  });

  expressApp.use('/api', createApiRouter(app));
  expressApp.use(express.static(path.join(__dirname, 'public')));

  const server = http.createServer(expressApp);

  // ── WebSocket live feed ──
  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (ws, req) => {
    if (token) {
      const url = new URL(req.url, 'http://x');
      if (url.searchParams.get('token') !== token) {
        ws.close(1008, 'unauthorized');
        return;
      }
    }
    ws.send(JSON.stringify({ type: 'hello', at: new Date().toISOString() }));
  });

  const broadcast = (type, payload) => {
    const msg = JSON.stringify({ type, payload, at: new Date().toISOString() });
    for (const client of wss.clients) {
      if (client.readyState === 1) client.send(msg);
    }
  };

  // Fan out the events the GUI cares about.
  for (const ev of ['log', 'post:new', 'job:created', 'job:updated', 'job:log', 'captcha:needed', 'sheet:appended', 'watcher:tick', 'crawl:progress', 'job:deleted', 'jobs:cleared']) {
    bus.on(ev, (payload) => broadcast(ev, payload));
  }

  const listen = () =>
    new Promise((resolve) => {
      server.listen(runtime.server.port, runtime.server.host, () => {
        log.info(`Web GUI on http://${runtime.server.host}:${runtime.server.port}`);
        resolve(server);
      });
    });

  return { server, wss, listen, broadcast };
}

export default createServer;
