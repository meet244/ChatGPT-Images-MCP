import './support/headless.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { loadConfig } from '../src/config.js';
import { ChatGPTBrowser } from '../src/browser.js';
import { JobStore } from '../src/store.js';
import { JobQueue } from '../src/queue.js';
import { createServer } from '../src/server.js';
import { AccountRegistry } from '../src/accounts.js';
import { acquireRuntime } from '../src/runtime.js';
import { pruneReferences, referenceGraceMs, stageReferences } from '../src/references.js';
import { saveImageCopy } from '../src/save.js';
import { planCleanup, runCleanup, formatBytes } from '../src/cleanup.js';
import { rotateLog } from '../src/events.js';
import { runDoctor } from '../src/doctor.js';

const png = (color: string) => sharp({ create: { width: 300, height: 200, channels: 3, background: color } }).png().toBuffer();
const age = async (target: string, ms: number) => { const time = new Date(Date.now() - ms); await utimes(target, time, time); };

test('unused reference copies are deleted, while copies of queued or running jobs and recent copies are kept', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'images-prune-'));
  const store = new JobStore(dir);
  try {
    const source = path.join(dir, 'source.png');
    await writeFile(source, await png('#e01b24'));
    const [queued, running, done, fresh] = [await stageReferences(dir, [source]), await stageReferences(dir, [source]), await stageReferences(dir, [source]), await stageReferences(dir, [source])];
    for (const refs of [queued, running, done]) await age(path.dirname(refs[0]!.path), referenceGraceMs * 2);
    store.create('queued', queued);
    store.update(store.create('running', running).id, { status: 'running' });
    store.update(store.create('done', done).id, { status: 'completed' });
    const preview = await pruneReferences(store, referenceGraceMs, Date.now(), true);
    assert.equal(preview.removed, 1);
    await stat(done[0]!.path);
    assert.deepEqual((await pruneReferences(store)).removed, 1);
    await assert.rejects(stat(done[0]!.path), { code: 'ENOENT' });
    for (const kept of [queued, running, fresh]) await stat(kept[0]!.path);
    assert.deepEqual(await pruneReferences({ dataDir: path.join(dir, 'missing'), byStatus: () => [] }), { removed: 0, bytes: 0 });
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});

test('an idle queue removes the reference copies of finished jobs', { timeout: 15_000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'images-queue-prune-'));
  const store = new JobStore(dir);
  const browser = new ChatGPTBrowser(loadConfig({ CHATGPT_DATA_DIR: dir }));
  let uploaded: string[] = [];
  browser.generate = async (_id, _prompt, submitted, references = []) => {
    uploaded = references.map(reference => reference.path);
    for (const reference of references) await stat(reference.path);
    submitted('https://chatgpt.com/c/fixture');
    return { conversationUrl: 'https://chatgpt.com/c/fixture', images: [] };
  };
  browser.shutdown = async () => {};
  const queue = new JobQueue(store, browser);
  try {
    const source = path.join(dir, 'source.png');
    await writeFile(source, await png('#2ec27e'));
    const job = await queue.enqueueWithReferences('with reference', [source]);
    const deadline = Date.now() + 5000;
    while (store.get(job.id).status !== 'completed') { assert.ok(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 20)); }
    assert.equal(uploaded.length, 1, 'The reference was available while generating');
    // Within the grace period the copy is kept; once older, the next idle pass removes it.
    await stat(uploaded[0]!);
    await age(path.dirname(uploaded[0]!), referenceGraceMs * 2);
    await queue.enqueueWithReferences('second', []);
    const second = Date.now() + 5000;
    while (await stat(uploaded[0]!).then(() => true, () => false)) { assert.ok(Date.now() < second, 'Reference copy was not removed'); await new Promise(resolve => setTimeout(resolve, 20)); }
  } finally { await queue.stop(); store.close(); await rm(dir, { recursive: true, force: true }); }
});

