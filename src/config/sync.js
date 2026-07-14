export function getPublicSyncConfig(runtime) {
  return {
    backfillBatchSize: runtime.sync.backfillBatchSize,
    backfillDirection: runtime.sync.backfillDirection,
    backfillDeepSync: runtime.sync.backfillDeepSync,
    backfillAutoRun: runtime.sync.backfillAutoRun,
    backfillIntervalSeconds: runtime.sync.backfillIntervalSeconds,
    deepSyncSweepBatchSize: runtime.sync.deepSyncSweepBatchSize,
    metadataBackfillSweepBatchSize: runtime.sync.metadataBackfillSweepBatchSize,
  };
}

export function applySyncOverrides(runtime, patch) {
  if (patch.sync) Object.assign(runtime.sync, patch.sync);
}

export function mergeSyncOverrides(existing, patch) {
  return { ...(existing.sync || {}), ...(patch.sync || {}) };
}
