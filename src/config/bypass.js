export function getPublicBypassConfig(runtime) {
  return {
    browserMode: runtime.bypass.browserMode,
    initialPageDelaySeconds: runtime.bypass.initialPageDelaySeconds,
    concurrency: runtime.bypass.concurrency,
    captchaProvider: runtime.bypass.captcha.provider,
    twoCaptchaApiKey: runtime.bypass.captcha.twoCaptchaApiKey,
    capSolverApiKey: runtime.bypass.captcha.capSolverApiKey,
    flaresolverrUrl: runtime.bypass.captcha.flaresolverrUrl,
    byparrUrl: runtime.bypass.captcha.byparrUrl,
    startServicesOnStart: runtime.bypass.captcha.startServicesOnStart,
    gdflixEmail: runtime.bypass.gdflix.email,
    gdflixPassword: runtime.bypass.gdflix.password,
    gdflixCookies: runtime.bypass.gdflix.cookies,
    googleCookies: runtime.bypass.google?.cookies || '',
    stealth: runtime.bypass.stealth,
    speedUpExclusions: runtime.bypass.speedUpExclusions,
    tabPruningWhitelist: runtime.bypass.tabPruningWhitelist,
    pruneAdTabs: runtime.bypass.pruneAdTabs,
    injectOuoScript: runtime.bypass.injectOuoScript,
    speedUpPahe: runtime.bypass.speedUpPahe,
    removeOuoAds: runtime.bypass.removeOuoAds,
  };
}

export function applyBypassOverrides(runtime, patch) {
  if (patch.bypass) {
    const { captcha, gdflix, google, ...rest } = patch.bypass;
    Object.assign(runtime.bypass, rest);
    if (captcha) Object.assign(runtime.bypass.captcha, captcha);
    if (gdflix) Object.assign(runtime.bypass.gdflix, gdflix);
    if (google) Object.assign(runtime.bypass.google, google);
  }
}

export function mergeBypassOverrides(existing, patch) {
  const existingBypass = existing.bypass || {};
  const patchBypass = patch.bypass || {};
  return {
    ...existingBypass,
    ...patchBypass,
    captcha: { ...(existingBypass.captcha || {}), ...(patchBypass.captcha || {}) },
    gdflix: { ...(existingBypass.gdflix || {}), ...(patchBypass.gdflix || {}) },
    google: { ...(existingBypass.google || {}), ...(patchBypass.google || {}) },
  };
}
