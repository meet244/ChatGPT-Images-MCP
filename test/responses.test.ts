import './support/headless.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { loadConfig, cli } from '../src/config.js';
import { ChatGPTBrowser } from '../src/browser.js';
import { AccountManager, AccountRegistry } from '../src/accounts.js';
import { JobStore } from '../src/store.js';
import { JobQueue } from '../src/queue.js';
import { createServer } from '../src/server.js';
import { saveCookies } from '../src/session-store.js';

test('all eleven tools return only useful public fields, keeping routing and full jobs private', { timeout: 5000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'images-compact-responses-'));
  const config = loadConfig({ CHATGPT_DATA_DIR: dir, CHATGPT_AUTO_SWITCH_ACCOUNTS: 'false' });
  const registry = new AccountRegistry(config);
  await registry.add('default');
  await saveCookies(dir, [{ name: '__Secure-next-auth.session-token', value: 'fixture-session', domain: '.chatgpt.com', path: '/', expires: -1 }]);
  const store = new JobStore(dir);
  const browser = new ChatGPTBrowser(config);
  const bytes = await sharp({ create: { width: 300, height: 300, channels: 3, background: '#0066cc' } }).png().toBuffer();
  const imagePath = path.join(dir, 'result.png');
  await writeFile(imagePath, bytes);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  browser.sessionStatus = async () => ({ status: 'ready', message: 'Verbose readiness explanation' });
  browser.shutdown = async () => {};
  browser.generate = async (id, _prompt, submitted) => {
    submitted(`https://chatgpt.com/c/${id}`);
    await gate;
    return { conversationUrl: `https://chatgpt.com/c/${id}`, images: [{ path: imagePath, bytes: bytes.length, mimeType: 'image/png' }] };
  };
  const queue = new JobQueue(store, browser);
  const accounts = new AccountManager(registry, { account: 'default', store, browser, queue });
  const server = createServer(store, queue, browser, accounts);
  const client = new Client({ name: 'compact-responses-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const results: unknown[] = [];
  const call = async (name: string, arguments_: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: arguments_ });
    const text = result.content.find(item => item.type === 'text')!;
    assert.equal(text.type, 'text');
    const value = JSON.parse(text.text);
    assert.equal(text.text, JSON.stringify(value), 'Responses use compact JSON');
    results.push(value);
    return { value, result };
  };
  const keys = (value: object, expected: string[]) => assert.deepEqual(Object.keys(value).sort(), expected.sort());
  try {
    await server.connect(serverTransport); await client.connect(clientTransport);
    assert.deepEqual((await call('session_status')).value, { status: 'ready' });
    const admitted = (await call('generate_image', { prompt: 'private-prompt-fixture' })).value;
    keys(admitted, ['id', 'status']);
    const queued = (await call('generate_image', { prompt: 'cancel private prompt' })).value;
    const running = (await call('get_job_status', { job_id: admitted.id })).value;
    keys(running, ['id', 'status', 'updatedAt']);
    assert.equal(running.status, 'running');
    assert.deepEqual((await call('session_status')).value, { status: 'busy' });
    const pending = await call('wait_for_job', { job_id: admitted.id, wait_seconds: 0 });
    assert.deepEqual(pending.value, { status: running.status, updatedAt: running.updatedAt });
    assert.equal(pending.result.content.length, 1);
    assert.deepEqual((await call('cancel_job', { job_id: queued.id })).value, { id: queued.id, status: 'cancelled' });
    release();
    const completed = await call('wait_for_job', { job_id: admitted.id });
    assert.deepEqual(completed.value, { status: 'completed', updatedAt: store.get(admitted.id).updatedAt });
    assert.equal(completed.result.content.length, 1, 'Completed waits also exclude previews');
    // Internal state is retained for generation and recovery, despite the projection.
    assert.equal(store.get(admitted.id).prompt, 'private-prompt-fixture');
    assert.equal(store.get(admitted.id).executionAccount, 'default');
    assert.ok(store.get(admitted.id).conversationUrl);
    const image = await call('get_image', { job_id: admitted.id });
    assert.deepEqual(image.value, { path: imagePath });
    assert.equal(image.result.content.some(item => item.type === 'image'), true);
    const batch = (await call('generate_images', { prompts: ['private batch one', 'private batch two'] })).value;
    keys(batch, ['id', 'status', 'jobs']);
    batch.jobs.forEach((job: object) => keys(job, ['id', 'status']));
    while (['queued', 'running'].includes(store.getBatch(batch.id).status)) await delay(10);
    const progress = (await call('get_batch_status', { batch_id: batch.id })).value;
    keys(progress, ['id', 'status', 'jobs']);
    assert.equal(progress.status, 'completed');
    progress.jobs.forEach((job: object) => keys(job, ['id', 'status']));
    const failed = store.create('private failed prompt');
    const retryAfter = new Date(Date.now() + 60_000).toISOString();
    store.update(failed.id, { status: 'failed', error: 'Useful failure explanation', retryAfter,
      errorCode: 'image_usage_limit', executionAccount: 'default', previousAttempts: [] });
    const failure = (await call('wait_for_job', { job_id: failed.id })).value;
    assert.deepEqual(failure, { status: 'failed', updatedAt: store.get(failed.id).updatedAt,
      error: 'Useful failure explanation', retryAfter });
    const history = (await call('list_jobs')).value;
    keys(history, ['jobs']);
    for (const job of history.jobs) keys(job, job.status === 'failed'
      ? ['id', 'status', 'updatedAt', 'error', 'retryAfter'] : ['id', 'status', 'updatedAt']);
    const created = (await call('add_account', { account: 'work' })).value;
    assert.deepEqual(created, { account: 'work', status: 'login_required', message: `Run ${cli('manage-accounts')} in a terminal, select work and sign in.` });
    const profiles = (await call('list_accounts')).value;
    keys(profiles, ['active_account', 'accounts']);
    profiles.accounts.forEach((account: object) => keys(account, ['account', 'has_saved_session']));
    store.recordImageLimit('image_usage_limit', 'Long private quota explanation');
    const limited = (await call('session_status')).value;
    assert.deepEqual(limited, { status: 'usage_limit', retryAfter: store.imageCooldown()!.retryAfter });
    const blocked = await call('generate_image', { prompt: 'never queued private prompt' });
    assert.equal(blocked.result.isError, true);
    keys(blocked.value, ['status', 'error', 'retryAfter']);
    assert.doesNotMatch(JSON.stringify(results), /private-prompt-fixture|private batch|private failed|executionAccount|attemptedAccounts|previousAttempts|referenceImages|autoSwitchAccount|createdAt|mimeType|conversationUrl|Long private quota/);
  } finally {
    release(); await client.close(); await server.close(); await accounts.close();
    await rm(dir, { recursive: true, force: true });
  }
});
