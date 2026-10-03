import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { normalizeCookies } from '../src/cookies.js';
import { loadConfig, projectRoot } from '../src/config.js';
import { JobStore } from '../src/store.js';
import { JobQueue } from '../src/queue.js';
import { acquireRuntime } from '../src/runtime.js';

test('cookie import normalizes browser exports and excludes unrelated and expired cookies', () => {
  const cookies = normalizeCookies({ cookies: [
    { name: 'session', value: 'private', domain: '.chatgpt.com', expirationDate: Date.now() / 1000 + 3600, sameSite: 'no_restriction', httpOnly: true },
    { name: 'auth', value: 'private', url: 'https://auth.openai.com/', sameSite: 'strict', session: true },
    { name: 'other', value: 'never-import', domain: 'example.com' },
    { name: 'spoof', value: 'never-import', domain: 'evilchatgpt.com' },
    { name: 'spoof', value: 'never-import', domain: 'chatgpt.com.evil.com' },
    { name: 'expired', value: 'old', domain: 'chatgpt.com', expires: 1 },
  ] });
  assert.equal(cookies.length, 2);
  assert.equal(cookies[0]?.sameSite, 'None');
  assert.equal(cookies[0]?.secure, true);
  assert.equal(cookies[1]?.expires, -1);
  assert.equal(cookies[1]?.domain, 'auth.openai.com');
});

test('invalid cookie imports fail without exposing values', () => {
  for (const input of [null, {}, [], [{ name: 'session', value: 'secret', domain: 'chatgpt.com', sameSite: 'secret' }]]) {
    assert.throws(() => normalizeCookies(input), error => error instanceof Error && !error.message.includes('secret'));
  }
});

test('config paths are stable regardless of the MCP client working directory', () => {
  const config = loadConfig({ CHATGPT_DATA_DIR: 'custom', CHATGPT_COOKIES_FILE: 'cookies.json' });
  assert.equal(config.dataDir, path.join(projectRoot, 'custom'));
  assert.equal(config.cookiesFile, path.join(projectRoot, 'cookies.json'));
  assert.throws(() => loadConfig({ CHATGPT_TIMEOUT_MS: 'NaN' }));
  assert.throws(() => loadConfig({ CHATGPT_HEADLESS: 'maybe' }));
});

test('queue serializes requests, cancels pending work, and keeps running after a failure', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'images-queue-'));
  const store = new JobStore(dir);
  const calls: string[] = [];
  let concurrent = 0;
  let maxConcurrent = 0;
  let unblock!: () => void;
  const gate = new Promise<void>(resolve => { unblock = resolve; });
  const queue = new JobQueue(store, { async generate(id, prompt, submitted) {
    concurrent++;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    calls.push(prompt);
    submitted(`https://chatgpt.com/c/${id}`);
    try {
      if (prompt === 'first') await gate;
      if (prompt === 'failure') throw new Error('Expected generation failure');
      return { conversationUrl: `https://chatgpt.com/c/${id}`, images: [] };
    } finally { concurrent--; }
  } });
  try {
    const first = queue.enqueue('first');
    const cancelled = queue.enqueue('cancelled');
    const failure = queue.enqueue('failure');
    const last = queue.enqueue('last');
    assert.equal(store.get(first.id).status, 'running');
    for (const pending of [cancelled, failure, last]) assert.equal(store.get(pending.id).status, 'queued');
    assert.deepEqual(calls, ['first']);
    queue.cancel(cancelled.id);
    assert.throws(() => queue.cancel(first.id), /Only queued/);
    unblock();
    const deadline = Date.now() + 3000;
    while (store.get(last.id).status !== 'completed' && Date.now() < deadline) await delay(10);
    assert.equal(maxConcurrent, 1);
    assert.deepEqual(calls, ['first', 'failure', 'last']);
    assert.equal(store.get(first.id).status, 'completed');
    assert.equal(store.get(cancelled.id).status, 'cancelled');
    assert.equal(store.get(failure.id).status, 'failed');
    assert.equal(store.get(last.id).status, 'completed');
  } finally { unblock(); await queue.stop(); store.close(); await rm(dir, { recursive: true, force: true }); }
});

test('a request arriving while an idle worker finishes is not stranded in the queue', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'images-idle-queue-'));
  const store = new JobStore(dir);
  const calls: string[] = [];
  const queue = new JobQueue(store, { async generate(id, prompt) {
    calls.push(prompt);
    return { conversationUrl: `https://chatgpt.com/c/${id}`, images: [] };
  } });
  try {
    queue.kick();
    const job = queue.enqueue('arrived during idle transition');
    const deadline = Date.now() + 3000;
    while (store.get(job.id).status !== 'completed' && Date.now() < deadline) await delay(10);
    assert.equal(store.get(job.id).status, 'completed');
    assert.deepEqual(calls, ['arrived during idle transition']);
  } finally { await queue.stop(); store.close(); await rm(dir, { recursive: true, force: true }); }
});

test('restart preserves queued jobs and marks interrupted jobs failed without resubmitting', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'images-store-'));
  let store = new JobStore(dir);
  try {
    const pending = store.create('pending');
    const running = store.create('running');
    store.update(running.id, { status: 'running', conversationUrl: 'https://chatgpt.com/c/existing' });
    store.close();
    store = new JobStore(dir);
    assert.equal(store.get(pending.id).status, 'queued');
    assert.equal(store.get(running.id).status, 'failed');
    assert.equal(store.get(running.id).conversationUrl, 'https://chatgpt.com/c/existing');
    assert.match(store.get(running.id).error!, /Check the ChatGPT conversation/);
    assert.throws(() => store.get("' OR 1=1 --"), /Job not found/);
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});

test('runtime lock prevents simultaneous use and releases cleanly', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'images-lock-'));
  const config = loadConfig({ CHATGPT_DATA_DIR: dir });
  const release = await acquireRuntime(config);
  try { await assert.rejects(acquireRuntime(config), /in use/); }
  finally { await release(); }
  const secondRelease = await acquireRuntime(config);
  await secondRelease();
  await rm(dir, { recursive: true, force: true });
});
