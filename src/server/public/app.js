// pahe-watcher dashboard client. Refactored into clean ES modules.
import { $, api, state, esc } from './js/state.js';
import { upsert } from './js/utils.js';
import { renderStatus } from './js/status.js';
import { loadPosts, renderPosts, notePostInserted } from './js/posts.js';
import { loadJobs, renderJobs, noteJobInserted, noteJobsRemoved, resetJobsCleared } from './js/jobs.js';
import { initCrawl, updateCrawlProgress } from './js/crawl.js';
import { initSettings } from './js/settings.js';
import { initCaptcha, showCaptcha } from './js/captcha.js';
import { initManualJob } from './js/manual.js';

// ws authentication token
const token = new URLSearchParams(location.search).get('token') || '';

// ── data loading ──
// Full resync: status + first page of posts/jobs. Reserved for infrequent,
// deliberate actions (boot, settings saved, manual job added, bulk queue
// actions) — NOT the periodic timer or frequent per-item clicks, which rely
// on WebSocket push updates instead so a large synced catalog never forces a
// full-list refetch just to reflect one small change.
async function refreshAll() {
  const [status] = await Promise.all([
    api('/status'),
    loadPosts(state, { reset: true }),
    loadJobs(state, { reset: true }),
  ]);
  renderStatus(status, state);
}

async function refreshStatusOnly() {
  const status = await api('/status');
  renderStatus(status, state);
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
    case 'post:new': {
      const inserted = upsert(state.posts, payload, (p) => p.id);
      if (inserted) notePostInserted();
      renderPosts(state);
      refreshStatusSoon();
      break;
    }
    case 'job:created':
    case 'job:updated': {
      const inserted = upsert(state.jobs, payload, (j) => j.id);
      if (inserted) noteJobInserted();
      renderJobs(state);
      refreshStatusSoon();
      break;
    }
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
      noteJobsRemoved(1);
      renderJobs(state);
      refreshStatusSoon();
      break;
    case 'jobs:cleared':
      resetJobsCleared(state);
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
// These are infrequent, deliberate actions — a full resync is fine and safest.
$('#btnPoll').onclick = () => api('/watcher/poll', { method: 'POST' }).then(refreshAll);
$('#btnWatcher').onclick = () =>
  api('/watcher/pause', { method: 'POST', body: JSON.stringify({ paused: !state.status.watcher.paused }) }).then(refreshStatusOnly);
$('#btnQueue').onclick = () =>
  api('/queue/pause', { method: 'POST', body: JSON.stringify({ paused: !state.status.queue.paused }) }).then(refreshStatusOnly);

document.body.addEventListener('click', async (e) => {
  const t = e.target;
  // Frequent per-item actions: fire the request and let the resulting
  // job:created/job:updated/job:deleted WS event update the UI — no full
  // list refetch per click.
  if (t.dataset.resolvePost) { await api(`/posts/${t.dataset.resolvePost}/resolve`, { method: 'POST', body: '{}' }); }
  if (t.dataset.retry) { await api(`/jobs/${t.dataset.retry}/retry`, { method: 'POST' }); }
  if (t.dataset.cancel) { await api(`/jobs/${t.dataset.cancel}/cancel`, { method: 'POST' }); }
  if (t.dataset.deleteJob) { await api(`/jobs/${t.dataset.deleteJob}`, { method: 'DELETE' }); }
  if (t.dataset.post != null && t.dataset.idx != null) {
    const post = state.posts.find((p) => String(p.id) === t.dataset.post);
    const opt = post?.options?.[+t.dataset.idx];
    if (opt) { await api('/jobs', { method: 'POST', body: JSON.stringify({ url: opt.url, provider: opt.provider, quality: opt.quality, title: post.title, postLink: post.link }) }); }
  }
  if (t.classList.contains('btn-open-selected-gd')) {
    const select = t.previousElementSibling;
    if (select && select.value) {
      window.open(select.value, '_blank');
    }
  }
  if (t.id === 'btnLoadMorePosts') { loadPosts(state, { reset: false }); }
  if (t.id === 'btnLoadMoreJobs') { loadJobs(state, { reset: false }); }
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
    loadJobs(state, { reset: true });
  }
};
$('#btnClearAllJobs').onclick = async () => {
  if (confirm('Are you sure you want to delete all jobs from the queue?')) {
    await api('/queue/clear', { method: 'POST' });
    loadJobs(state, { reset: true });
  }
};

// ── filters (server-side now — debounce so typing doesn't hammer the API) ──
let filterDebounce = null;
function refilterPostsSoon(delay = 300) {
  clearTimeout(filterDebounce);
  filterDebounce = setTimeout(() => loadPosts(state, { reset: true }), delay);
}
['#filterType', '#filterProvider', '#filterResolution', '#filterCodec'].forEach((sel) => {
  $(sel)?.addEventListener('change', () => refilterPostsSoon(0));
});
$('#filterSearch')?.addEventListener('input', () => refilterPostsSoon(300));

// ── log widget toggle ──
const logWidget = $('#logWidget');
const btnToggleLogWidget = $('#btnToggleLogWidget');
const logWidgetHeader = $('#logWidgetHeader');

if (logWidget && logWidgetHeader && btnToggleLogWidget) {
  const toggle = () => {
    const isMin = logWidget.classList.contains('minimized');
    if (isMin) {
      logWidget.classList.remove('minimized');
      btnToggleLogWidget.textContent = '▼';
    } else {
      logWidget.classList.add('minimized');
      btnToggleLogWidget.textContent = '▲';
    }
  };
  logWidgetHeader.onclick = toggle;
}

// ── boot ──
initCrawl(refreshAll);
initSettings(refreshAll);
initCaptcha();
initManualJob(refreshAll);

refreshAll().catch((e) => appendLog({ ts: '', level: 'error', scope: 'ui', msg: String(e) }));
connectWs();
// Periodic refresh is now status-only (cheap) — posts/jobs stay in sync via
// WebSocket pushes instead of a full-list refetch every 15s.
setInterval(() => refreshStatusOnly().catch(() => {}), 15000);
