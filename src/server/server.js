import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import { createLogger } from '../core/logger.js';
import { bus } from '../core/eventBus.js';
import { createApiRouter } from './routes/api.js';

const log = createLogger('server');
const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
