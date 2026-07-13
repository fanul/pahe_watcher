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
      return `<div class="card">
        <div class="title">${esc(r.title)}</div>
        <div class="meta">Found on <b>Page ${r.pageFound}</b> · <a href="${r.link}" target="_blank" rel="noopener">post ↗</a></div>
        <div class="actions">
          <button class="btn small" data-resolve-post="${r.id}">Resolve preferred</button>
        </div>
      </div>`;
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
