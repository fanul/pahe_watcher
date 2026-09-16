export function getPublicJdownloaderConfig(runtime, jdownloader) {
  return {
    email: runtime.jdownloader.email,
    password: runtime.jdownloader.password,
    deviceName: runtime.jdownloader.deviceName,
    autostart: runtime.jdownloader.autostart,
    downloadFolder: runtime.jdownloader.downloadFolder,
    configured: jdownloader.enabled,
  };
}

export function applyJdownloaderOverrides(runtime, patch) {
  if (patch.jdownloader) Object.assign(runtime.jdownloader, patch.jdownloader);
}

export function mergeJdownloaderOverrides(existing, patch) {
  return { ...(existing.jdownloader || {}), ...(patch.jdownloader || {}) };
}
