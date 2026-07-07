import { bus } from './eventBus.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
let threshold = LEVELS.info;

export function setLevel(level) {
  threshold = LEVELS[level] ?? LEVELS.info;
}

function emit(level, scope, msg, meta) {
  if (LEVELS[level] < threshold) return;
  const rec = {
    ts: new Date().toISOString(),
    level,
    scope,
    msg,
    ...(meta ? { meta } : {}),
  };
  const line = `${rec.ts} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}`;
  const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  sink(line, meta && Object.keys(meta).length ? meta : '');
  // Fan out to the GUI live-log stream.
  bus.emit('log', rec);
}

/** Create a namespaced logger, e.g. createLogger('watcher'). */
export function createLogger(scope) {
  return {
    debug: (msg, meta) => emit('debug', scope, msg, meta),
    info: (msg, meta) => emit('info', scope, msg, meta),
    warn: (msg, meta) => emit('warn', scope, msg, meta),
    error: (msg, meta) => emit('error', scope, msg, meta),
    child: (sub) => createLogger(`${scope}:${sub}`),
  };
}

export default createLogger;
