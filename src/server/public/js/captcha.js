import { $, api, state } from './state.js';

export function initCaptcha() {
  const btn = $('#btnCaptchaSolved');
  if (btn) {
    btn.onclick = async () => {
      if (state.currentCaptcha) {
        await api(`/captcha/${state.currentCaptcha.requestId}/solved`, { method: 'POST' }).catch(() => {});
      }
      $('#captchaBanner')?.classList.add('hidden');
      state.currentCaptcha = null;
    };
  }
}

export function showCaptcha(payload) {
  state.currentCaptcha = payload;
  const link = $('#captchaLink');
  if (link) {
    link.href = payload.url || '#';
  }
  $('#captchaBanner')?.classList.remove('hidden');
}
