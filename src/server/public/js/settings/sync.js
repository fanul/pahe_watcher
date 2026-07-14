export function populateSyncSettings(form, cfg) {
  form.sync_backfillBatchSize.value = cfg.sync.backfillBatchSize;
  form.sync_backfillDirection.value = cfg.sync.backfillDirection;
  form.sync_backfillDeepSync.checked = cfg.sync.backfillDeepSync !== false;
  form.sync_backfillAutoRun.checked = cfg.sync.backfillAutoRun === true;
  form.sync_backfillIntervalSeconds.value = cfg.sync.backfillIntervalSeconds;
  form.sync_deepSyncSweepBatchSize.value = cfg.sync.deepSyncSweepBatchSize;
}

export function serializeSyncSettings(form) {
  return {
    backfillBatchSize: parseInt(form.sync_backfillBatchSize.value, 10) || 5,
    backfillDirection: form.sync_backfillDirection.value,
    backfillDeepSync: form.sync_backfillDeepSync.checked,
    backfillAutoRun: form.sync_backfillAutoRun.checked,
    backfillIntervalSeconds: parseInt(form.sync_backfillIntervalSeconds.value, 10) || 60,
    deepSyncSweepBatchSize: parseInt(form.sync_deepSyncSweepBatchSize.value, 10) || 20,
  };
}
