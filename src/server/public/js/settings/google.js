// Google Drive cookie settings. Unlike GDFlix, Google doesn't operate
// interchangeable mirror domains, so this is a single cookie field (no
// per-domain manager needed) — just JSON-array export or a semicolon string.

export function populateGoogleSettings(form, cfg) {
  form.googleCookies.value = cfg.bypass.googleCookies || '';
}

export function serializeGoogleSettings(form) {
  return {
    cookies: form.googleCookies.value,
  };
}
