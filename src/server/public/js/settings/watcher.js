import { splitList } from '../utils.js';

export function populateWatcherSettings(form, cfg) {
  form.preferredProviders.value = cfg.watcher.preferredProviders.join(',');
  form.preferredQualities.value = cfg.watcher.preferredQualities.join(',');
  form.preferredCodecs.value = (cfg.watcher.preferredCodecs || []).join(',');
  form.preferredSeriesType.value = cfg.watcher.preferredSeriesType || 'batch';
  form.pollIntervalSeconds.value = cfg.watcher.pollIntervalSeconds;
  form.autoResolve.checked = cfg.watcher.autoResolve;
  form.onlyCompleteSeries.checked = cfg.watcher.onlyCompleteSeries !== false;
}

export function serializeWatcherSettings(form) {
  return {
    preferredProviders: splitList(form.preferredProviders.value),
    preferredQualities: splitList(form.preferredQualities.value),
    preferredCodecs: splitList(form.preferredCodecs.value),
    preferredSeriesType: form.preferredSeriesType.value,
    onlyCompleteSeries: form.onlyCompleteSeries.checked,
    pollIntervalSeconds: +form.pollIntervalSeconds.value || 300,
    autoResolve: form.autoResolve.checked,
  };
}
