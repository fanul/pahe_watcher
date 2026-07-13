import { $, api, state } from './state.js';

export function initCaptcha() {
  $('#btnCaptchaSolved').onclick = async () => {
    if (state.currentCaptcha) {
      await api(`/captcha/${state.currentCaptcha.requestId}/solved`, { method: 'POST' });
    }
    $('#captchaBanner').classList.add('hidden');
    state.currentCaptcha = null;
  };
}

export function showCaptcha(payload) {
  state.currentCaptcha = payload;
  $('#captchaLink').href = payload.url || '#';
  $('#captchaBanner').classList.remove('hidden');
}
