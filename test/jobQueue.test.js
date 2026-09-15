import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Store } from '../src/core/store.js';
import { JobQueue, JobStatus } from '../src/queue/jobQueue.js';

function tmpQueue() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pahe-jobqueue-test-'));
  const store = new Store({ sqlitePath: path.join(dir, 'test.db'), jsonPath: path.join(dir, 'nonexistent-state.json') });
  const queue = new JobQueue({ store, concurrency: 1, maxRetries: 3 });
  return { queue, store, dir };
}

function cleanup(t, dir, store) {
  t.after(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

function waitForStatus(store, jobId, statuses, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      const job = store.getJob(jobId);
      if (job && statuses.includes(job.status)) return resolve(job);
      if (Date.now() - start > timeoutMs) return reject(new Error(`Timed out waiting for status in [${statuses}], got "${job?.status}"`));
      setTimeout(check, 10);
    };
    check();
  });
}

test('JobQueue: a checkpoint reached this attempt survives an unrelated failure at a later, non-checkpoint stage', async (t) => {
  // Regression: an attempt that resumed straight from a gdflix.io checkpoint,
  // then made real further progress (through GDFlix, all the way to a
  // Google sign-in page — not itself a checkpoint host) before failing
  // there, used to have its checkpoint wiped because the checkpoint VALUE
  // never changed during that attempt. That forced the next retry back
  // through intercelestial.com's flaky ad-gate from scratch, even though
  // the gdflix.io checkpoint was still perfectly valid.
  const { queue, store, dir } = tmpQueue();
  cleanup(t, dir, store);

  queue.setProcessor(async (job, ctx) => {
    if (job.attempts === 1) {
      ctx.setCheckpoint('https://new4.gdflix.io/file/xyz');
      throw new Error('Anti-automation wall detected');
    }
    // Second attempt: resumed from the checkpoint, fails again at an
    // unrelated later stage (Google sign-in) without ever setting a NEW
    // checkpoint value.
    assert.equal(job.checkpointUrl, 'https://new4.gdflix.io/file/xyz', 'attempt 2 must resume from the checkpoint set by attempt 1');
    throw new Error('Google sign-in wall could not be bypassed');
  });

  const job = queue.enqueue({ url: 'https://intercelestial.com/entry', title: 'Test', provider: 'GD', quality: '720p' });

  await waitForStatus(store, job.id, [JobStatus.QUEUED], 2000).catch(() => {}); // attempt 1 failing → requeued
  await waitForStatus(store, job.id, [JobStatus.FAILED, JobStatus.DONE], 2000);

  const finalJob = store.getJob(job.id);
  assert.equal(finalJob.checkpointUrl, 'https://new4.gdflix.io/file/xyz', 'checkpoint from attempt 1 must survive attempt 2s unrelated failure');
});

test('JobQueue: checkpoint is cleared once the job actually succeeds', async (t) => {
  const { queue, store, dir } = tmpQueue();
  cleanup(t, dir, store);

  queue.setProcessor(async (job, ctx) => {
    ctx.setCheckpoint('https://ouo.io/abc123');
    return { finalUrl: 'https://drive.google.com/file/d/xyz/view', linkType: 'google-drive' };
  });

  const job = queue.enqueue({ url: 'https://intercelestial.com/entry', title: 'Test', provider: 'GD', quality: '720p' });
  await waitForStatus(store, job.id, [JobStatus.DONE]);

  const finalJob = store.getJob(job.id);
  assert.equal(finalJob.checkpointUrl, null, 'a completed job should not carry a stale checkpoint forward');
});

test('JobQueue: a confirmed-dead link still clears the checkpoint (job will never retry anyway)', async (t) => {
  const { queue, store, dir } = tmpQueue();
  cleanup(t, dir, store);

  queue.setProcessor(async (job, ctx) => {
    ctx.setCheckpoint('https://ouo.io/expired-link');
    throw Object.assign(new Error('Dead link detected'), { dead: true });
  });

  const job = queue.enqueue({ url: 'https://intercelestial.com/entry', title: 'Test', provider: 'GD', quality: '720p' });
  await waitForStatus(store, job.id, [JobStatus.DEAD]);

  const finalJob = store.getJob(job.id);
  assert.equal(finalJob.checkpointUrl, null);
});
