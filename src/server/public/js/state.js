export const state = {
  posts: [],
  jobs: [],
  status: null,
  currentCaptcha: null
};

export const $ = (sel) => document.querySelector(sel);
export const token = new URLSearchParams(location.search).get('token') || '';
export const authHeaders = token ? { 'x-gui-token': token } : {};

export async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...authHeaders, ...(opts.headers || {}) },
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.status === 204 ? null : res.json();
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
