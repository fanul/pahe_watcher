import { EventEmitter } from 'node:events';

/**
 * Central event bus wiring the modules to the live GUI without tight coupling.
 *
 * Events:
 *   log            { ts, level, scope, msg, meta }
 *   post:new       PostEntry            — a new pahe.ink post detected
 *   job:created    Job
 *   job:updated    Job                  — status/progress change
 *   job:log        { jobId, ts, msg }   — per-job progress line
 *   captcha:needed { jobId, url, kind } — manual captcha intervention required
 *   sheet:appended { jobId, row }
 *   watcher:tick   { at, checked, found }
 */
class Bus extends EventEmitter {}

export const bus = new Bus();
bus.setMaxListeners(100);

export default bus;
