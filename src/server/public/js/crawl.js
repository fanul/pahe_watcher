import { $, api, esc } from './state.js';
import { missingMetadataFields } from './posts.js';

let accumulated = [];

/** Find a Historical Crawl result entry by post id — used by the shared metadata-badge popover (app.js), since crawl entries live here, not in state.posts. */
export function findAccumulatedById(id) {
  return accumulated.find((r) => String(r.id) === String(id));
}

/** Updates a crawl entry's source-incomplete flag in place (after a confirmed /mark-source-incomplete call) and re-renders. */
export function markAccumulatedSourceIncomplete(id, flag) {
  const entry = findAccumulatedById(id);
  if (entry) {
    entry.metadataSourceIncomplete = flag;
    renderCrawlResults();
  }
}

export function initCrawl(refreshAll) {
  const btnSyncAll = $('#btnSyncAll');
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

  const syncCoverageBanner = $('#syncCoverageBanner');
  const syncAllProgressBarContainer = $('#syncAllProgressBarContainer');
  const syncAllProgressBar = $('#syncAllProgressBar');
  const syncAllProgressText = $('#syncAllProgressText');

  let isSyncAllRunning = false;

  function updateProgressBar(page, totalPages, direction) {
    if (!totalPages || totalPages <= 0) return;
    let pct = 0;
    if (direction === 'older') {
      pct = Math.min(100, Math.max(0, Math.round((page / totalPages) * 100)));
    } else {
      pct = Math.min(100, Math.max(0, Math.round(((totalPages - page) / totalPages) * 100)));
    }
    if (syncAllProgressBar) syncAllProgressBar.style.width = `${pct}%`;
    if (syncAllProgressText) syncAllProgressText.textContent = `Halaman ${page} dari ${totalPages} (${pct}%)`;
  }

  refreshDeepSyncStatus();
  refreshMetadataBackfillStatus();
  refreshSeriesResyncStatus();
  refreshCursorStatus();
  refreshCoverageStatus();

  btnSyncAll?.addEventListener('click', async () => {
    if (isSyncAllRunning) {
      isSyncAllRunning = false;
      btnSyncAll.textContent = 'Menghentikan…';
      btnSyncAll.disabled = true;
      return;
    }

    isSyncAllRunning = true;
    btnSyncAll.textContent = '⏹ Stop Sync All';
    btnSyncAll.style.background = 'var(--danger, #da3633)';
    btnStartCrawl.disabled = true;
    btnResetCursor.disabled = true;
    if (syncAllProgressBarContainer) syncAllProgressBarContainer.style.display = 'block';

    let totalPagesProcessed = 0;
    let totalPagesSkipped = 0;
    let totalDiscovered = 0;
    let totalDeepSynced = 0;
    let consecutiveErrors = 0;

    try {
      // Start at page 1 (older) so selective sync catches new top posts and jumps over already-synced blocks straight to any gaps.
      await api('/sync/backfill/reset', {
        method: 'POST',
        body: JSON.stringify({ page: 1, direction: 'older' }),
      });
      crawlDirection.value = 'older';

      while (isSyncAllRunning) {
        const batchSize = +crawlMaxPages.value || 10;
        const direction = 'older';
        const deepSync = crawlDeepSync.checked;

        crawlProgress.textContent = `⚡ Sync Selektif berjalan... Memeriksa ${batchSize} halaman berikutnya (otomatis melewati blok yang sudah tersync)...`;

        let res;
        try {
          res = await api('/sync/backfill/run', {
            method: 'POST',
            body: JSON.stringify({ batchSize, direction, deepSync, selective: true }),
          });
          consecutiveErrors = 0;
        } catch (err) {
          consecutiveErrors++;
          crawlProgress.textContent = `⚠ Gangguan koneksi ke pahe.ink (${err.message}). Mencoba lagi (${consecutiveErrors}/3)...`;
          if (consecutiveErrors >= 3) {
            throw new Error(`Gagal setelah 3x percobaan: ${err.message}`);
          }
          await new Promise((r) => setTimeout(r, 3000));
          continue;
        }

        accumulated = [...res.entries, ...accumulated].slice(0, 500);
        renderCrawlResults();
        totalPagesProcessed += res.pagesProcessed || 0;
        totalPagesSkipped += res.pagesSkipped || 0;
        totalDiscovered += res.postsListed || 0;
        totalDeepSynced += res.postsDeepSynced || 0;

        const c = res.cursor;
        const currentPage = Math.min(c.page, c.totalPages || c.page);
        updateProgressBar(currentPage, c.totalPages, c.direction);

        const summary = `⚡ Sync Selektif: Hal ${currentPage}/${c.totalPages || '?'} — Diproses: ${totalPagesProcessed} hal, Dilewati/Skip: ${totalPagesSkipped} hal, +${totalDiscovered} post baru (+${totalDeepSynced} deep synced).`;
        crawlProgress.textContent = summary;
        if (syncAllProgressText && c.totalPages) {
          const pct = Math.min(100, Math.max(0, Math.round((currentPage / c.totalPages) * 100)));
          syncAllProgressText.textContent = `Hal ${currentPage}/${c.totalPages} (${pct}%) · Skip: ${totalPagesSkipped} hal · +${totalDiscovered} post`;
        }

        refreshDeepSyncStatus();
        refreshCoverageStatus();

        if (refreshAll && Math.random() < 0.3) {
          refreshAll();
        }

        if (res.done) {
          if (deepSync && isSyncAllRunning) {
            const dsStatus = await api('/sync/deep-sync/status').catch(() => null);
            let pendingDs = dsStatus?.pending || 0;
            while (pendingDs > 0 && isSyncAllRunning) {
              crawlProgress.textContent = `⚡ Halaman selesai — melengkapi deep sync untuk ${pendingDs} post yang masih shallow...`;
              const dsRes = await api('/sync/deep-sync/run', {
                method: 'POST',
                body: JSON.stringify({ batchSize: +deepSyncBatchSize.value || 20 }),
              });
              accumulated = [...dsRes.entries, ...accumulated].slice(0, 500);
              renderCrawlResults();
              totalDeepSynced += dsRes.processed || 0;
              pendingDs = dsRes.remaining || 0;
              deepSyncStatus.textContent = `Deep-synced ${dsRes.processed} post(s), ${pendingDs} still pending.`;
              if (!dsRes.processed) break;
              await new Promise((r) => setTimeout(r, 400));
            }
          }

          if (isSyncAllRunning) {
            crawlProgress.textContent = `🎉 Selesai! Diproses: ${totalPagesProcessed} hal, Dilewati/Skip: ${totalPagesSkipped} hal, +${totalDiscovered} post baru (+${totalDeepSynced} deep synced).`;
            if (syncAllProgressBar) syncAllProgressBar.style.width = '100%';
            if (syncAllProgressText) syncAllProgressText.textContent = `100% Selesai (${c.totalPages || currentPage} Halaman · Skip: ${totalPagesSkipped} hal)`;
          }
          if (refreshAll) refreshAll();
          break;
        }

        // Brief polite pause between requests to prevent rate limiting
        await new Promise((r) => setTimeout(r, 600));
      }
    } catch (err) {
      crawlProgress.textContent = `❌ Sync All terhenti: ${err.message}`;
    } finally {
      isSyncAllRunning = false;
      btnSyncAll.textContent = '⚡ Sync All (Selektif)';
      btnSyncAll.style.background = 'var(--accent, #238636)';
      btnSyncAll.disabled = false;
      btnStartCrawl.disabled = false;
      btnResetCursor.disabled = false;
      refreshCoverageStatus();
      refreshDeepSyncStatus();
      if (refreshAll) refreshAll();
    }
  });

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
      refreshCoverageStatus();
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
    refreshCoverageStatus();
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
      refreshCoverageStatus();
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
      metadataBackfillStatus.textContent = `Resynced ${res.processed} post(s), ${res.remaining} still have incomplete metadata or unresolved quality.`;
      refreshCoverageStatus();
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
      refreshCoverageStatus();
    } finally {
      btnSeriesResyncSweep.disabled = false;
    }
  };

  async function refreshCoverageStatus() {
    if (!syncCoverageBanner) return;
    const cov = await api('/sync/coverage').catch(() => null);
    if (!cov) return;

    const totalText = cov.totalPosts
      ? `${cov.localPosts.toLocaleString()} / ${cov.totalPosts.toLocaleString()} post tersimpan (${((cov.localPosts / cov.totalPosts) * 100).toFixed(1)}%)`
      : `${cov.localPosts.toLocaleString()} post tersimpan`;

    let missingHtml = '';
    if (cov.missingPosts === 0 && cov.gaps.length === 0) {
      missingHtml = `<span style="color: #3fb950; font-weight: 600;">✅ Seluruh halaman sudah tersync penuh!</span>`;
    } else if (cov.missingPosts !== null) {
      missingHtml = `<span style="color: #d29922;">Kurang ~${cov.missingPosts.toLocaleString()} post (~${cov.missingPagesEstimate} halaman belum tersync)</span>`;
    }

    let gapsHtml = '';
    if (cov.gaps.length > 0) {
      const gapDesc = cov.gaps
        .map((g) => `Hal ~${g.approxStartPage}: ${String(g.afterDate).slice(0, 10)} → ${String(g.beforeDate).slice(0, 10)} (${g.diffDays} hari)`)
        .join('; ');
      gapsHtml = `<div class="muted small" style="margin-top: 4px;">Celah terdeteksi (${cov.gaps.length}): ${esc(gapDesc)}</div>`;
    }

    syncCoverageBanner.innerHTML = `
      <div style="display: flex; justify-content: space-between; flex-wrap: wrap; gap: 8px; align-items: center;">
        <span><strong>Cakupan Sync:</strong> ${esc(totalText)}</span>
        <span>${missingHtml}</span>
      </div>
      ${gapsHtml}
    `;
  }

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
    if (res) metadataBackfillStatus.textContent = `${res.pending} post(s) with incomplete metadata or unresolved quality.`;
  }

  async function refreshCursorStatus() {
    const cursor = await api('/sync/backfill/status').catch(() => null);
    if (cursor) {
      crawlMaxPages.value = crawlMaxPages.value || 5;
      crawlDirection.value = cursor.direction || 'older';
      crawlProgress.textContent = `Cursor: page ${cursor.page}${cursor.totalPages ? `/${cursor.totalPages}` : ''} (${cursor.direction}).`;
      if (cursor.totalPages && cursor.page) {
        if (syncAllProgressBarContainer) syncAllProgressBarContainer.style.display = 'block';
        updateProgressBar(cursor.page, cursor.totalPages, cursor.direction);
      }
    }
  }
}

