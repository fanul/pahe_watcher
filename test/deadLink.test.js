import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { isDeadLinkPage } from '../src/bypass/deadLinkPatterns.js';
import { Store } from '../src/core/store.js';
import { JobQueue, JobStatus } from '../src/queue/jobQueue.js';

test('isDeadLinkPage matches common "file removed/expired" phrasing', () => {
  const shouldMatch = [
    'Sorry, this file has been removed.',
    'The file was not found on this server.',
    'This file no longer exists.',
    'Link expired — please request a new one.',
    'File removed due to copyright infringement.',
    'This video has been removed for violating our Terms of Service.',
    'File deleted by the owner.',
    '404 - Not Found',
  ];
  for (const text of shouldMatch) {
    assert.equal(isDeadLinkPage(text), true, `expected "${text}" to be detected as dead`);
  }
});

test('isDeadLinkPage does not false-positive on ordinary page text', () => {
  const shouldNotMatch = [
    'Welcome to GDFlix — click the download button below.',
    'Your download will begin shortly.',
    '',
    null,
    undefined,
    'Please solve the captcha to continue.',
  ];
  for (const text of shouldNotMatch) {
    assert.equal(isDeadLinkPage(text), false, `expected "${text}" to NOT be detected as dead`);
  }
});

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pahe-deadlink-test-'));
  const store = new Store({ sqlitePath: path.join(dir, 'test.db'), jsonPath: path.join(dir, 'no.json') });
  return { store, dir };
}

test('a {dead:true} processor error lands the job on JobStatus.DEAD without retrying', async (t) => {
  const { store, dir } = tmpStore();
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  const queue = new JobQueue({ store, concurrency: 1, maxRetries: 2 });
  queue.setProcessor(async () => {
    throw Object.assign(new Error('Dead link detected'), { dead: true });
  });
  queue.hydrate();

  const job = queue.enqueue({ url: 'https://x', provider: 'GD', quality: '1080p', title: 't', postLink: 'https://pahe.ink/p' });
  await new Promise((resolve) => {
    const check = () => {
      const fresh = store.getJob(job.id);
      if (fresh.status !== JobStatus.RUNNING && fresh.status !== JobStatus.QUEUED) return resolve();
      setTimeout(check, 10);
    };
    check();
  });

  const fresh = store.getJob(job.id);
  assert.equal(fresh.status, JobStatus.DEAD);
  assert.equal(fresh.attempts, 1); // never requeued, unlike a normal transient failure
});

test('retry() allows manually overriding a dead job (unlike retryAll, which excludes it)', async (t) => {
  const { store, dir } = tmpStore();
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  const queue = new JobQueue({ store, concurrency: 1, maxRetries: 2 });
  queue.setProcessor(async () => 'ok');
  queue.setPaused(true); // prevent _drain() from immediately running the requeued job — isolates retry()'s status transition
  store.upsertJob({
    id: 'dead-1', status: JobStatus.DEAD, attempts: 1, createdAt: 'd', updatedAt: 'd',
    postLink: 'https://pahe.ink/p', title: 't',
  });

  assert.equal(queue.retry('dead-1'), true);
  assert.equal(store.getJob('dead-1').status, JobStatus.QUEUED);
});
