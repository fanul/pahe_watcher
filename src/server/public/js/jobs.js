import { $, api, esc } from './state.js';

const LIMIT = 30;
let offset = 0;
let total = 0;
// Same reasoning as posts.js's paginationLoading/loadSeq pair (see that
// file's comment for the full story: a naive `if (loading) return` guard
// silently dropped a just-typed search's request if an earlier one was
// still in flight). "Load more" keeps a simple overlap guard since two
// concurrent non-reset calls would corrupt the shared offset counter; a
// fresh search/filter (reset:true) always proceeds and supersedes
// whatever's in flight via the sequence number instead.
let paginationLoading = false;
let loadSeq = 0;

/**
 * Fetch a page of jobs (server-side paginated, newest first, optionally
 * title-filtered) and render. `reset: true` (default) replaces the loaded
 * set; `reset: false` appends the next page — used by "Load more".
 */
export async function loadJobs(state, { reset = true } = {}) {
  if (!reset && paginationLoading) return;
  const seq = ++loadSeq;
  if (reset) offset = 0;
  if (!reset) paginationLoading = true;

  const search = $('#filterJobSearch')?.value?.trim() || '';
  const params = new URLSearchParams({ limit: LIMIT, offset: String(offset) });
  if (search) params.set('search', search);

  try {
    const res = await api(`/jobs?${params}`);
    if (seq !== loadSeq) return; // superseded by a newer call — discard
    state.jobs = reset ? res.items : [...state.jobs, ...res.items];
    total = res.total;
    offset += res.items.length;
    renderJobs(state);
  } finally {
    if (!reset) paginationLoading = false;
  }
}

/** Call after a WS `job:created` inserts a genuinely new job, so the count/Load-more stay accurate without a re-fetch. */
export function noteJobInserted() {
  total += 1;
}

/** Call after a job is deleted, so the total stays accurate. */
export function noteJobsRemoved(count = 1) {
  total = Math.max(0, total - count);
}

/** Call after "Clear All" — every job is gone, so both the loaded set and the total reset to empty. */
export function resetJobsCleared(state) {
  state.jobs = [];
  offset = 0;
  total = 0;
  renderJobs(state);
}