test('save_image copies or converts a finished image, creates folders, and never overwrites by default', { timeout: 15_000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'images-save-'));
  const store = new JobStore(dir);
  const browser = new ChatGPTBrowser(loadConfig({ CHATGPT_DATA_DIR: dir }));
  const server = createServer(store, new JobQueue(store, browser), browser);
  const client = new Client({ name: 'save-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport); await client.connect(clientTransport);
    const generated = path.join(dir, 'images', 'generated.png');
    await mkdir(path.dirname(generated), { recursive: true });
    await writeFile(generated, await png('#3584e4'));
    const job = store.create('done');
    store.update(job.id, { status: 'completed', images: [{ path: generated, mimeType: 'image/png', bytes: 1 }] });
    const call = (args: object) => client.callTool({ name: 'save_image', arguments: { job_id: job.id, ...args } });
    const text = (result: any) => result.content.find((item: any) => item.type === 'text').text as string;

    const project = path.join(dir, 'project');
    const copied = JSON.parse(text(await call({ path: path.join(project, 'public', 'hero.png') })));
    assert.equal(copied.path, path.join(project, 'public', 'hero.png'));
    assert.deepEqual(await readFile(copied.path), await readFile(generated));
    const converted = JSON.parse(text(await call({ path: path.join(project, 'hero.webp') })));
    assert.equal((await sharp(converted.path).metadata()).format, 'webp');
    const intoFolder = JSON.parse(text(await call({ path: project })));
    assert.equal(intoFolder.path, path.join(project, `${job.id}-1.png`));

    const exists = await call({ path: copied.path });
    assert.equal(exists.isError, true);
    assert.match(text(exists), /already exists.*overwrite/);
    await writeFile(copied.path, 'old');
    await call({ path: copied.path, overwrite: true });
    assert.deepEqual(await readFile(copied.path), await readFile(generated));

    assert.equal((await call({ path: 'relative/hero.png' })).isError, true);
    assert.match(text(await call({ path: path.join(project, 'hero.gif') })), /\.png, \.jpg, \.jpeg or \.webp/);
    const pending = store.create('pending');
    assert.match(text(await client.callTool({ name: 'save_image', arguments: { job_id: pending.id, path: path.join(project, 'x.png') } })), /not ready/);
    await assert.rejects(saveImageCopy({ path: path.join(dir, 'gone.png'), mimeType: 'image/png', bytes: 1 }, job.id, 0, path.join(project, 'gone.png')), /cannot be read/);
  } finally { await client.close(); store.close(); await rm(dir, { recursive: true, force: true }); }
});

