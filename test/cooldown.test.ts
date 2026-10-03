import './support/headless.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { JobStore, imageCooldownMs } from '../src/store.js';
import { JobQueue, CooldownError } from '../src/queue.js';
import { BrowserError, TextOnlyResponseError, ChatGPTBrowser } from '../src/browser.js';
import { createServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';

const parsed = (result: any) => JSON.parse(result.content.find((item: any) => item.type === 'text').text);

for (const errorCode of ['free_tier_exhausted', 'image_usage_limit'] as const) test(`${errorCode}: persist cooldown, reject without uploads/browser, and allow the next request after 24 hours`, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'images-cooldown-'));
  let now = Date.parse('2026-10-03T06:00:00.000Z');
  let store = new JobStore(dir, () => now);
  const browser = new ChatGPTBrowser(loadConfig({ CHATGPT_DATA_DIR: dir }));
  const calls: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  browser.generate = async (_id, prompt) => {
    calls.push(prompt);
    if (prompt === 'limit') { await gate; throw new BrowserError('Image allowance exhausted.', errorCode, 'tomorrow at 10:53 AM.'); }
    return { conversationUrl: 'https://chatgpt.com/c/new', images: [] };
  };
  browser.sessionStatus = async () => { throw new Error('Cooldown must not open/check the browser'); };
  let queue = new JobQueue(store, browser);
  let client: Client | undefined;
  let server: ReturnType<typeof createServer> | undefined;
  try {
    const existing = store.create('An already completed image');
    store.update(existing.id, { status: 'completed', images: [{ path: '/existing/image.png', mimeType: 'image/png', bytes: 123 }] });
    const limited = queue.enqueue('limit');
    const pending = queue.enqueue('waiting single');
    const batch = await queue.enqueueBatch(['waiting batch one', 'waiting batch two'], 'same_chat');
    release();
    const deadline = Date.now() + 1000;
    while (['queued', 'running'].includes(store.getBatch(batch.id).status) && Date.now() < deadline) await delay(1);
    await queue.stop();
    const cooldown = store.imageCooldown()!;
    assert.equal(cooldown.detectedAt, '2026-10-03T06:00:00.000Z');
    assert.equal(cooldown.retryAfter, '2026-10-04T06:00:00.000Z');
    queue = new JobQueue(store, browser);
    assert.equal(store.get(limited.id).errorCode, errorCode);
    assert.equal(store.get(pending.id).status, 'failed');
    assert.equal(store.get(pending.id).retryAfter, cooldown.retryAfter);
    assert.equal(store.getBatch(batch.id).jobs[0]!.status, 'failed');
    assert.equal(store.getBatch(batch.id).jobs[1]!.status, 'cancelled');
    assert.equal(store.get(existing.id).status, 'completed');
    assert.deepEqual(calls, ['limit']);

    server = createServer(store, queue, browser);
    client = new Client({ name: 'cooldown-test', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport); await client.connect(clientTransport);
    const before = store.list(100).length;
    for (const [name, args] of [
      ['generate_image', { prompt: 'blocked', reference_images: [path.join(dir, 'missing-reference.png')] }],
      ['generate_images', { prompts: ['one', 'two'], reference_images: [path.join(dir, 'missing-reference.png')] }],
      ['generate_image', { prompt: 'still blocked' }],
    ] as const) {
      const result = await client.callTool({ name, arguments: args });
      assert.equal(result.isError, true);
      const response = parsed(result);
      assert.equal(response.status, 'blocked'); assert.equal(response.errorCode, errorCode);
      assert.equal(response.detectedAt, cooldown.detectedAt); assert.equal(response.retryAfter, cooldown.retryAfter);
    }
    const session = parsed(await client.callTool({ name: 'session_status', arguments: {} }));
    assert.equal(session.status, 'usage_limit'); assert.equal(session.retryAfter, cooldown.retryAfter);
    assert.equal(store.list(100).length, before, 'Blocked requests must not admit new jobs');
    assert.equal((await readdir(dir)).includes('references'), false, 'Do not snapshot files during cooldown');
    assert.deepEqual(store.imageCooldown(), cooldown, 'Repeated requests must not extend cooldown');
    await client.close(); client = undefined; await server.close(); server = undefined;
    await queue.stop(); store.close();

    now += imageCooldownMs - 1;
    store = new JobStore(dir, () => now); queue = new JobQueue(store, browser);
    assert.deepEqual(store.imageCooldown(), cooldown, 'Cooldown survives restart and lasts the full 24 hours');
    assert.throws(() => queue.enqueue('one millisecond early'), CooldownError);
    now++;
    assert.equal(store.imageCooldown(), undefined);
    const fresh = queue.enqueue('new request after cooldown'); await queue.stop();
    assert.equal(store.get(fresh.id).status, 'completed');
    assert.deepEqual(calls, ['limit', 'new request after cooldown'], 'Failed and cancelled requests are never replayed');
  } finally {
    release(); await client?.close(); await server?.close(); await queue.stop(); store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('upgrade seeds cooldown from a prior quota failure without moving the detection time on later restarts', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'images-cooldown-upgrade-'));
  let store = new JobStore(dir);
  try {
    const job = store.create('Old quota job');
    const failed = store.update(job.id, { status: 'failed', errorCode: 'free_tier_exhausted', error: 'Free plan exhausted.', limitReset: 'tomorrow' });
    store.close(); store = new JobStore(dir);
    const cooldown = store.imageCooldown()!;
    assert.equal(cooldown.detectedAt, failed.updatedAt);
    assert.equal(Date.parse(cooldown.retryAfter) - Date.parse(cooldown.detectedAt), imageCooldownMs);
    assert.equal(store.get(job.id).retryAfter, cooldown.retryAfter);
    store.close(); store = new JobStore(dir);
    assert.deepEqual(store.imageCooldown(), cooldown);
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});