export function renderJobs(state) {
  const jobs = state.jobs;
  $('#jobs').innerHTML = jobs.map((j) => {
    const logs = (j.logs || []).slice(-6).map((l) => `${l.msg}`).join('\n');
    const final = j.result?.finalUrl
      ? `<a class="final-link" href="${j.result.finalUrl}" target="_blank" rel="noopener">🔗 ${j.result.linkType}: ${esc(j.result.finalUrl)}</a>` : '';
    const acts = [];
    if (['failed', 'cancelled', 'dead'].includes(j.status)) acts.push(`<button class="btn small muted" data-retry="${j.id}">Retry</button>`);
    if (j.status === 'queued') {
      acts.push(`<button class="btn small muted" data-pause-job="${j.id}">Pause</button>`);
      acts.push(`<button class="btn small danger" data-cancel="${j.id}">Cancel</button>`);
    }
    if (j.status === 'paused') {
      acts.push(`<button class="btn small success-btn" style="background: rgba(16, 185, 129, 0.1); border-color: rgba(16, 185, 129, 0.4); color: #34d399;" data-resume-job="${j.id}">Resume</button>`);
      acts.push(`<button class="btn small danger-btn" data-delete-job="${j.id}">Delete</button>`);
    }
    if (['running', 'needs-captcha'].includes(j.status)) {
      acts.push(`<button class="btn small danger" data-cancel="${j.id}">Cancel</button>`);
    }
    const isConfirmedGoodLink = j.status === 'done' && j.result?.linkType === 'google-drive';
    if (j.status === 'dead') {
      acts.push(`<button class="btn small muted" data-unmark-dead="${j.id}" title="Undo the dead marking — puts this job back to failed">Unmark Dead</button>`);
    } else if (['done', 'failed', 'cancelled'].includes(j.status) && !isConfirmedGoodLink) {
      acts.push(`<button class="btn small danger" data-mark-dead="${j.id}" title="Flag this link as dead — the automatic detector didn't catch it, but you've confirmed it's actually dead">Mark Dead</button>`);
    }
    if (['done', 'failed', 'cancelled', 'dead'].includes(j.status) && j.url) {
      acts.push(`<button class="btn small muted" data-report-job="${j.id}" title="Report this link as dead on pahe.ink">Report</button>`);
    }
    if (['done', 'failed', 'cancelled', 'dead'].includes(j.status)) acts.push(`<button class="btn small danger-btn" data-delete-job="${j.id}">Delete</button>`);
    const isSheetError = j.status === 'failed' && j.result?.finalUrl;
    const isSuccess = j.status === 'done';

    let cardClass = 'card';
    let statusText = j.status;

    if (isSheetError) {
      cardClass = 'card sheet-error';
      statusText = 'Almost Finished';
    } else if (isSuccess) {
      cardClass = 'card sheet-success';
    }

    let errorSpan = '';
    if (j.error) {
      const errorColor = isSheetError ? 'var(--accent)' : 'var(--red)';
      const errorLabel = isSheetError ? `Google Sheet Error: ${esc(j.error)}` : esc(j.error);
      errorSpan = ` · <span style="color:${errorColor}">${errorLabel}</span>`;
    }

    // Sits just left of the status pill — j.result.jdownloaderPushed is
    // null when JDownloader isn't configured (or this job never reached
    // that step), so the badge only shows up once a push was actually
    // attempted. Once pushed, downloadMonitor.js polls JDownloader in the
    // background and fills in jdownloaderStatus/Progress/SaveTo — this
    // reads whatever it last saw, live (job:updated over the websocket
    // triggers a re-render), no separate streaming connection needed.
    let jdownloaderBadge = '';
    let jdownloaderSaveToLine = '';
    if (j.result?.jdownloaderPushed === true) {
      const dlStatus = j.result?.jdownloaderStatus;
      const progress = j.result?.jdownloaderProgress;
      if (dlStatus === 'finished') {
        jdownloaderBadge = `<span class="job-status jdownloader-finished" title="Finished downloading in JDownloader${j.result?.jdownloaderSaveTo ? ' — ' + esc(j.result.jdownloaderSaveTo) : ''}">✨ Downloaded</span>`;
      } else if (dlStatus === 'running') {
        jdownloaderBadge = `<span class="job-status" style="background: rgba(99, 102, 241, 0.15); border: 1px solid rgba(99, 102, 241, 0.4); color: #818cf8;" title="Downloading in JDownloader">⬇ ${progress ?? 0}%</span>`;
      } else {
        jdownloaderBadge = `<span class="job-status" style="background: rgba(16, 185, 129, 0.15); border: 1px solid rgba(16, 185, 129, 0.4); color: #34d399;" title="Pushed to JDownloader">⬇ JDownloader</span>`;
      }
      if (j.result?.jdownloaderSaveTo) {
        jdownloaderSaveToLine = `<div class="muted small" style="margin-top:2px" title="${esc(j.result.jdownloaderSaveTo)}">📁 ${esc(j.result.jdownloaderSaveTo)}</div>`;
      }
    } else if (j.result?.jdownloaderPushed === false) {
      jdownloaderBadge = `<span class="job-status" style="background: rgba(248, 81, 73, 0.15); border: 1px solid rgba(248, 81, 73, 0.4); color: var(--red);" title="${esc(j.result?.jdownloaderError || 'JDownloader push failed')}">⬇ JDownloader failed</span>`;
    }

    return `<div class="${cardClass}">
      <div style="display:flex; flex-direction:column; flex:1; min-width:0">
        <div class="job-title">${esc(j.title || 'job')}</div>
        <div style="display:flex;justify-content:space-between;gap:8px;align-items:center;margin-bottom:6px">
          <div class="meta" style="margin-bottom:0">${j.provider || ''} ${j.quality || ''} · attempt ${j.attempts || 0}${errorSpan}</div>
          <div style="display:flex;align-items:center;gap:6px">
            ${jdownloaderBadge}
            <span class="job-status ${j.status}">${esc(statusText)}</span>
          </div>
        </div>
        ${final}
        ${jdownloaderSaveToLine}
        ${logs ? `<div class="joblog">${esc(logs)}</div>` : ''}
        ${acts.length ? `<div class="actions" style="margin-top:6px">${acts.join('')}</div>` : ''}
      </div>
    </div>`;
  }).join('') || '<div class="muted">No jobs yet.</div>';

  const btnLoadMore = $('#btnLoadMoreJobs');
  if (btnLoadMore) btnLoadMore.style.display = offset < total ? '' : 'none';
}
