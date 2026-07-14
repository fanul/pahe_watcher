import { createLogger } from '../core/logger.js';
import { PaheClient } from './paheClient.js';
import { SyncEngine } from './syncEngine.js';

const log = createLogger('watcher');

/**
 * Thin façade over SyncEngine: owns the poll-interval timer and the
 * running/paused guard, and delegates the actual sync work (live poll,
 * historical backfill, deep-sync sweep) to SyncEngine. See
 * src/watcher/syncEngine.js and ARCHITECTURE.md.
 */
export class Watcher {
  constructor({ config, store, queue }) {
    this.config = config;
    this.store = store;
    this.queue = queue;
    this.client = new PaheClient(config.watcher.baseUrl);
    this.syncEngine = new SyncEngine({ config, store, client: this.client, queue });
    this.timer = null;
    this.backfillTimer = null;
    this.running = false;
    this.paused = false;
  }

  start() {
    if (this.timer) return;
    const ms = Math.max(15, this.config.watcher.pollIntervalSeconds) * 1000;
    log.info(`Watcher started (interval ${this.config.watcher.pollIntervalSeconds}s)`);
    // fire immediately, then on the interval
    this.poll().catch((e) => log.error('Initial poll failed', { error: String(e) }));
    this.timer = setInterval(() => {
      this.poll().catch((e) => log.error('Poll failed', { error: String(e) }));
    }, ms);
    this._armBackfillAutoRun();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this._disarmBackfillAutoRun();
    log.info('Watcher stopped');
  }

  /** (Re)arm or tear down the optional periodic backfill timer per current config. Safe to call anytime. */
  _armBackfillAutoRun() {
    this._disarmBackfillAutoRun();
    if (!this.config.sync?.backfillAutoRun) return;
    const ms = Math.max(15, this.config.sync.backfillIntervalSeconds || 60) * 1000;
    log.info(`Backfill auto-run armed (interval ${ms / 1000}s)`);
    this.backfillTimer = setInterval(() => {
      const cursor = this.getBackfillStatus();
      if (cursor.status === 'paused') return;
      this.runBackfill().catch((e) => log.error('Auto-run backfill failed', { error: String(e) }));
    }, ms);
  }

  _disarmBackfillAutoRun() {
    if (this.backfillTimer) clearInterval(this.backfillTimer);
    this.backfillTimer = null;
  }

  setPaused(paused) {
    this.paused = paused;
    log.info(`Watcher ${paused ? 'paused' : 'resumed'}`);
  }

  /** One live-polling cycle. Safe to call manually (GUI "Check now"). */
  async poll() {
    if (this.running) {
      log.debug('Poll already in progress, skipping');
      return { skipped: true };
    }
    if (this.paused) {
      log.debug('Watcher paused, skipping poll');
      return { paused: true };
    }
    this.running = true;
    try {
      return await this.syncEngine.runLivePoll();
    } catch (err) {
      log.error('Poll error', { error: String(err) });
      throw err;
    } finally {
      this.running = false;
    }
  }

  /** Process up to `batchSize` pages of the resumable historical backfill. */
  runBackfill(opts) {
    return this.syncEngine.runBackfillBatch(opts);
  }

  /** Deep-sync (fetch + parse content) whichever posts are still shallow. */
  runDeepSyncSweep(opts) {
    return this.syncEngine.sweepDeepSync(opts);
  }

  /** Backfill year/genre/duration/director/creator/actors onto posts synced under an older parser. */
  runMetadataBackfillSweep(opts) {
    return this.syncEngine.sweepMetadataBackfill(opts);
  }

  /** Explicit control over the backfill cursor (page/direction). */
  resetBackfill(opts) {
    return this.syncEngine.resetBackfillCursor(opts);
  }

  setBackfillPaused(paused) {
    return this.syncEngine.setBackfillPaused(paused);
  }

  getBackfillStatus() {
    return this.syncEngine.getBackfillCursor();
  }
}

export default Watcher;