test('browser errors without an image-usage code do not trigger cooldown', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'images-no-cooldown-'));
  const store = new JobStore(dir);
  const calls: string[] = [];
  const queue = new JobQueue(store, { async generate(_id, prompt) {
    calls.push(prompt); if (prompt === 'timeout') throw new BrowserError('Timed out waiting for an image.');
    return { conversationUrl: 'https://chatgpt.com/c/new', images: [] };
  } });
  try {
    const timedOut = queue.enqueue('timeout');
    const pending = queue.enqueue('another request');
    await queue.stop();
    assert.equal(store.get(timedOut.id).status, 'failed');
    assert.equal(store.imageCooldown(), undefined);
    const resumed = new JobQueue(store, { async generate() { calls.push('another request'); return { images: [] }; } });
    resumed.kick(); await resumed.stop();
    assert.equal(store.get(pending.id).status, 'completed');
    assert.deepEqual(calls, ['timeout', 'another request']);
  } finally { await queue.stop(); store.close(); await rm(dir, { recursive: true, force: true }); }
});

test('text-only streak survives restart, records cooldown on the second failure, and expires after 24 hours', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'images-text-only-'));
  let now = Date.parse('2026-10-03T06:00:00.000Z');
  let store = new JobStore(dir, () => now);
  let calls = 0;
  const browser = { async generate(): Promise<never> { calls++; throw new TextOnlyResponseError(); } };
  let queue = new JobQueue(store, browser);
  try {
    const first = queue.enqueue('first'); await queue.stop();
    assert.equal(store.get(first.id).status, 'failed');
    assert.equal(store.get(first.id).errorCode, undefined);
    assert.equal(store.imageCooldown(), undefined);
    store.close(); store = new JobStore(dir, () => now); queue = new JobQueue(store, browser);
    const second = queue.enqueue('second'); await queue.stop();
    const cooldown = store.imageCooldown()!;
    assert.equal(calls, 2);
    assert.equal(store.get(second.id).errorCode, 'image_usage_limit');
    assert.equal(store.get(second.id).retryAfter, cooldown.retryAfter);
    assert.equal(cooldown.detectedAt, '2026-10-03T06:00:00.000Z');
    store.close(); store = new JobStore(dir, () => now); queue = new JobQueue(store, browser);
    assert.deepEqual(store.imageCooldown(), cooldown);
    assert.throws(() => queue.enqueue('blocked'), CooldownError);
    now += 60 * 60 * 1000;
    assert.throws(() => queue.enqueue('one hour is still too early'), CooldownError);
    assert.deepEqual(store.imageCooldown(), cooldown);
    now += imageCooldownMs - 60 * 60 * 1000;
    const next = queue.enqueue('after cooldown'); await queue.stop();
    assert.equal(store.get(next.id).errorCode, undefined, 'Expired streak begins at one again');
    assert.equal(store.imageCooldown(), undefined);
    assert.equal(calls, 3);
  } finally { await queue.stop(); store.close(); await rm(dir, { recursive: true, force: true }); }
});
