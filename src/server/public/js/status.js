import { $ } from './state.js';
import { timeago } from './utils.js';

export function renderStatus(s, state) {
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
