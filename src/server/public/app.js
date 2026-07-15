// pahe-watcher dashboard client. Refactored into clean ES modules.
import { $, api, state, esc } from './js/state.js';
import { upsert } from './js/utils.js';
import { renderStatus } from './js/status.js';
import { loadPosts, renderPosts, notePostInserted, initPostFacets, markPostsWithDeadJob, markOptionReported, markPostSourceIncomplete, missingMetadataFields } from './js/posts.js';
import { loadJobs, renderJobs, noteJobInserted, noteJobsRemoved, resetJobsCleared } from './js/jobs.js';
import { initCrawl, updateCrawlProgress, findAccumulatedById, markAccumulatedSourceIncomplete } from './js/crawl.js';
import { initSettings, applyLayoutMode } from './js/settings.js';
import { initCaptcha, showCaptcha } from './js/captcha.js';
import { initManualJob } from './js/manual.js';
import { SearchableSelect } from './js/searchableSelect.js';

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
let currentWs = null;
function connectWs() {
  if (currentWs) {
    currentWs.onmessage = null;
    currentWs.onclose = null;
    currentWs.onerror = null;
    try { currentWs.close(); } catch (e) {}
    currentWs = null;
  }

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws${token ? `?token=${token}` : ''}`);
  currentWs = ws;

  ws.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    handleEvent(m.type, m.payload);
  };

  ws.onclose = () => {
    ws.onmessage = null;
    ws.onclose = null;
    ws.onerror = null;
    if (currentWs === ws) currentWs = null;
    setTimeout(connectWs, 2000);
  };

  ws.onerror = () => {
    ws.onmessage = null;
    ws.onclose = null;
    ws.onerror = null;
    if (currentWs === ws) currentWs = null;
    try { ws.close(); } catch (e) {}
  };
}

function shouldPrependPost(payload) {
  // 1. If it's already in the list, we always update it (return true for upsert to run)
  if (state.posts.some((p) => p.id === payload.id)) {
    return true;
  }

  // 2. If it's not in the list, we only prepend it if:
  // - We are showing the first page of posts (posts count is <= 24)
  if (state.posts.length > 24) return false;

  // - There are no active filters (which would restrict what should be shown)
  const search = $('#filterSearch')?.value?.trim() || '';
  if (search) return false;

  const type = $('#filterType')?.value || 'all';
  if (type !== 'all') return false;

  const provider = $('#filterProvider')?.value || 'all';
  if (provider !== 'all') return false;

  const resolution = $('#filterResolution')?.value || 'all';
  if (resolution !== 'all') return false;

  const codec = $('#filterCodec')?.value || 'all';
  if (codec !== 'all') return false;

  const genreEl = $('#filterGenre');
  if (genreEl) {
    const selected = Array.from(genreEl.selectedOptions).map(o => o.value);
    if (selected.length > 0 && !selected.includes('all')) return false;
  }

  const year = $('#filterYear')?.value || 'all';
  if (year !== 'all') return false;

  const rating = $('#filterRating')?.value || 'all';
  if (rating !== 'all') return false;

  const sort = $('#filterSort')?.value || 'date_desc';
  if (sort !== 'date_desc') return false;

  const metadataComplete = $('#filterMetadata')?.value || 'all';
  if (metadataComplete !== 'all') return false;

  const deadLink = $('#filterDeadLink')?.value || 'all';
  if (deadLink !== 'all') return false;

  // - The post is newer than the newest post in our current list (preventing old backfill posts from being prepended)
  const newestPost = state.posts[0];
  if (newestPost && payload.id < newestPost.id) {
    return false;
  }

  return true;
}

let logBuffer = [];
function handleEvent(type, payload) {
  switch (type) {
    case 'log': appendLog(payload); break;
    case 'post:new': {
      if (payload.isNew) {
        notePostInserted();
      }
      if (shouldPrependPost(payload)) {
        upsert(state.posts, payload, (p) => p.id);
        renderPosts(state);
      }
      refreshStatusSoon();
      break;
    }
    case 'job:created':
    case 'job:updated': {
      const inserted = upsert(state.jobs, payload, (j) => j.id);
      if (inserted) noteJobInserted();
      renderJobs(state);

      if (payload.status === 'done' && payload.result?.finalUrl) {
        let postUpdated = false;
        for (const post of state.posts) {
          if (post.options) {
            for (const opt of post.options) {
              if (opt.url === payload.url) {
                opt.resolvedUrl = payload.result.finalUrl;
                opt.resolvedLinkType = payload.result.linkType;
                postUpdated = true;
              }
            }
          }
        }
        if (postUpdated) {
          renderPosts(state);
        }
      }

      if (payload.status === 'dead' && payload.postLink) markPostsWithDeadJob(state, payload.postLink);
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

// ── metadata badge dropdown (mark/unmark "source incomplete") — one shared
// floating menu, repositioned via JS next to whichever badge was clicked, so
// it isn't clipped by a card's `overflow: hidden`. ──
const metadataMenu = $('#metadataBadgeMenu');

function closeMetadataMenu() {
  metadataMenu.classList.add('hidden');
  metadataMenu.innerHTML = '';
  delete metadataMenu.dataset.forPost;
  delete metadataMenu.dataset.kind;
}

function positionMetadataMenu(triggerEl) {
  const rect = triggerEl.getBoundingClientRect();
  metadataMenu.style.top = `${rect.bottom + 4}px`;
  metadataMenu.style.left = `${Math.max(4, rect.right - 220)}px`;
  metadataMenu.classList.remove('hidden');
}

/** Post cards render in two places (New Posts / Historical Crawl) backed by two different lists — resolve which one a given badge click belongs to. */
function findMetadataSubject(postId, source) {
  if (source === 'crawl') return findAccumulatedById(postId);
  return state.posts.find((p) => String(p.id) === String(postId));
}

function toggleMetadataMenu(badgeEl, postId, source) {
  const wasOpenForThis = metadataMenu.dataset.kind === 'action' && metadataMenu.dataset.forPost === String(postId) && !metadataMenu.classList.contains('hidden');
  closeMetadataMenu();
  if (wasOpenForThis) return; // clicking the same badge again just closes it

  const post = findMetadataSubject(postId, source);
  if (!post) return;

  metadataMenu.dataset.forPost = String(postId);
  metadataMenu.dataset.kind = 'action';
  metadataMenu.innerHTML = post.metadataSourceIncomplete
    ? `<button type="button" class="badge-menu-item" data-unmark-source-incomplete="${postId}" data-metadata-source="${source}">Unmark — include in batch resync again</button>`
    : `<button type="button" class="badge-menu-item" data-mark-source-incomplete="${postId}" data-metadata-source="${source}">Source has no metadata — exclude from batch resync</button>`;

  positionMetadataMenu(badgeEl);
}

/** Read-only bubble listing exactly which required metadata fields this post is missing. */
function toggleMetadataInfo(infoBtnEl, postId, source) {
  const wasOpenForThis = metadataMenu.dataset.kind === 'info' && metadataMenu.dataset.forPost === String(postId) && !metadataMenu.classList.contains('hidden');
  closeMetadataMenu();
  if (wasOpenForThis) return;

  const post = findMetadataSubject(postId, source);
  if (!post) return;

  const missing = missingMetadataFields(post);
  metadataMenu.dataset.forPost = String(postId);
  metadataMenu.dataset.kind = 'info';
  metadataMenu.innerHTML = `
    <div class="badge-menu-info">
      <div class="badge-menu-info-title">Missing metadata field(s)</div>
      ${missing.length
        ? `<ul>${missing.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>`
        : '<div class="muted">Nothing missing — check back after the next sync.</div>'}
    </div>
  `;

  positionMetadataMenu(infoBtnEl);
}

document.body.addEventListener('click', async (e) => {
  const t = e.target;

  if (t.dataset.metadataInfo) {
    toggleMetadataInfo(t, t.dataset.metadataInfo, t.dataset.metadataSource || 'posts');
    return;
  }
  if (t.dataset.metadataBadge) {
    toggleMetadataMenu(t, t.dataset.metadataBadge, t.dataset.metadataSource || 'posts');
    return;
  }
  if (t.dataset.markSourceIncomplete) {
    const id = t.dataset.markSourceIncomplete;
    await api(`/posts/${id}/mark-source-incomplete`, { method: 'POST', body: JSON.stringify({ sourceIncomplete: true }) });
    if (t.dataset.metadataSource === 'crawl') markAccumulatedSourceIncomplete(id, true);
    else markPostSourceIncomplete(state, Number(id), true);
    closeMetadataMenu();
    return;
  }
  if (t.dataset.unmarkSourceIncomplete) {
    const id = t.dataset.unmarkSourceIncomplete;
    await api(`/posts/${id}/mark-source-incomplete`, { method: 'POST', body: JSON.stringify({ sourceIncomplete: false }) });
    if (t.dataset.metadataSource === 'crawl') markAccumulatedSourceIncomplete(id, false);
    else markPostSourceIncomplete(state, Number(id), false);
    closeMetadataMenu();
    return;
  }
  if (!metadataMenu.classList.contains('hidden')) closeMetadataMenu();
  // Frequent per-item actions: fire the request and let the resulting
  // job:created/job:updated/job:deleted WS event update the UI — no full
  // list refetch per click.
  if (t.dataset.resolvePost) { await api(`/posts/${t.dataset.resolvePost}/resolve`, { method: 'POST', body: '{}' }); }
  if (t.dataset.resyncPost) {
    t.disabled = true;
    const original = t.textContent;
    t.textContent = 'Resyncing…';
    try {
      await api(`/posts/${t.dataset.resyncPost}/resync`, { method: 'POST', body: '{}' });
    } catch (err) {
      appendLog({ ts: '', level: 'error', scope: 'ui', msg: `Resync failed: ${err.message}` });
    } finally {
      t.disabled = false;
      t.textContent = original;
    }
  }
  if (t.dataset.retry) { await api(`/jobs/${t.dataset.retry}/retry`, { method: 'POST' }); }
  if (t.dataset.cancel) { await api(`/jobs/${t.dataset.cancel}/cancel`, { method: 'POST' }); }
  if (t.dataset.pauseJob) { await api(`/jobs/${t.dataset.pauseJob}/pause`, { method: 'POST' }); }
  if (t.dataset.resumeJob) { await api(`/jobs/${t.dataset.resumeJob}/resume`, { method: 'POST' }); }
  if (t.dataset.deleteJob) { await api(`/jobs/${t.dataset.deleteJob}`, { method: 'DELETE' }); }
  if (t.dataset.markDead) { await api(`/jobs/${t.dataset.markDead}/mark-dead`, { method: 'POST' }); }
  if (t.dataset.unmarkDead) { await api(`/jobs/${t.dataset.unmarkDead}/unmark-dead`, { method: 'POST' }); }
  if (t.dataset.reportPost) { await openReportDialog(t.dataset.reportPost, t.dataset.reportUrl); }
  if (t.dataset.reportJob) { await openJobReportDialog(t.dataset.reportJob); }
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

// ── collapsible detailed filters (search stays visible) ──
const FILTERS_COLLAPSED_KEY = 'pahe.filtersCollapsed';
const filterDetails = $('#filterDetails');
const btnToggleFilters = $('#btnToggleFilters');
if (btnToggleFilters && filterDetails) {
  const setCollapsed = (collapsed) => {
    filterDetails.classList.toggle('collapsed', collapsed);
    btnToggleFilters.textContent = collapsed ? '▸ Filters' : '▾ Filters';
  };
  setCollapsed(localStorage.getItem(FILTERS_COLLAPSED_KEY) === '1');
  btnToggleFilters.onclick = () => {
    const nowCollapsed = !filterDetails.classList.contains('collapsed');
    setCollapsed(nowCollapsed);
    localStorage.setItem(FILTERS_COLLAPSED_KEY, nowCollapsed ? '1' : '0');
  };
}

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

// ── dead-link reporting (semi-automated — prepares the comment text, the
// user solves the captcha and submits it themselves on pahe.ink) ──
const reportDialog = $('#reportDialog');
let reportTarget = null; // { kind: 'post', postId, url } | { kind: 'job', jobId }

async function openReportDialog(postId, url) {
  try {
    const res = await api(`/posts/${postId}/report-dead-link`, { method: 'POST', body: JSON.stringify({ url }) });
    reportTarget = { kind: 'post', postId, url };
    $('#reportCommentText').value = res.commentText;
    $('#reportPostLink').href = res.postLink;
    reportDialog.showModal();
  } catch (err) {
    appendLog({ ts: '', level: 'error', scope: 'ui', msg: `Failed to prepare dead-link report: ${err.message}` });
  }
}

async function openJobReportDialog(jobId) {
  try {
    const res = await api(`/jobs/${jobId}/report-dead-link`, { method: 'POST' });
    reportTarget = { kind: 'job', jobId };
    $('#reportCommentText').value = res.commentText;
    $('#reportPostLink').href = res.postLink;
    reportDialog.showModal();
  } catch (err) {
    appendLog({ ts: '', level: 'error', scope: 'ui', msg: `Failed to prepare dead-link report: ${err.message}` });
  }
}

$('#btnReportCancel')?.addEventListener('click', () => reportDialog.close());
$('#btnMarkReported')?.addEventListener('click', async () => {
  if (!reportTarget) return;
  if (reportTarget.kind === 'job') {
    await api(`/jobs/${reportTarget.jobId}/mark-reported`, { method: 'POST' });
    reportDialog.close();
    return;
  }
  const { postId, url } = reportTarget;
  const updatedPost = await api(`/posts/${postId}/mark-reported`, { method: 'POST', body: JSON.stringify({ url }) });
  const opt = updatedPost.options?.find((o) => o.url === url);
  markOptionReported(state, Number(postId), url, opt?.deadReportedAt || new Date().toISOString());
  reportDialog.close();
});

// Keep references to searchable selects so we can access them if needed
window.searchableSelects = [];
function initSearchableSelects() {
  const selectors = [
    '#filterType',
    '#filterProvider',
    '#filterResolution',
    '#filterCodec',
    '#filterGenre',
    '#filterYear',
    '#filterDuration',
    '#filterRating',
    '#filterSort',
    '#filterMetadata',
    '#filterDeadLink'
  ];
  selectors.forEach(sel => {
    const el = $(sel);
    if (el) {
      window.searchableSelects.push(new SearchableSelect(el));
    }
  });
}

// ── filters (server-side now — debounce so typing doesn't hammer the API) ──
let filterDebounce = null;
function refilterPostsSoon(delay = 300) {
  clearTimeout(filterDebounce);
  filterDebounce = setTimeout(() => loadPosts(state, { reset: true }), delay);
}
['#filterType', '#filterProvider', '#filterResolution', '#filterCodec', '#filterGenre', '#filterYear', '#filterDuration', '#filterRating', '#filterSort', '#filterMetadata', '#filterDeadLink'].forEach((sel) => {
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
applyLayoutMode();
initCrawl(refreshAll);
initSettings(refreshAll);
initCaptcha();
initManualJob(refreshAll);

(async () => {
  await initPostFacets();
  initSearchableSelects();
  await refreshAll();
})().catch((e) => appendLog({ ts: '', level: 'error', scope: 'ui', msg: String(e) }));

connectWs();
// Periodic refresh is now status-only (cheap) — posts/jobs stay in sync via
// WebSocket pushes instead of a full-list refetch every 15s.
setInterval(() => refreshStatusOnly().catch(() => {}), 15000);
