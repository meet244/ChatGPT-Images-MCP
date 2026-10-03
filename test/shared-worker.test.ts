import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createConnection } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import lockfile from 'proper-lockfile';
import sharp from 'sharp';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { loadConfig, projectRoot } from '../src/config.js';
import { ChatGPTBrowser } from '../src/browser.js';
import { JobStore } from '../src/store.js';
import { startSharedWorker } from '../src/shared-worker.js';

const names = ['add_account', 'cancel_job', 'generate_image', 'generate_images', 'get_batch_status', 'get_image', 'get_job_status', 'list_accounts', 'list_jobs', 'session_status', 'use_account', 'wait_for_job'];
function clientFor(dir: string) {
  const client = new Client({ name: 'shared-worker-test', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(projectRoot, 'dist/index.js'), 'serve'],
    cwd: os.tmpdir(), env: { CHATGPT_DATA_DIR: dir }, stderr: 'pipe' });
  // Drain diagnostics without logging private local paths or input.
  transport.stderr?.on('data', () => {});
  return { client, transport };
}
function parsed(result: any): any {
  assert.equal(result.isError, undefined, JSON.stringify(result.content));
  return JSON.parse(result.content.find((item: any) => item.type === 'text').text);
}
async function until(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error('Worker did not reach the expected state.');
    await delay(20);
  }
}

test('simultaneous stdio clients start one worker, discover twelve tools, and share saved images', { timeout: 15_000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'images-worker-start-'));
  const config = loadConfig({ CHATGPT_DATA_DIR: dir });
  const seed = new JobStore(dir);
  const imagePath = path.join(dir, 'existing.png');
  const bytes = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#ff4400' } }).png().toBuffer();
  await writeFile(imagePath, bytes);
  const job = seed.create('Previously generated fixture');
  seed.update(job.id, { status: 'completed', images: [{ path: imagePath, mimeType: 'image/png', bytes: bytes.length }] });
  seed.close();
  // A crashed worker's endpoint must not prevent a new worker from starting.
  await writeFile(path.join(dir, 'worker.json'), JSON.stringify({ version: 1, port: 1, pid: 0, token: '0'.repeat(64) }), { mode: 0o600 });
  const first = clientFor(dir), second = clientFor(dir);
  try {
    await Promise.all([first.client.connect(first.transport), second.client.connect(second.transport)]);
    for (const { client } of [first, second]) {
      assert.deepEqual((await client.listTools()).tools.map(tool => tool.name).sort(), names);
      assert.equal(parsed(await client.callTool({ name: 'list_jobs', arguments: {} })).jobs[0].id, job.id);
    }
    const endpoint = JSON.parse(await readFile(path.join(dir, 'worker.json'), 'utf8'));
    assert.ok(endpoint.pid > 0);
    assert.equal((await stat(path.join(dir, 'worker.json'))).mode & 0o777, 0o600);
    assert.equal((await stat(dir)).mode & 0o777, 0o700);
    await first.client.close();
    assert.equal(await lockfile.check(dir, { stale: 30_000 }), true, 'Other client still owns its connection to the shared worker');
    assert.equal(JSON.parse(await readFile(path.join(dir, 'worker.json'), 'utf8')).pid, endpoint.pid);
    const image = parsed(await second.client.callTool({ name: 'get_image', arguments: { job_id: job.id, include_preview: false } }));
    assert.equal(image.path, imagePath);
    const waited = parsed(await second.client.callTool({ name: 'wait_for_job', arguments: { job_id: job.id, include_preview: false } }));
    assert.equal(waited.status, 'completed');
    assert.equal(waited.image.path, imagePath);
    await second.client.close();
    await until(async () => !await lockfile.check(config.dataDir, { stale: 30_000 }));
    await assert.rejects(readFile(path.join(dir, 'worker.json')), { code: 'ENOENT' });
  } finally {
    await Promise.allSettled([first.client.close(), second.client.close()]);
    await until(async () => !await lockfile.check(dir, { stale: 30_000 }));
    await rm(dir, { recursive: true, force: true });
  }
});

test('clients share one FIFO browser queue; accepted jobs finish after both clients disconnect', { timeout: 15_000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'images-worker-queue-'));
  const config = loadConfig({ CHATGPT_DATA_DIR: dir });
  const browser = new ChatGPTBrowser(config);
  let releaseFirst!: () => void, releaseSecond!: () => void;
  const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
  const secondGate = new Promise<void>(resolve => { releaseSecond = resolve; });
  const calls: string[] = [];
  let active = 0, maximumActive = 0;
  browser.generate = async (id, prompt, submitted) => {
    calls.push(prompt); maximumActive = Math.max(maximumActive, ++active);
    submitted(`https://chatgpt.com/c/${id}`);
    try { await (prompt === 'first' ? firstGate : secondGate); return { images: [] }; }
    finally { active--; }
  };
  const worker = await startSharedWorker(config, { browser, idleMs: 30 });
  const first = clientFor(dir), second = clientFor(dir);
  try {
    await Promise.all([first.client.connect(first.transport), second.client.connect(second.transport)]);
    const one = parsed(await first.client.callTool({ name: 'generate_image', arguments: { prompt: 'first' } }));
    const two = parsed(await second.client.callTool({ name: 'generate_image', arguments: { prompt: 'second' } }));
    assert.deepEqual(calls, ['first']);
    const status = parsed(await second.client.callTool({ name: 'get_job_status', arguments: { job_id: two.id } }));
    assert.equal(status.status, 'queued');
    assert.equal(parsed(await first.client.callTool({ name: 'session_status', arguments: {} })).status, 'busy');
    await Promise.all([first.client.close(), second.client.close()]);
    await delay(100);
    assert.equal(await lockfile.check(dir, { stale: 30_000 }), true, 'Worker must retain accepted jobs without clients');
    releaseFirst();
    await until(() => calls.length === 2);
    assert.deepEqual(calls, ['first', 'second']);
    assert.equal(maximumActive, 1);
    releaseSecond();
    await worker.done;
    const store = new JobStore(dir);
    try { assert.equal(store.get(one.id).status, 'completed'); assert.equal(store.get(two.id).status, 'completed'); }
    finally { store.close(); }
  } finally {
    releaseFirst(); releaseSecond();
    await Promise.allSettled([first.client.close(), second.client.close()]);
    await worker.close(); await rm(dir, { recursive: true, force: true });
  }
});

test('worker refuses unauthenticated local connections without exposing MCP messages', { timeout: 5000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'images-worker-auth-'));
  const worker = await startSharedWorker(loadConfig({ CHATGPT_DATA_DIR: dir }));
  try {
    const endpoint = JSON.parse(await readFile(path.join(dir, 'worker.json'), 'utf8'));
    const socket = createConnection({ host: '127.0.0.1', port: endpoint.port });
    let response = '';
    socket.on('data', bytes => { response += bytes.toString(); });
    socket.on('error', () => {});
    socket.write('incorrect-token\n');
    await new Promise<void>(resolve => socket.once('close', () => resolve()));
    assert.equal(response, '');
  } finally { await worker.close(); await rm(dir, { recursive: true, force: true }); }
});
