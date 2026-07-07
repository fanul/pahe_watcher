// pahe-watcher dashboard client. Vanilla JS, no build step.

const $ = (sel) => document.querySelector(sel);
const token = new URLSearchParams(location.search).get('token') || '';
const authHeaders = token ? { 'x-gui-token': token } : {};

async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...authHeaders, ...(opts.headers || {}) },
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.status === 204 ? null : res.json();
}

const state = { posts: [], jobs: [], status: null };

// ── rendering ──
function renderStatus(s) {
  state.status = s;
  const w = s.watcher, q = s.queue;
  const pill = (cls, dot, label, val) =>
    `<span class="pill ${cls}"><span class="dot ${dot}"></span>${label}${val != null ? ` <b>${val}</b>` : ''}</span>`;
  $('#statusPills').innerHTML = [
    pill(w.paused ? 'warn' : 'ok', w.paused ? 'warn' : 'ok', 'Watcher', w.paused ? 'paused' : 'live'),
    pill('', '', 'Last poll', w.lastPollAt ? timeago(w.lastPollAt) : 'never'),
    pill(q.running ? 'ok' : '', q.running ? 'ok' : '', 'Queue', `${q.running}▶ ${q.queued}⏳`),
    pill('ok', 'ok', 'Done', q.done),
    pill(q.failed ? 'bad' : '', q.failed ? 'bad' : '', 'Failed', q.failed),
    pill(s.sheets.configured ? 'ok' : 'warn', s.sheets.configured ? 'ok' : 'warn', 'Sheets', s.sheets.configured ? 'on' : 'off'),
  ].join('');
  $('#btnWatcher').textContent = w.paused ? 'Resume watcher' : 'Pause watcher';
  $('#btnQueue').textContent = q.paused ? 'Resume queue' : 'Pause queue';
  $('#jobStats').textContent = `${q.total} total · ${q.done} done · ${q.failed} failed`;
}

function renderPosts() {
  $('#postCount').textContent = `(${state.posts.length})`;
  $('#posts').innerHTML = state.posts.map((p) => {
    const opts = p.options || [];
    const chips = opts.map((o, i) =>
      `<span class="chip ${o.provider === 'GD' ? 'gd' : ''}" data-post="${p.id}" data-idx="${i}"
        title="${o.qualityLabel || ''} ${o.sizeLabel || ''}">${o.provider} ${o.quality || ''}</span>`).join('');
    return `<div class="card">
      <div class="title">${esc(p.title)}</div>
      <div class="meta">${new Date(p.date).toLocaleString()} · ${opts.length} links ·
        <a href="${p.link}" target="_blank" rel="noopener">post ↗</a></div>
      <div class="chips">${chips || '<span class="muted">no links parsed</span>'}</div>
      <div class="actions"><button class="btn small" data-resolve-post="${p.id}">Resolve preferred</button></div>
    </div>`;
  }).join('') || '<div class="muted">No posts seen yet. Click “Check now”.</div>';
}

function renderJobs() {
  const jobs = state.jobs.slice(0, 60);
  $('#jobs').innerHTML = jobs.map((j) => {
    const logs = (j.logs || []).slice(-6).map((l) => `${l.msg}`).join('\n');
    const final = j.result?.finalUrl
      ? `<a class="final-link" href="${j.result.finalUrl}" target="_blank" rel="noopener">🔗 ${j.result.linkType}: ${esc(j.result.finalUrl)}</a>` : '';
    const acts = [];
    if (['failed', 'cancelled'].includes(j.status)) acts.push(`<button class="btn small muted" data-retry="${j.id}">Retry</button>`);
    if (j.status === 'queued') acts.push(`<button class="btn small danger" data-cancel="${j.id}">Cancel</button>`);
    return `<div class="card">
      <div style="display:flex;justify-content:space-between;gap:8px;align-items:center">
        <div class="title">${esc(j.title || 'job')}</div>
        <span class="job-status ${j.status}">${j.status}</span>
      </div>
      <div class="meta">${j.provider || ''} ${j.quality || ''} · attempt ${j.attempts || 0}${j.error ? ` · <span style="color:var(--red)">${esc(j.error)}</span>` : ''}</div>
      ${final}
      ${logs ? `<div class="joblog">${esc(logs)}</div>` : ''}
      ${acts.length ? `<div class="actions">${acts.join('')}</div>` : ''}
    </div>`;
  }).join('') || '<div class="muted">No jobs yet.</div>';
}

