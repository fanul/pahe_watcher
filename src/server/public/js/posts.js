import { $, api, esc } from './state.js';

// Pagination state lives here (module-local), not on the shared `state`
// object — mirrors how crawl.js already tracks its own accumulated list.
const LIMIT = 24;
let offset = 0;
let total = 0;
let loading = false;

// Mirrors REQUIRED_FIELDS in src/parser/metadata/index.js — durationMinutes
// is deliberately excluded there (and here) since many legitimate posts
// never have a runtime figure. Keep this list in sync if that one changes.
const REQUIRED_METADATA_FIELD_LABELS = [
  ['poster', 'Poster'], ['rating', 'Rating'], ['synopsis', 'Synopsis'],
  ['year', 'Year'], ['genre', 'Genre'], ['actors', 'Actors'],
];

/** Which required metadata fields a post is missing — for the info-bubble breakdown next to the incomplete badge. */
export function missingMetadataFields(p) {
  const missing = REQUIRED_METADATA_FIELD_LABELS
    .filter(([key]) => p[key] === null || p[key] === undefined || p[key] === '')
    .map(([, label]) => label);
  if (!p.director && !p.creator) missing.push('Director / Creator');
  return missing;
}

function currentFilters() {
  return {
    search: $('#filterSearch')?.value?.trim() || '',
    type: $('#filterType')?.value || 'all',
    provider: $('#filterProvider')?.value || 'all',
    quality: $('#filterResolution')?.value || 'all',
    codec: $('#filterCodec')?.value || 'all',
    genre: (() => {
      const el = $('#filterGenre');
      if (!el) return 'all';
      const selected = Array.from(el.selectedOptions).map(o => o.value);
      if (selected.length === 0 || selected.includes('all')) return 'all';
      return selected.join(',');
    })(),
    year: $('#filterYear')?.value || 'all',
    duration: $('#filterDuration')?.value || 'all',
    rating: $('#filterRating')?.value || 'all',
    sort: $('#filterSort')?.value || 'date_desc',
    metadataComplete: $('#filterMetadata')?.value || 'all',
    deadLink: $('#filterDeadLink')?.value || 'all',
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

  // Refresh searchable selects if initialized
  if (window.searchableSelects) {
    window.searchableSelects.forEach(ss => {
      if (ss.selectEl === genreSelect || ss.selectEl === yearSelect) {
        ss.refresh();
      }
    });
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

/** Updates a post's source-incomplete flag in local state (after a confirmed /mark-source-incomplete call), so its badge changes without a full posts refetch. */
export function markPostSourceIncomplete(state, postId, flag) {
  const post = state.posts.find((p) => p.id === postId);
  if (post) {
    post.metadataSourceIncomplete = flag;
    renderPosts(state);
  }
}

/** Marks one option as reported in local state (after a confirmed /mark-reported call), so its chip shows "✓ Reported" without a full posts refetch. */
export function markOptionReported(state, postId, url, deadReportedAt) {
  const post = state.posts.find((p) => p.id === postId);
  const opt = post?.options?.find((o) => o.url === url);
  if (opt) {
    opt.deadReportedAt = deadReportedAt;
    renderPosts(state);
  }
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
  const el = $('#postCount');
  if (el) el.textContent = `(${total})`;
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

      const openBtn = o.resolvedUrl
        ? `<a href="${esc(o.resolvedUrl)}" target="_blank" rel="noopener" class="chip-action-open" style="color: #34d399; font-weight: 600; font-size: 11px; text-decoration: none; display: inline-flex; align-items: center; gap: 3px;">📂 Open ↗</a>`
        : '';
      const resolveText = o.resolvedUrl ? 'Re-resolve ↗' : 'Resolve ↗';
      const actionSep = o.resolvedUrl ? '<span class="muted" style="margin: 0 4px; font-size: 11px;">·</span>' : '';

      return `
        <div class="chip-row">
          <div class="chip-info">
            <span class="chip-provider ${o.provider === 'GD' ? 'gd' : ''}">${o.provider}</span>
            <span class="chip-meta">${o.season != null ? `S${o.season} · ` : ''}${o.quality || 'unknown'} · ${codec} · ${size}</span>
          </div>
          <div style="display: flex; align-items: center; gap: 4px;">
            ${openBtn}
            ${actionSep}
            <button type="button" class="chip-action" data-post="${p.id}" data-idx="${realIdx}" style="background: none; border: none; padding: 0; color: var(--accent); cursor: pointer; font-size: 11px; font-family: inherit; font-weight: 600;">${resolveText}</button>
          </div>
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

    let metadataBadgeHtml = '';
    let metadataInfoHtml = '';
    if (p.metadataSourceIncomplete) {
      metadataBadgeHtml = `<button type="button" class="metadata-badge source-incomplete" data-metadata-badge="${p.id}" data-metadata-source="posts" title="Manually flagged: pahe.ink's own page never had this data">ℹ Source incomplete</button>`;
    } else if (!p.metadataComplete) {
      metadataBadgeHtml = `<button type="button" class="metadata-badge incomplete" data-metadata-badge="${p.id}" data-metadata-source="posts" title="Click to change">⚠ Incomplete metadata</button>`;
    }
    if (!p.metadataComplete) {
      metadataInfoHtml = `<button type="button" class="metadata-info-btn" data-metadata-info="${p.id}" data-metadata-source="posts" title="Show which fields are missing">ℹ</button>`;
    }

    const hasResolvedGdLink = allOpts.some((o) => o.resolvedLinkType === 'google-drive');

    return `
      <div class="card${p.hasDeadJob ? ' dead-link' : ''}${!p.metadataComplete ? ' metadata-incomplete' : ''}${hasResolvedGdLink ? ' gd-resolved' : ''}">
        ${(metadataInfoHtml || metadataBadgeHtml) ? `<div class="metadata-badge-row">${metadataInfoHtml}${metadataBadgeHtml}</div>` : ''}
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
            <button class="btn small ghost" data-resync-post="${p.id}" title="Re-fetch this post from pahe.ink and refill any missing metadata/quality/size">↻ Resync</button>
            ${(() => {
              const resolvedOpts = (p.options || []).filter(o => o.resolvedUrl);

              if (resolvedOpts.length === 1) {
                const opt = resolvedOpts[0];
                return `
                  <a href="${esc(opt.resolvedUrl)}" target="_blank" rel="noopener" class="btn small success-btn" style="text-decoration: none; display: inline-flex; align-items: center; gap: 4px; height: 28px;">
                    📂 Open (${opt.quality} - ${opt.provider})
                  </a>
                `;
              } else if (resolvedOpts.length > 1) {
                const optionsHtml = resolvedOpts.map(o => {
                  return `<option value="${esc(o.resolvedUrl)}">${o.quality} (${o.provider})</option>`;
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

export function hasActiveFilters() {
  const f = currentFilters();
  return f.search !== '' ||
         f.type !== 'all' ||
         f.provider !== 'all' ||
         f.quality !== 'all' ||
         f.codec !== 'all' ||
         f.genre !== 'all' ||
         f.year !== 'all' ||
         f.duration !== 'all' ||
         f.rating !== 'all' ||
         f.sort !== 'date_desc' ||
         f.metadataComplete !== 'all' ||
         f.deadLink !== 'all';
}

export function setTotalPostCount(n) {
  total = n;
  const el = $('#postCount');
  if (el) el.textContent = `(${total})`;
}
