export function populateCaptchaSettings(form, cfg) {
  form.captchaProvider.value = cfg.bypass.captchaProvider || 'none';
  form.twoCaptchaApiKey.value = cfg.bypass.twoCaptchaApiKey || '';
  form.flaresolverrUrl.value = cfg.bypass.flaresolverrUrl || '';
  form.byparrUrl.value = cfg.bypass.byparrUrl || '';
  form.startServicesOnStart.checked = cfg.bypass.startServicesOnStart !== false;
  updateGroupVisibility(form);
}

export function serializeCaptchaSettings(form) {
  return {
    provider: form.captchaProvider.value,
    twoCaptchaApiKey: form.twoCaptchaApiKey.value,
    flaresolverrUrl: form.flaresolverrUrl.value,
    byparrUrl: form.byparrUrl.value,
    startServicesOnStart: form.startServicesOnStart.checked,
  };
}

export function updateGroupVisibility(form) {
  const val = form.captchaProvider.value;
  document.querySelector('#cfg2Captcha').classList.toggle('hidden', val !== '2captcha');
  document.querySelector('#cfgFlareSolverr').classList.toggle('hidden', val !== 'flaresolverr');
  document.querySelector('#cfgByParr').classList.toggle('hidden', val !== 'byparr');
}
