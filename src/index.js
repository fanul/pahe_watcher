#!/usr/bin/env node
import { createApp } from './app.js';
import { createServer } from './server/server.js';
import { createLogger } from './core/logger.js';
import { startServices, stopServices } from './core/serviceManager.js';

const log = createLogger('main');

/**
 * Entry point. Flags:
 *   (default)      start watcher + web GUI
 *   --server-only  start web GUI without the auto watcher loop
 *   --once         run a single poll cycle and exit (cron/CI use)
 *   --no-server    run watcher only, no GUI
 */
async function main() {
  const args = new Set(process.argv.slice(2));
  const app = await createApp();

  // Start FlareSolverr and ByParr if enabled
  await startServices(app.runtime);

  if (args.has('--once')) {
    log.info('Running single poll cycle (--once)');
    const result = await app.watcher.poll();
    log.info('Poll result', result);
    // give queued jobs a chance to run to completion
    await waitForQueueDrain(app, 10 * 60 * 1000);
    await app.shutdown();
    await stopServices();
    process.exit(0);
  }

  if (!args.has('--no-server')) {
    const { listen } = createServer(app);
    await listen();
  }

  if (!args.has('--server-only')) {
    app.watcher.start();
  } else {
    log.info('Server-only mode: watcher not auto-started (use the GUI "Check now" or enable via API)');
  }

  const shutdown = async () => {
    await app.shutdown();
    await stopServices();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

function waitForQueueDrain(app, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const check = () => {
      const s = app.queue.stats();
      if (s.queued === 0 && s.running === 0) return resolve();
      if (Date.now() > deadline) return resolve();
      setTimeout(check, 2000);
    };
    check();
  });
}

main().catch((err) => {
  log.error('Fatal', { error: String(err.stack || err) });
  process.exit(1);
});
