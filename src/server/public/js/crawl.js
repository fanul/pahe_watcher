import { $, api, esc } from './state.js';

let accumulated = [];

export function initCrawl(refreshAll) {
  const btnStartCrawl = $('#btnStartCrawl');
  const btnResetCursor = $('#btnResetCursor');
  const btnDeepSyncSweep = $('#btnDeepSyncSweep');
  const btnMetadataBackfillSweep = $('#btnMetadataBackfillSweep');
  const btnSeriesResyncSweep = $('#btnSeriesResyncSweep');
  const crawlProgress = $('#crawlProgress');
  const crawlResults = $('#crawlResults');
  const crawlMaxPages = $('#crawlMaxPages');
  const crawlDirection = $('#crawlDirection');
  const crawlDeepSync = $('#crawlDeepSync');
  const deepSyncStatus = $('#deepSyncStatus');
  const metadataBackfillStatus = $('#metadataBackfillStatus');
  const seriesResyncStatus = $('#seriesResyncStatus');
  const deepSyncBatchSize = $('#deepSyncBatchSize');
  const metadataBackfillBatchSize = $('#metadataBackfillBatchSize');
  const seriesResyncBatchSize = $('#seriesResyncBatchSize');

  refreshDeepSyncStatus();
  refreshMetadataBackfillStatus();
  refreshSeriesResyncStatus();
  refreshCursorStatus();

  btnStartCrawl.onclick = async () => {
    btnStartCrawl.disabled = true;
    crawlProgress.textContent = 'Running batch...';

    try {
      const res = await api('/sync/backfill/run', {
        method: 'POST',
        body: JSON.stringify({
          batchSize: +crawlMaxPages.value || 5,
          direction: crawlDirection.value,
          deepSync: crawlDeepSync.checked,
        }),
      });
      accumulated = [...res.entries, ...accumulated];
      renderCrawlResults();
      const c = res.cursor;
      crawlProgress.textContent = res.done
        ? `Done — reached the end (page ${c.page}/${c.totalPages || '?'}).`
        : `Batch complete: ${res.pagesProcessed} page(s), ${res.postsListed} listed, ${res.postsDeepSynced} deep-synced. Cursor at page ${c.page}/${c.totalPages || '?'}.`;
      refreshDeepSyncStatus();
    } catch (err) {
      crawlProgress.textContent = 'Batch failed.';
      crawlResults.innerHTML = `<div class="card" style="color:var(--red)">Sync error: ${esc(err.message)}</div>`;
    } finally {
      btnStartCrawl.disabled = false;
    }
  };

  btnResetCursor.onclick = async () => {
    if (!confirm('Reset the backfill cursor to page 1?')) return;
    await api('/sync/backfill/reset', { method: 'POST', body: JSON.stringify({ page: 1 }) });
    accumulated = [];
    renderCrawlResults();
    refreshCursorStatus();
  };

  btnDeepSyncSweep.onclick = async () => {
    btnDeepSyncSweep.disabled = true;
    const batchSize = +deepSyncBatchSize.value || 20;
    try {
      const res = await api('/sync/deep-sync/run', {
        method: 'POST',
        body: JSON.stringify({ batchSize }),
      });
      accumulated = [...res.entries, ...accumulated];
      renderCrawlResults();
      deepSyncStatus.textContent = `Deep-synced ${res.processed} post(s), ${res.remaining} still pending.`;
    } finally {
      btnDeepSyncSweep.disabled = false;
    }
  };

  btnMetadataBackfillSweep.onclick = async () => {
    btnMetadataBackfillSweep.disabled = true;
    const batchSize = +metadataBackfillBatchSize.value || 20;
    try {
      const res = await api('/sync/metadata-backfill/run', {
        method: 'POST',
        body: JSON.stringify({ batchSize }),
      });
      accumulated = [...res.entries, ...accumulated];
      renderCrawlResults();
      metadataBackfillStatus.textContent = `Resynced ${res.processed} post(s), ${res.remaining} still have incomplete metadata.`;
    } finally {
      btnMetadataBackfillSweep.disabled = false;
    }
  };

  btnSeriesResyncSweep.onclick = async () => {
    btnSeriesResyncSweep.disabled = true;
    const batchSize = +seriesResyncBatchSize.value || 10;
    try {
      const res = await api('/sync/series-resync/run', {
        method: 'POST',
        body: JSON.stringify({ batchSize }),
      });
      accumulated = [...res.entries, ...accumulated];
      renderCrawlResults();
      seriesResyncStatus.textContent = `Resynced ${res.processed} series post(s), ${res.remaining} still stale.`;
    } finally {
      btnSeriesResyncSweep.disabled = false;
    }
  };

  async function refreshDeepSyncStatus() {
    const res = await api('/sync/deep-sync/status').catch(() => null);
    if (res) deepSyncStatus.textContent = `${res.pending} post(s) pending deep sync.`;
  }

  async function refreshSeriesResyncStatus() {
    const res = await api('/sync/series-resync/status').catch(() => null);
    if (res) seriesResyncStatus.textContent = `${res.pending} series post(s) missing newer seasons.`;
  }

  async function refreshMetadataBackfillStatus() {
    const res = await api('/sync/metadata-backfill/status').catch(() => null);
    if (res) metadataBackfillStatus.textContent = `${res.pending} post(s) with incomplete metadata.`;
  }

  async function refreshCursorStatus() {
    const cursor = await api('/sync/backfill/status').catch(() => null);
    if (cursor) {
      crawlMaxPages.value = crawlMaxPages.value || 5;
      crawlDirection.value = cursor.direction || 'older';
      crawlProgress.textContent = `Cursor: page ${cursor.page}${cursor.totalPages ? `/${cursor.totalPages}` : ''} (${cursor.direction}).`;
    }
  }

  function renderCrawlResults() {
    if (accumulated.length === 0) {
      crawlResults.innerHTML = '<div class="muted" style="padding: 10px 0;">No batches run yet. Click "Run Batch" to start syncing.</div>';
      return;
    }

    crawlResults.innerHTML = accumulated.map(r => {
      const allOpts = r.options || [];
      const rows = allOpts.map((o) => {
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
              <span class="chip-meta">${o.season != null ? `S${o.season} · ` : ''}${o.quality || 'unknown'} · ${codec} · ${size}</span>
            </div>
            <button type="button" class="chip-action" data-post="${r.id}" data-idx="${realIdx}" style="background: none; border: none; padding: 0; color: var(--accent); cursor: pointer; font-size: 11px; font-family: inherit; font-weight: 600;">Resolve ↗</button>
          </div>
        `;
      }).join('');

      const posterHtml = r.poster
        ? `<img src="${r.poster}" alt="Poster" referrerpolicy="no-referrer" />`
        : `<div class="poster-placeholder">🎬</div>`;

      const ratingHtml = r.rating
        ? `<span class="rating-badge">★ ${r.rating}</span>`
        : '';

      const isSeries = r.isSeries ?? /season|episode|web-dl\s+\[ep|s\d+e\d+|\bs\d+\b/i.test(r.title);
      const typeLabel = isSeries ? 'TV Series' : 'Movie';

      return `
        <div class="card">
          <div class="card-poster">${posterHtml}</div>
          <div class="card-content">
            <div class="title" title="${esc(r.title)}">${esc(r.title)}</div>
            <div class="meta">
              ${ratingHtml}
              <span>${typeLabel}</span>
              ${r.pageFound ? `<span>·</span><span>Found on Page ${r.pageFound}</span>` : ''}
              <span>·</span>
              <a href="${r.link}" target="_blank" rel="noopener">Origin Post ↗</a>
            </div>
            <div class="synopsis" title="${esc(r.synopsis || 'No synopsis available.')}">
              ${esc(r.synopsis || 'No synopsis available.')}
            </div>
            <div class="chips">
              ${rows || '<span class="muted">No links parsed</span>'}
            </div>
            <div class="actions">
              <button class="btn small" data-resolve-post="${r.id}">Resolve preferred</button>
            </div>
          </div>
        </div>
      `;
    }).join('');
  }
}

export function updateCrawlProgress(payload) {
  const crawlProgress = $('#crawlProgress');
  if (payload.status === 'running') {
    crawlProgress.textContent = `Syncing page ${payload.page}${payload.totalPages ? `/${payload.totalPages}` : ''}...`;
  } else if (payload.status === 'done') {
    crawlProgress.textContent = `Reached the end of the catalog (page ${payload.page}${payload.totalPages ? `/${payload.totalPages}` : ''}).`;
  } else if (payload.status === 'error') {
    crawlProgress.textContent = `Sync error: ${payload.error}`;
  }
}
