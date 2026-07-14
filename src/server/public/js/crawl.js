import { $, api, esc } from './state.js';

export function initCrawl(refreshAll) {
  const btnStartCrawl = $('#btnStartCrawl');
  const crawlProgress = $('#crawlProgress');
  const crawlResults = $('#crawlResults');
  const crawlMaxPages = $('#crawlMaxPages');

  btnStartCrawl.onclick = async () => {
    btnStartCrawl.disabled = true;
    crawlProgress.textContent = 'Starting crawl...';
    crawlResults.innerHTML = '<div class="muted">Crawling page 1. Please wait...</div>';
    
    try {
      const res = await api('/watcher/crawl', {
        method: 'POST',
        body: JSON.stringify({ maxPages: +crawlMaxPages.value || 5 })
      });
      renderCrawlResults(res.results);
    } catch (err) {
      crawlProgress.textContent = 'Crawl failed.';
      crawlResults.innerHTML = `<div class="card" style="color:var(--red)">Crawl error: ${esc(err.message)}</div>`;
    } finally {
      btnStartCrawl.disabled = false;
    }
  };

  function renderCrawlResults(results) {
    if (!results || results.length === 0) {
      crawlResults.innerHTML = '<div class="muted">No movies found in this range.</div>';
      return;
    }
    
    crawlResults.innerHTML = results.map(r => {
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
              <span class="chip-meta">${o.quality || 'unknown'} · ${codec} · ${size}</span>
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
              <span>·</span>
              <span>Found on Page ${r.pageFound}</span>
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
  const crawlResults = $('#crawlResults');
  if (payload.status === 'running') {
    crawlProgress.textContent = `Crawling page ${payload.page}/${payload.maxPages}...`;
    crawlResults.innerHTML = `<div class="muted">Crawling page ${payload.page}/${payload.maxPages}. Please wait...</div>`;
  } else if (payload.status === 'done') {
    crawlProgress.textContent = `Crawl complete. Found ${payload.resultsCount} movies.`;
  } else if (payload.status === 'error') {
    crawlProgress.textContent = `Crawl error: ${payload.error}`;
  }
}