// ── data loading ──
async function refreshAll() {
  const [status, posts, jobs] = await Promise.all([api('/status'), api('/posts'), api('/jobs')]);
  renderStatus(status);
  state.posts = posts; renderPosts();
  state.jobs = jobs; renderJobs();
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
      upsert(state.posts, payload, (p) => p.id); renderPosts(); refreshStatusSoon(); break;
    case 'job:created':
    case 'job:updated':
      upsert(state.jobs, payload, (j) => j.id); renderJobs(); refreshStatusSoon(); break;
    case 'job:log': {
      const j = state.jobs.find((x) => x.id === payload.jobId);
      if (j) { j.logs = [...(j.logs || []), payload].slice(-200); renderJobs(); }
      break;
    }
    case 'captcha:needed': showCaptcha(payload); break;
    case 'watcher:tick': refreshStatusSoon(); break;
    case 'sheet:appended': refreshStatusSoon(); break;
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
  statusTimer = setTimeout(() => api('/status').then(renderStatus).catch(() => {}), 400);
}

// ── captcha banner ──
let currentCaptcha = null;
function showCaptcha(payload) {
  currentCaptcha = payload;
  $('#captchaLink').href = payload.url || '#';
  $('#captchaBanner').classList.remove('hidden');
}
$('#btnCaptchaSolved').onclick = async () => {
  if (currentCaptcha) await api(`/captcha/${currentCaptcha.requestId}/solved`, { method: 'POST' });
  $('#captchaBanner').classList.add('hidden');
  currentCaptcha = null;
};

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
  if (t.dataset.post != null && t.dataset.idx != null) {
    const post = state.posts.find((p) => String(p.id) === t.dataset.post);
    const opt = post?.options?.[+t.dataset.idx];
    if (opt) { await api('/jobs', { method: 'POST', body: JSON.stringify({ url: opt.url, provider: opt.provider, quality: opt.quality, title: post.title, postLink: post.link }) }); refreshAll(); }
  }
});

// ── settings dialog ──
$('#btnSettings').onclick = async () => {
  const cfg = await api('/config');
  const f = $('#settingsForm');
  f.preferredProviders.value = cfg.watcher.preferredProviders.join(',');
  f.preferredQualities.value = cfg.watcher.preferredQualities.join(',');
  f.pollIntervalSeconds.value = cfg.watcher.pollIntervalSeconds;
  f.autoResolve.checked = cfg.watcher.autoResolve;
  f.browserMode.value = cfg.bypass.browserMode;
  $('#sheetInfo').textContent = cfg.sheets.configured ? `${cfg.sheets.sheetId} / ${cfg.sheets.tab}` : 'not configured';
  $('#settingsDialog').showModal();
};
$('#settingsForm').addEventListener('submit', async (e) => {
  if (e.submitter?.value !== 'save') return;
  const f = e.target;
  const patch = {
    watcher: {
      preferredProviders: splitList(f.preferredProviders.value),
      preferredQualities: splitList(f.preferredQualities.value),
      pollIntervalSeconds: +f.pollIntervalSeconds.value || 300,
      autoResolve: f.autoResolve.checked,
    },
    bypass: { browserMode: f.browserMode.value },
  };
  await api('/config', { method: 'PATCH', body: JSON.stringify(patch) });
  refreshAll();
});

// ── helpers ──
function upsert(arr, item, keyFn) {
  const k = keyFn(item);
  const i = arr.findIndex((x) => keyFn(x) === k);
  if (i >= 0) arr[i] = item; else arr.unshift(item);
}
function splitList(s) { return s.split(',').map((x) => x.trim()).filter(Boolean); }
function esc(s) { return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function timeago(iso) {
  const d = (Date.now() - new Date(iso)) / 1000;
  if (d < 60) return `${Math.floor(d)}s ago`;
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  return `${Math.floor(d / 3600)}h ago`;
}

// ── boot ──
refreshAll().catch((e) => appendLog({ ts: '', level: 'error', scope: 'ui', msg: String(e) }));
connectWs();
setInterval(() => refreshAll().catch(() => {}), 15000);
