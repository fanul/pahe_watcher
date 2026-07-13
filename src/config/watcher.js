export function getPublicWatcherConfig(runtime) {
  return {
    pollIntervalSeconds: runtime.watcher.pollIntervalSeconds,
    perPage: runtime.watcher.perPage,
    preferredProviders: runtime.watcher.preferredProviders,
    preferredQualities: runtime.watcher.preferredQualities,
    preferredCodecs: runtime.watcher.preferredCodecs,
    preferredSeriesType: runtime.watcher.preferredSeriesType,
    onlyCompleteSeries: runtime.watcher.onlyCompleteSeries,
    autoResolve: runtime.watcher.autoResolve,
  };
}

export function applyWatcherOverrides(runtime, patch) {
  if (patch.watcher) Object.assign(runtime.watcher, patch.watcher);
}

export function mergeWatcherOverrides(existing, patch) {
  return { ...(existing.watcher || {}), ...(patch.watcher || {}) };
}
