export function populateJdownloaderSettings(form, cfg) {
  form.jdownloaderEmail.value = cfg.jdownloader.email || '';
  form.jdownloaderPassword.value = cfg.jdownloader.password || '';
  form.jdownloaderDeviceName.value = cfg.jdownloader.deviceName || '';
  form.jdownloaderAutostart.checked = cfg.jdownloader.autostart !== false;
}

export function serializeJdownloaderSettings(form) {
  return {
    email: form.jdownloaderEmail.value,
    password: form.jdownloaderPassword.value,
    deviceName: form.jdownloaderDeviceName.value,
    autostart: form.jdownloaderAutostart.checked,
  };
}
