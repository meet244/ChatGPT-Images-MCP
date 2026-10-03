import './support/headless.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { JobQueue } from '../src/queue.js';
import { JobStore } from '../src/store.js';
import { ChatGPTBrowser, BrowserError } from '../src/browser.js';
import { loadConfig } from '../src/config.js';

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Browser cleanup fixture did not finish');
    await delay(5);
  }
}

test('status checks close before returning and queued images wait for that closure', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'images-status-close-'));
  const store = new JobStore(dir), events: string[] = [];
  const browser = new ChatGPTBrowser(loadConfig({ CHATGPT_DATA_DIR: dir }));
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let closes = 0;
  browser.sessionStatus = async () => { events.push('check'); return { status: 'ready', message: 'Ready' }; };
  browser.shutdown = async () => {
    events.push('close');
    if (++closes === 1) await gate;
    events.push('closed');
  };
  browser.generate = async () => { events.push('generate'); return { images: [], conversationUrl: 'https://chatgpt.com/c/test' }; };
  const queue = new JobQueue(store, browser);
  const check = queue.inspectSession(browser);
  try {
    await until(() => events.includes('close'));
    const job = queue.enqueue('next image');
    assert.equal((await queue.inspectSession(browser)).status, 'busy');
    await delay(20);
    assert.deepEqual(events, ['check', 'close']);
    assert.equal(store.get(job.id).status, 'queued');
    release();
    assert.equal((await check).status, 'ready');
    await until(() => !queue.isBusy());
    assert.deepEqual(events, ['check', 'close', 'closed', 'generate', 'close', 'closed']);
  } finally { release(); await check; await queue.stop(); store.close(); await rm(dir, { recursive: true, force: true }); }
});

test('throwing status checks also close the browser and allow later requests', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'images-status-error-close-'));
  const store = new JobStore(dir);
  const browser = new ChatGPTBrowser(loadConfig({ CHATGPT_DATA_DIR: dir }));
  let closes = 0;
  browser.sessionStatus = async () => { throw new BrowserError('Fixture verification failed'); };
  browser.shutdown = async () => { closes++; };
  const queue = new JobQueue(store, browser);
  try {
    await assert.rejects(queue.inspectSession(browser), /Fixture verification failed/);
    assert.equal(closes, 1);
    await until(() => !queue.isBusy());
    browser.sessionStatus = async () => ({ status: 'ready', message: 'Ready' });
    assert.equal((await queue.inspectSession(browser)).status, 'ready');
    assert.equal(closes, 2);
  } finally { await queue.stop(); store.close(); await rm(dir, { recursive: true, force: true }); }
});

test('queued images share one open browser; a request arriving during shutdown waits and then reopens', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'images-idle-close-'));
  const store = new JobStore(dir), events: string[] = [];
  let releaseFirst!: () => void, releaseClose!: () => void;
  const first = new Promise<void>(resolve => { releaseFirst = resolve; });
  const closing = new Promise<void>(resolve => { releaseClose = resolve; });
  let closes = 0;
  const queue = new JobQueue(store, {
    generate: async (_id, prompt) => {
      events.push(prompt);
      if (prompt === 'first') await first;
      return { images: [] };
    },
    shutdown: async () => {
      events.push('close');
      if (++closes === 1) await closing;
      events.push('closed');
    },
  });
  try {
    const one = queue.enqueue('first'), two = queue.enqueue('second');
    assert.equal(closes, 0);
    releaseFirst();
    await until(() => events.includes('close'));
    assert.deepEqual(events, ['first', 'second', 'close']);
    assert.equal(store.get(one.id).status, 'completed');
    assert.equal(store.get(two.id).status, 'completed');
    const three = queue.enqueue('third');
    await delay(20);
    assert.equal(store.get(three.id).status, 'queued');
    assert.equal(events.includes('third'), false);
    releaseClose();
    await until(() => !queue.isBusy());
    assert.deepEqual(events, ['first', 'second', 'close', 'closed', 'third', 'close', 'closed']);
    assert.equal(store.get(three.id).status, 'completed');
  } finally { releaseFirst(); releaseClose(); await queue.stop(); store.close(); await rm(dir, { recursive: true, force: true }); }
});

test('browser shutdown failure never changes an already completed image into a failed job', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'images-close-failure-'));
  const store = new JobStore(dir);
  const queue = new JobQueue(store, {
    generate: async () => ({ images: [], conversationUrl: 'https://chatgpt.com/c/saved' }),
    shutdown: async () => { throw new Error('Fixture shutdown failed'); },
  });
  try {
    const job = queue.enqueue('Save before closing');
    await until(() => !queue.isBusy());
    assert.equal(store.get(job.id).status, 'completed');
    assert.equal(store.get(job.id).conversationUrl, 'https://chatgpt.com/c/saved');
    assert.equal(store.get(job.id).error, undefined);
  } finally { await queue.stop(); store.close(); await rm(dir, { recursive: true, force: true }); }
});
