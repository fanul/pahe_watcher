import { $, esc } from './state.js';

export function renderJobs(state) {
  const jobs = state.jobs.slice(0, 60);
  $('#jobs').innerHTML = jobs.map((j) => {
    const logs = (j.logs || []).slice(-6).map((l) => `${l.msg}`).join('\n');
    const final = j.result?.finalUrl
      ? `<a class="final-link" href="${j.result.finalUrl}" target="_blank" rel="noopener">🔗 ${j.result.linkType}: ${esc(j.result.finalUrl)}</a>` : '';
    const acts = [];
    if (['failed', 'cancelled'].includes(j.status)) acts.push(`<button class="btn small muted" data-retry="${j.id}">Retry</button>`);
    if (j.status === 'queued') acts.push(`<button class="btn small danger" data-cancel="${j.id}">Cancel</button>`);
    if (['done', 'failed', 'cancelled'].includes(j.status)) acts.push(`<button class="btn small danger-btn" data-delete-job="${j.id}">Delete</button>`);
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
}
