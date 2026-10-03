import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import sharp from 'sharp';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { loadConfig } from '../src/config.js';
import { ChatGPTBrowser } from '../src/browser.js';
import { JobStore } from '../src/store.js';
import { JobQueue } from '../src/queue.js';
import { createServer } from '../src/server.js';

function parsed(result: any): any {
  assert.equal(result.isError, undefined, JSON.stringify(result.content));
  return JSON.parse(result.content.find((item: any) => item.type === 'text').text);
}

async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'images-wait-'));
  const store = new JobStore(dir);
  const bytes = await sharp({ create: { width: 1400, height: 1050, channels: 3, background: '#176e4a' } }).png().toBuffer();
  const imagePath = path.join(dir, 'finished.png');
  await writeFile(imagePath, bytes);
  const artifact = { path: imagePath, mimeType: 'image/png', bytes: bytes.length };
  const browser = new ChatGPTBrowser(loadConfig({ CHATGPT_DATA_DIR: dir }));
  const calls: string[] = [];
  const releases: (() => void)[] = [];
  browser.generate = async (id, prompt, submitted) => {
    calls.push(prompt);
    submitted(`https://chatgpt.com/c/${id}`);
    await new Promise<void>(resolve => releases.push(resolve));
    return { conversationUrl: `https://chatgpt.com/c/${id}`, images: [artifact, artifact] };
  };
  const queue = new JobQueue(store, browser);
  const server = createServer(store, queue, browser);
  const client = new Client({ name: 'bounded-wait-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });
  return { store, queue, client, calls, releases, artifact, call, async close() {
    await client.close(); await server.close();
    const stopped = queue.stop(); releases.forEach(release => release()); await stopped;
    store.close(); await rm(dir, { recursive: true, force: true });
  } };
}

test('wait returns the completed image, allows concurrent tools, and can be repeated without generation', { timeout: 5000 }, async () => {
  const f = await fixture();
  try {
    const tools = await f.client.listTools();
    const schema = tools.tools.find(tool => tool.name === 'wait_for_job')!.inputSchema;
    assert.equal((schema.properties!.wait_seconds as any).default, 25);
    assert.equal((schema.properties!.wait_seconds as any).maximum, 25);
    assert.equal(schema.required?.includes('wait_seconds') ?? false, false);
    const job = parsed(await f.call('generate_image', { prompt: 'first' }));
    let settled = false;
    const waiting = f.call('wait_for_job', { job_id: job.id }).then(result => { settled = true; return result; });
    await delay(50);
    assert.equal(settled, false);
    const next = parsed(await f.call('generate_image', { prompt: 'second' }));
    assert.equal(parsed(await f.call('get_job_status', { job_id: next.id })).status, 'queued');
    parsed(await f.call('cancel_job', { job_id: next.id }));
    assert.deepEqual(f.calls, ['first']);
    f.releases[0]!();
    const result = await waiting;
    const completed = parsed(result);
    assert.equal(completed.id, job.id);
    assert.equal(completed.status, 'completed');
    assert.deepEqual(completed.image, { image_index: 0, ...f.artifact });
    const preview = result.content.find(item => item.type === 'image')!;
    assert.equal(preview.type, 'image');
    const metadata = await sharp(Buffer.from(preview.data, 'base64')).metadata();
    assert.equal(metadata.width, 1024); assert.equal(metadata.height, 768);
    const repeated = await f.call('wait_for_job', { job_id: job.id, image_index: 1, include_preview: false });
    assert.equal(repeated.content.length, 1);
    assert.equal(parsed(repeated).image.image_index, 1);
    assert.deepEqual(f.calls, ['first']);
  } finally { await f.close(); }
});

test('wait expiry returns running or queued batch jobs without failing or resubmitting them', { timeout: 6000 }, async () => {
  const f = await fixture();
  try {
    const job = parsed(await f.call('generate_image', { prompt: 'first' }));
    const batch = parsed(await f.call('generate_images', { prompts: ['batch image'] }));
    const started = performance.now();
    const results = await Promise.all([job.id, batch.jobs[0].id].map(job_id =>
      f.call('wait_for_job', { job_id, wait_seconds: 1 })));
    assert.ok(performance.now() - started >= 950, 'Pending calls must actually wait for the requested duration');
    assert.equal(parsed(results[0]).status, 'running');
    assert.equal(parsed(results[1]).status, 'queued');
    assert.equal(parsed(results[1]).id, batch.jobs[0].id);
    assert.equal(f.store.get(job.id).status, 'running');
    assert.equal(f.store.get(batch.jobs[0].id).status, 'queued');
    assert.equal(parsed(await f.call('wait_for_job', { job_id: job.id, wait_seconds: 0 })).status, 'running');
    assert.deepEqual(f.calls, ['first']);
    parsed(await f.call('cancel_job', { job_id: batch.jobs[0].id }));
  } finally { await f.close(); }
});

test('failed/cancelled waits return immediately, and invalid waits do not admit jobs', { timeout: 5000 }, async () => {
  const f = await fixture();
  try {
    for (const status of ['failed', 'cancelled'] as const) {
      const job = f.store.create(status);
      f.store.update(job.id, { status, error: 'Expected terminal state' });
      const result = parsed(await f.call('wait_for_job', { job_id: job.id }));
      assert.equal(result.status, status); assert.equal(result.error, 'Expected terminal state');
    }
    const completed = f.store.create('Completed earlier');
    f.store.update(completed.id, { status: 'completed', images: [f.artifact] });
    for (const args of [
      { job_id: randomUUID() }, { job_id: 'not-a-job' },
      ...[-1, 26, 0.5, '25'].map(wait_seconds => ({ job_id: completed.id, wait_seconds })),
      { job_id: completed.id, image_index: 3 }, { job_id: completed.id, image_index: -1 },
      { job_id: completed.id, include_preview: 'false' },
    ]) assert.equal((await f.call('wait_for_job', args)).isError, true);
    assert.deepEqual(f.calls, []);
    assert.equal(f.store.list().length, 3);
  } finally { await f.close(); }
});

test('cancelling a wait leaves generation running and a later wait retrieves the same job', { timeout: 5000 }, async () => {
  const f = await fixture();
  try {
    const job = parsed(await f.call('generate_image', { prompt: 'first' }));
    const controller = new AbortController();
    const waiting = f.client.callTool({ name: 'wait_for_job', arguments: { job_id: job.id } }, { signal: controller.signal });
    const rejected = assert.rejects(waiting);
    await delay(50); controller.abort(); await rejected;
    assert.equal(parsed(await f.call('get_job_status', { job_id: job.id })).status, 'running');
    assert.deepEqual(f.calls, ['first']);
    const again = f.call('wait_for_job', { job_id: job.id, include_preview: false });
    f.releases[0]!();
    assert.equal(parsed(await again).status, 'completed');
    assert.deepEqual(f.calls, ['first']);
  } finally { await f.close(); }
});
