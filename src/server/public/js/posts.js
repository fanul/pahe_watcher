import { $, api, esc } from './state.js';

// Pagination state lives here (module-local), not on the shared `state`
// object — mirrors how crawl.js already tracks its own accumulated list.
const LIMIT = 24;
let offset = 0;
let total = 0;
let loading = false;

function currentFilters() {
  return {
    search: $('#filterSearch')?.value?.trim() || '',
    type: $('#filterType')?.value || 'all',
    provider: $('#filterProvider')?.value || 'all',
    quality: $('#filterResolution')?.value || 'all',
    codec: $('#filterCodec')?.value || 'all',
    genre: $('#filterGenre')?.value || 'all',
    year: $('#filterYear')?.value || 'all',
    duration: $('#filterDuration')?.value || 'all',
    sort: $('#filterSort')?.value || 'date_desc',
  };
}

/** Populate the Genre/Year dropdowns from the archive's actual data (open-ended sets, unlike the static provider/quality/codec lists). Call once on boot. */
export async function initPostFacets() {
  const facets = await api('/posts/facets').catch(() => null);
  if (!facets) return;

  const genreSelect = $('#filterGenre');
  if (genreSelect) {
    for (const g of facets.genres) {
      const opt = document.createElement('option');
      opt.value = g;
      opt.textContent = g;
      genreSelect.appendChild(opt);
    }
  }

  const yearSelect = $('#filterYear');
  if (yearSelect) {
    for (const y of facets.years) {
      const opt = document.createElement('option');
      opt.value = String(y);
      opt.textContent = String(y);
      yearSelect.appendChild(opt);
    }
  }
}

/** Call after a WS job:updated marks a job dead, so the affected post's card grays out without a full posts refetch. */
export function markPostsWithDeadJob(state, postLink) {
  let changed = false;
  for (const p of state.posts) {
    if (p.link === postLink && !p.hasDeadJob) {
      p.hasDeadJob = true;
      changed = true;
    }
  }
  if (changed) renderPosts(state);
}

/**
 * Fetch a page of posts (server-side filtered/paginated) and render.
 * `reset: true` (default) replaces the loaded set — used on initial load and
 * whenever a filter changes. `reset: false` appends the next page — used by
 * "Load more".
 */
export async function loadPosts(state, { reset = true } = {}) {
  if (loading) return;
  loading = true;
  if (reset) offset = 0;

  const f = currentFilters();
  const params = new URLSearchParams({ limit: LIMIT, offset: String(offset) });
  for (const [k, v] of Object.entries(f)) if (v) params.set(k, v);

  try {
    const res = await api(`/posts?${params}`);
    state.posts = reset ? res.items : [...state.posts, ...res.items];
    total = res.total;
    offset += res.items.length;
    renderPosts(state);
  } finally {
    loading = false;
  }
}

/** Call after a WS `post:new` inserts a genuinely new (not just updated) post, so the count/Load-more stay accurate without a re-fetch. */
export function notePostInserted() {
  total += 1;
}

export function renderPosts(state) {
  const filterProvider = $('#filterProvider')?.value || 'all';
  const filterResolution = $('#filterResolution')?.value || 'all';
  const filterCodec = $('#filterCodec')?.value || 'all';

  $('#postCount').textContent = `(${total})`;

  $('#posts').innerHTML = state.posts.map((p) => {
    // Posts are already filtered server-side; this only decides which chips
    // (options) within an already-matching post to display — no extra fetch.
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

    const extraMetaParts = [];
    if (p.year) extraMetaParts.push(String(p.year));
    if (p.genre) extraMetaParts.push(esc(p.genre));
    if (p.durationMinutes) extraMetaParts.push(`${p.durationMinutes} min`);
    const extraMetaHtml = extraMetaParts.length
      ? `<div class="meta small">${extraMetaParts.join(' · ')}</div>` : '';

    const creditsParts = [];
    if (p.director) creditsParts.push(`<b>Director:</b> ${esc(p.director)}`);
    if (p.creator) creditsParts.push(`<b>Creator:</b> ${esc(p.creator)}`);
    if (p.actors) creditsParts.push(`<b>Cast:</b> ${esc(p.actors)}`);
    const creditsHtml = creditsParts.length
      ? `<div class="meta small muted">${creditsParts.join(' &nbsp;·&nbsp; ')}</div>` : '';

    return `
      <div class="card${p.hasDeadJob ? ' dead-link' : ''}">
        <div class="card-poster">${posterHtml}</div>
        <div class="card-content">
          <div class="title" title="${esc(p.title)}">${esc(p.title)}</div>
          <div class="meta">
            ${ratingHtml}
            <span>${typeLabel}</span>
            <span>·</span>
            <span>${new Date(p.date).toLocaleString()}</span>
            <span>·</span>
            <a href="${p.link}" target="_blank" rel="noopener">Origin Post ↗</a>
          </div>
          ${extraMetaHtml}
          ${creditsHtml}
          <div class="synopsis" title="${esc(p.synopsis || 'No synopsis available.')}">
            ${esc(p.synopsis || 'No synopsis available.')}
          </div>
          <div class="chips">
            ${rows || '<span class="muted">No matching links</span>'}
          </div>
          <div class="actions" style="display: flex; gap: 10px; align-items: center; flex-wrap: wrap;">
            <button class="btn small" data-resolve-post="${p.id}">Resolve preferred</button>
            ${(() => {
              const resolvedJobs = (state.jobs || []).filter(j =>
                j.postLink === p.link &&
                j.status === 'done' &&
                j.result &&
                j.result.finalUrl
              );

              if (resolvedJobs.length === 1) {
                const job = resolvedJobs[0];
                return `
                  <a href="${esc(job.result.finalUrl)}" target="_blank" rel="noopener" class="btn small success-btn" style="text-decoration: none; display: inline-flex; align-items: center; gap: 4px; height: 28px;">
                    📂 Open (${job.quality})
                  </a>
                `;
              } else if (resolvedJobs.length > 1) {
                const optionsHtml = resolvedJobs.map(j => {
                  return `<option value="${esc(j.result.finalUrl)}">${j.quality} (${j.provider})</option>`;
                }).join('');

                return `
                  <div style="display: flex; gap: 6px; align-items: center;">
                    <select class="filter-select select-gd-link" style="width: auto; padding: 4px 8px; font-size: 11px; background: rgba(16, 185, 129, 0.1); border-color: rgba(16, 185, 129, 0.4); color: #34d399; font-weight: 600; height: 28px; cursor: pointer; border-radius: 6px; outline: none;">
                      ${optionsHtml}
                    </select>
                    <button class="btn small success-btn btn-open-selected-gd" style="height: 28px; padding: 0 10px; display: inline-flex; align-items: center; white-space: nowrap;">Open ↗</button>
                  </div>
                `;
              }
              return '';
            })()}
          </div>
        </div>
      </div>
    `;
  }).join('') || '<div class="muted" style="padding: 10px 0;">No posts match the current filters.</div>';

  const btnLoadMore = $('#btnLoadMorePosts');
  if (btnLoadMore) btnLoadMore.style.display = offset < total ? '' : 'none';
}
