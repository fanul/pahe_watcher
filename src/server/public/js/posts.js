import { $, esc } from './state.js';

export function renderPosts(state) {
  const filterSearch = $('#filterSearch')?.value?.trim()?.toLowerCase() || '';
  const filterType = $('#filterType')?.value || 'all';
  const filterProvider = $('#filterProvider')?.value || 'all';
  const filterResolution = $('#filterResolution')?.value || 'all';
  const filterCodec = $('#filterCodec')?.value || 'all';

  const filteredPosts = state.posts.filter((p) => {
    // 0. Flexible Title & Synopsis Search
    if (filterSearch) {
      const words = filterSearch.split(/\s+/).filter(Boolean);
      const titleLower = p.title.toLowerCase();
      const synopsisLower = (p.synopsis || '').toLowerCase();
      const isMatched = words.every(word => titleLower.includes(word) || synopsisLower.includes(word));
      if (!isMatched) return false;
    }

    // 1. Box Office vs TV Series filter
    const isSeries = p.isSeries ?? /season|episode|web-dl\s+\[ep|s\d+e\d+|\bs\d+\b/i.test(p.title);
    if (filterType === 'movie' && isSeries) return false;
    if (filterType === 'series' && !isSeries) return false;

    // 2. Options level filters
    const matchingOpts = (p.options || []).filter((o) => {
      if (filterProvider !== 'all' && o.provider !== filterProvider) return false;
      if (filterResolution !== 'all' && o.quality !== filterResolution) return false;
      if (filterCodec !== 'all') {
        const isX265 = /x265|hevc|10bit/i.test(o.qualityLabel || '');
        if (filterCodec === 'x265' && !isX265) return false;
        if (filterCodec === 'x264' && isX265) return false;
      }
      return true;
    });

    const hasLinkFilters = filterProvider !== 'all' || filterResolution !== 'all' || filterCodec !== 'all';
    if (hasLinkFilters && matchingOpts.length === 0) return false;

    return true;
  });

  $('#postCount').textContent = `(${filteredPosts.length})`;

  $('#posts').innerHTML = filteredPosts.map((p) => {
    const allOpts = p.options || [];
    const opts = allOpts.filter((o) => {
      if (filterProvider !== 'all' && o.provider !== filterProvider) return false;
      if (filterResolution !== 'all' && o.quality !== filterResolution) return false;
      if (filterCodec !== 'all') {
        const isX265 = /x265|hevc|10bit/i.test(o.qualityLabel || '');
        if (filterCodec === 'x265' && !isX265) return false;
        if (filterCodec === 'x264' && isX265) return false;
      }
      return true;
    });

    const rows = opts.map((o) => {
      let codec = 'x264';
      if (/x265|hevc|10bit/i.test(o.qualityLabel || '')) {
        codec = 'x265';
      } else if (/av1/i.test(o.qualityLabel || '')) {
        codec = 'AV1';
      }
      const size = o.sizeLabel || 'N/A';
      const realIdx = allOpts.indexOf(o);

      return `
        <div class="chip-row">
          <div class="chip-info">
            <span class="chip-provider ${o.provider === 'GD' ? 'gd' : ''}">${o.provider}</span>
            <span class="chip-meta">${o.quality || 'unknown'} · ${codec} · ${size}</span>
          </div>
          <button type="button" class="chip-action" data-post="${p.id}" data-idx="${realIdx}" style="background: none; border: none; padding: 0; color: var(--accent); cursor: pointer; font-size: 11px; font-family: inherit; font-weight: 600;">Resolve ↗</button>
        </div>
      `;
    }).join('');

    const posterHtml = p.poster
      ? `<img src="${p.poster}" alt="Poster" referrerpolicy="no-referrer" />`
      : `<div class="poster-placeholder">🎬</div>`;

    const ratingHtml = p.rating
      ? `<span class="rating-badge">★ ${p.rating}</span>`
      : '';

    const isSeries = p.isSeries ?? /season|episode|web-dl\s+\[ep|s\d+e\d+|\bs\d+\b/i.test(p.title);
    const typeLabel = isSeries ? 'TV Series' : 'Movie';

    return `
      <div class="card">
        <div class="card-poster">${posterHtml}</div>
        <div class="card-content">
          <div class="title" title="${esc(p.title)}">${esc(p.title)}</div>
          <div class="meta">
            ${ratingHtml}
            <span>${typeLabel}</span>
            <span>·</span>
            <span>${new Date(p.date).toLocaleDateString()}</span>
            <span>·</span>
            <a href="${p.link}" target="_blank" rel="noopener">Origin Post ↗</a>
          </div>
          <div class="synopsis" title="${esc(p.synopsis || 'No synopsis available.')}">
            ${esc(p.synopsis || 'No synopsis available.')}
          </div>
          <div class="chips">
            ${rows || '<span class="muted">No matching links</span>'}
          </div>
          <div class="actions">
            <button class="btn small" data-resolve-post="${p.id}">Resolve preferred</button>
          </div>
        </div>
      </div>
    `;
  }).join('') || '<div class="muted" style="padding: 10px 0;">No posts match the current filters.</div>';
}
