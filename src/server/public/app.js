// pahe-watcher dashboard client. Refactored into clean ES modules.
import { $, api, state, esc } from './js/state.js';
import { upsert } from './js/utils.js';
import { renderStatus } from './js/status.js';
import { renderPosts } from './js/posts.js';
import { renderJobs } from './js/jobs.js';
import { initCrawl, updateCrawlProgress } from './js/crawl.js';
import { initSettings } from './js/settings.js';
import { initCaptcha, showCaptcha } from './js/captcha.js';
import { initManualJob } from './js/manual.js';

// ws authentication token
const token = new URLSearchParams(location.search).get('token') || '';

// ── data loading ──
async function refreshAll() {
  const [status, posts, jobs] = await Promise.all([api('/status'), api('/posts'), api('/jobs')]);
  renderStatus(status, state);
  state.posts = posts; renderPosts(state);
  state.jobs = jobs; renderJobs(state);
}

// ── live log via WebSocket ──
function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws${token ? `?token=${token}` : ''}`);
  ws.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    handleEvent(m.type, m.payload);
  };
  ws.onclose = () => setTimeout(connectWs, 2000);
}

let logBuffer = [];
function handleEvent(type, payload) {
  switch (type) {
    case 'log': appendLog(payload); break;
    case 'post:new':
      upsert(state.posts, payload, (p) => p.id); renderPosts(state); refreshStatusSoon(); break;
    case 'job:created':
    case 'job:updated':
      upsert(state.jobs, payload, (j) => j.id); renderJobs(state); refreshStatusSoon(); break;
    case 'job:log': {
      const j = state.jobs.find((x) => x.id === payload.jobId);
      if (j) { j.logs = [...(j.logs || []), payload].slice(-200); renderJobs(state); }
      break;
    }
    case 'captcha:needed': showCaptcha(payload); break;
    case 'watcher:tick': refreshStatusSoon(); break;
    case 'sheet:appended': refreshStatusSoon(); break;
    case 'crawl:progress': updateCrawlProgress(payload); break;
    case 'job:deleted':
      state.jobs = state.jobs.filter((j) => j.id !== payload);
      renderJobs(state);
      refreshStatusSoon();
      break;
    case 'jobs:cleared':
      state.jobs = [];
      renderJobs(state);
      refreshStatusSoon();
      break;
  }
}

function appendLog(rec) {
  logBuffer.push(rec); logBuffer = logBuffer.slice(-400);
  const box = $('#log');
  const near = box.scrollTop + box.clientHeight >= box.scrollHeight - 40;
  const el = document.createElement('div');
  el.className = 'logline';
  el.innerHTML = `<span class="lvl ${rec.level}">${rec.level.toUpperCase()}</span> ` +
    `<span class="scope">[${esc(rec.scope)}]</span> ${esc(rec.msg)}`;
  box.appendChild(el);
  while (box.childNodes.length > 400) box.removeChild(box.firstChild);
  if (near) box.scrollTop = box.scrollHeight;
}

let statusTimer = null;
function refreshStatusSoon() {
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => api('/status').then(s => renderStatus(s, state)).catch(() => {}), 400);
}

// ── controls ──
$('#btnPoll').onclick = () => api('/watcher/poll', { method: 'POST' }).then(refreshAll);
$('#btnWatcher').onclick = () =>
  api('/watcher/pause', { method: 'POST', body: JSON.stringify({ paused: !state.status.watcher.paused }) }).then(refreshAll);
$('#btnQueue').onclick = () =>
  api('/queue/pause', { method: 'POST', body: JSON.stringify({ paused: !state.status.queue.paused }) }).then(refreshAll);

document.body.addEventListener('click', async (e) => {
  const t = e.target;
  if (t.dataset.resolvePost) { await api(`/posts/${t.dataset.resolvePost}/resolve`, { method: 'POST', body: '{}' }); refreshAll(); }
  if (t.dataset.retry) { await api(`/jobs/${t.dataset.retry}/retry`, { method: 'POST' }); refreshAll(); }
  if (t.dataset.cancel) { await api(`/jobs/${t.dataset.cancel}/cancel`, { method: 'POST' }); refreshAll(); }
  if (t.dataset.deleteJob) { await api(`/jobs/${t.dataset.deleteJob}`, { method: 'DELETE' }); refreshAll(); }
  if (t.dataset.post != null && t.dataset.idx != null) {
    const post = state.posts.find((p) => String(p.id) === t.dataset.post);
    const opt = post?.options?.[+t.dataset.idx];
    if (opt) { await api('/jobs', { method: 'POST', body: JSON.stringify({ url: opt.url, provider: opt.provider, quality: opt.quality, title: post.title, postLink: post.link }) }); refreshAll(); }
  }
});

// ── tabs navigation ──
const tabNewPosts = $('#tabNewPosts');
const tabCrawl = $('#tabCrawl');
const panelNewPosts = $('#panelNewPosts');
const panelCrawl = $('#panelCrawl');

tabNewPosts.onclick = () => {
  tabNewPosts.classList.add('active');
  tabCrawl.classList.remove('active');
  panelNewPosts.classList.remove('hidden');
  panelCrawl.classList.add('hidden');
};

tabCrawl.onclick = () => {
  tabCrawl.classList.add('active');
  tabNewPosts.classList.remove('active');
  panelCrawl.classList.remove('hidden');
  panelNewPosts.classList.add('hidden');
};

// ── bulk queue actions ──
$('#btnRetryAllJobs').onclick = async () => {
  if (confirm('Are you sure you want to retry all failed/cancelled jobs?')) {
    await api('/queue/retry', { method: 'POST' });
    refreshAll();
  }
};
$('#btnClearAllJobs').onclick = async () => {
  if (confirm('Are you sure you want to delete all jobs from the queue?')) {
    await api('/queue/clear', { method: 'POST' });
    refreshAll();
  }
};

// ── boot ──
initCrawl(refreshAll);
initSettings(refreshAll);
initCaptcha();
initManualJob(refreshAll);

refreshAll().catch((e) => appendLog({ ts: '', level: 'error', scope: 'ui', msg: String(e) }));
connectWs();
setInterval(() => refreshAll().catch(() => {}), 15000);