/** Module-scoped (not nested in initCrawl) so app.js's shared metadata-badge popover can trigger a re-render after marking/unmarking a crawl entry's source-incomplete flag. */
export function renderCrawlResults() {
  const crawlResults = $('#crawlResults');
  if (accumulated.length === 0) {
    crawlResults.innerHTML = '<div class="muted" style="padding: 10px 0;">No batches run yet. Click "Run Batch" to start syncing.</div>';
    return;
  }

  crawlResults.innerHTML = accumulated.map(r => {
    const allOpts = r.options || [];
    const hasResolvedGdLink = allOpts.some((o) => o.resolvedLinkType === 'google-drive');
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

    let metadataBadgeHtml = '';
    let metadataInfoHtml = '';
    if (r.metadataSourceIncomplete) {
      metadataBadgeHtml = `<button type="button" class="metadata-badge source-incomplete" data-metadata-badge="${r.id}" data-metadata-source="crawl" title="Manually flagged: pahe.ink's own page never had this data">ℹ Source incomplete</button>`;
    } else if (!r.metadataComplete) {
      metadataBadgeHtml = `<button type="button" class="metadata-badge incomplete" data-metadata-badge="${r.id}" data-metadata-source="crawl" title="Click to change">⚠ Incomplete metadata</button>`;
    }
    if (!r.metadataComplete) {
      metadataInfoHtml = `<button type="button" class="metadata-info-btn" data-metadata-info="${r.id}" data-metadata-source="crawl" title="Show which fields are missing">ℹ</button>`;
    }

    return `
      <div class="card${hasResolvedGdLink ? ' gd-resolved' : ''}${!r.metadataComplete ? ' metadata-incomplete' : ''}">
        ${(metadataInfoHtml || metadataBadgeHtml) ? `<div class="metadata-badge-row">${metadataInfoHtml}${metadataBadgeHtml}</div>` : ''}
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
