export function populateGdflixSettings(form, cfg) {
  form.gdflixEmail.value = cfg.bypass.gdflixEmail || '';
  form.gdflixPassword.value = cfg.bypass.gdflixPassword || '';
  form.gdflixCookies.value = cfg.bypass.gdflixCookies || '';
}

export function serializeGdflixSettings(form) {
  return {
    email: form.gdflixEmail.value,
    password: form.gdflixPassword.value,
    cookies: form.gdflixCookies.value,
  };
}
