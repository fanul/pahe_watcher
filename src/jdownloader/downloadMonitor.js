import { createLogger } from '../core/logger.js';
import { bus } from '../core/eventBus.js';

const log = createLogger('jdownloader:monitor');
const POLL_INTERVAL_MS = 20_000;

/**
 * Polls JDownloader for the real download progress of jobs that were
 * pushed to it — not just whether the push itself succeeded, but whether
 * the file has actually finished downloading, how far along it is, and
 * where JDownloader saved it. Matches by package name, since that's the
 * only handle addLink() gets back synchronously (linkgrabberV2.addLinks
 * doesn't return a package/link UUID — the package only exists once
 * JDownloader's crawler has actually processed the link).
 */
export function startJdownloaderMonitor({ jdownloader, store }) {
  const timer = setInterval(() => {
    pollOnce({ jdownloader, store }).catch((err) => log.warn(`Poll failed: ${err.message}`));
  }, POLL_INTERVAL_MS);
  return { stop: () => clearInterval(timer) };
}

async function pollOnce({ jdownloader, store }) {
  if (!jdownloader.enabled) return;

  const trackedJobs = store
    .listJobs()
    .filter((j) => j.result?.jdownloaderPushed === true && j.result?.jdownloaderStatus !== 'finished');
  if (trackedJobs.length === 0) return;

  const packages = await jdownloader.listDownloadPackages();

  for (const job of trackedJobs) {
    const pkg = packages.find((p) => p.name === job.title);
    if (!pkg) continue; // not crawled/started yet — leave as "pushed, no status" for now

    const progress = pkg.bytesTotal ? Math.round((pkg.bytesLoaded / pkg.bytesTotal) * 100) : 0;
    const status = pkg.finished ? 'finished' : pkg.running ? 'running' : 'queued';

    const prev = job.result;
    if (prev.jdownloaderStatus === status && prev.jdownloaderProgress === progress && prev.jdownloaderSaveTo === pkg.saveTo) {
      continue; // no change — don't spam job:updated for nothing
    }

    job.result = {
      ...prev,
      jdownloaderStatus: status,
      jdownloaderProgress: progress,
      jdownloaderSaveTo: pkg.saveTo || prev.jdownloaderSaveTo || null,
    };
    store.upsertJob(job);
    bus.emit('job:updated', job);
  }
}

export default startJdownloaderMonitor;