test('cleanup removes caches, unused references and old images only, skipping accounts in use', { timeout: 20_000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'images-cleanup-'));
  const config = loadConfig({ CHATGPT_DATA_DIR: dir, CHATGPT_BROWSER_MODE: 'playwright', CHATGPT_HEADLESS: 'true' });
  const registry = new AccountRegistry(config);
  try {
    const work = await registry.add('work');
    const busy = await registry.add('busy');
    for (const account of [work, busy]) {
      await mkdir(path.join(account.dataDir, 'chrome-profile', 'Default', 'Cache'), { recursive: true });
      await writeFile(path.join(account.dataDir, 'chrome-profile', 'Default', 'Cache', 'data'), Buffer.alloc(4096));
      await writeFile(path.join(account.dataDir, 'chrome-profile', 'Default', 'Cookies'), 'login');
    }
    const source = path.join(dir, 'source.png');
    await writeFile(source, await png('#9141ac'));
    const store = new JobStore(work.dataDir);
    const unused = await stageReferences(work.dataDir, [source]);
    const needed = await stageReferences(work.dataDir, [source]);
    store.update(store.create('done', unused).id, { status: 'completed' });
    store.create('waiting', needed);
    store.close();
    const oldImage = path.join(work.dataDir, 'images', 'old-job'), newImage = path.join(work.dataDir, 'images', 'new-job');
    for (const folder of [oldImage, newImage]) { await mkdir(folder, { recursive: true }); await writeFile(path.join(folder, '1.png'), await png('#000000')); }
    await age(oldImage, 40 * 86_400_000);

    const plan = await planCleanup(registry, { imagesOlderThanDays: 30 });
    const workPlan = plan.find(item => item.account === 'work')!;
    assert.equal(workPlan.cache, 4096);
    assert.ok(workPlan.references > 0);
    assert.deepEqual(workPlan.images.map(image => image.folder), [oldImage]);

    const held = await acquireRuntime(busy);
    let results;
    try { results = await runCleanup(registry, { imagesOlderThanDays: 30 }); }
    finally { await held(); }
    assert.match(results.find(item => item.account === 'busy')!.skipped!, /in use/);
    await stat(path.join(busy.dataDir, 'chrome-profile', 'Default', 'Cache', 'data'));
    await assert.rejects(stat(path.join(work.dataDir, 'chrome-profile', 'Default', 'Cache')), { code: 'ENOENT' });
    assert.equal(await readFile(path.join(work.dataDir, 'chrome-profile', 'Default', 'Cookies'), 'utf8'), 'login', 'Logins are kept');
    await assert.rejects(stat(unused[0]!.path), { code: 'ENOENT' });
    await stat(needed[0]!.path);
    await assert.rejects(stat(oldImage), { code: 'ENOENT' });
    await stat(newImage);
    const again = new JobStore(work.dataDir);
    try { assert.equal(again.byStatus('queued').length, 1, 'Cleanup does not change job records'); } finally { again.close(); }
    assert.equal(formatBytes(2048), '2 KB');
    assert.equal(formatBytes(5 * 1024 * 1024), '5 MB');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('doctor reports disk use, and the event log rotates past its size limit', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'images-disk-'));
  const config = loadConfig({ CHATGPT_DATA_DIR: dir, CHATGPT_BROWSER_MODE: 'playwright', CHATGPT_HEADLESS: 'true' });
  const registry = new AccountRegistry(config);
  try {
    const work = await registry.add('work');
    await mkdir(path.join(work.dataDir, 'images', 'job'), { recursive: true });
    await writeFile(path.join(work.dataDir, 'images', 'job', '1.png'), Buffer.alloc(3 * 1024 * 1024));
    const environment = { claudeConfigFile: path.join(dir, 'none.json'), which: async () => undefined, run: async () => ({ code: 1, stdout: '', stderr: '' }) };
    const disk = (await runDoctor(config, registry, environment)).filter(check => check.section === 'Disk');
    assert.match(disk[0]!.text, /^3 MB used: Chrome profiles 0 KB, images 3 MB, reference copies 0 KB$/);

    const log = path.join(dir, 'worker.log');
    await writeFile(log, 'small');
    await rotateLog(log, 10);
    assert.equal(await readFile(log, 'utf8'), 'small');
    await writeFile(log, 'x'.repeat(20));
    await rotateLog(log, 10);
    await assert.rejects(stat(log), { code: 'ENOENT' });
    assert.equal(await readFile(`${log}.1`, 'utf8'), 'x'.repeat(20));
    await rotateLog(path.join(dir, 'missing.log'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('the event log records job starts, completions and failures without the prompt', { timeout: 15_000 }, async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'images-events-'));
  const store = new JobStore(dir);
  const browser = new ChatGPTBrowser(loadConfig({ CHATGPT_DATA_DIR: dir }));
  browser.generate = async (_id, prompt) => {
    if (prompt.includes('fail')) throw new (await import('../src/browser.js')).BrowserError('Fixture failure.');
    return { conversationUrl: 'https://chatgpt.com/c/fixture', images: [] };
  };
  browser.shutdown = async () => {};
  const lines: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  t.mock.method(process.stderr, 'write', (chunk: string | Uint8Array) => { lines.push(String(chunk)); return true; });
  const queue = new JobQueue(store, browser);
  try {
    const ok = queue.enqueue('secret prompt text');
    const failed = queue.enqueue('secret prompt that should fail');
    const deadline = Date.now() + 5000;
    while (['queued', 'running'].includes(store.get(failed.id).status)) { assert.ok(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 20)); }
    const log = lines.join('');
    assert.match(log, new RegExp(`\\d{4}-\\d\\d-\\d\\dT[^ ]+ job ${ok.id} started\\n`));
    assert.match(log, new RegExp(`job ${ok.id} completed in \\d+s with 0 images`));
    assert.match(log, new RegExp(`job ${failed.id} failed after \\d+s: Fixture failure\\.`));
    assert.doesNotMatch(log, /secret prompt/);
  } finally { t.mock.restoreAll(); void write; await queue.stop(); store.close(); await rm(dir, { recursive: true, force: true }); }
});
