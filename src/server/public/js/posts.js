import { $, esc } from './state.js';

export function renderPosts(state) {
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
