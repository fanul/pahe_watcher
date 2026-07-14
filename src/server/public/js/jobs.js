import { $, api, esc } from './state.js';

const LIMIT = 30;
let offset = 0;
let total = 0;
let loading = false;

/**
 * Fetch a page of jobs (server-side paginated, newest first) and render.
 * `reset: true` (default) replaces the loaded set; `reset: false` appends
 * the next page — used by "Load more".
 */
export async function loadJobs(state, { reset = true } = {}) {
  if (loading) return;
  loading = true;
  if (reset) offset = 0;

  try {
    const res = await api(`/jobs?limit=${LIMIT}&offset=${offset}`);
    state.jobs = reset ? res.items : [...state.jobs, ...res.items];
    total = res.total;
    offset += res.items.length;
    renderJobs(state);
  } finally {
    loading = false;
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

    return `<div class="${cardClass}">
      <div style="display:flex;justify-content:space-between;gap:8px;align-items:center">
        <div class="title">${esc(j.title || 'job')}</div>
        <span class="job-status ${j.status}">${esc(statusText)}</span>
      </div>
      <div class="meta">${j.provider || ''} ${j.quality || ''} · attempt ${j.attempts || 0}${errorSpan}</div>
      ${final}
      ${logs ? `<div class="joblog">${esc(logs)}</div>` : ''}
      ${acts.length ? `<div class="actions">${acts.join('')}</div>` : ''}
    </div>`;
  }).join('') || '<div class="muted">No jobs yet.</div>';

  const btnLoadMore = $('#btnLoadMoreJobs');
  if (btnLoadMore) btnLoadMore.style.display = offset < total ? '' : 'none';
}
