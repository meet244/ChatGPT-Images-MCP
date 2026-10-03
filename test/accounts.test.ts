import './support/headless.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer as createHttpServer } from 'node:http';
import sharp from 'sharp';
import lockfile from 'proper-lockfile';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { AccountRegistry } from '../src/accounts.js';
import { loadConfig, projectRoot, type Config } from '../src/config.js';
import { ChatGPTBrowser, BrowserError } from '../src/browser.js';
import { JobStore } from '../src/store.js';
import { saveCookies, readSavedCookies } from '../src/session-store.js';
import { startSharedWorker } from '../src/shared-worker.js';
import { acquireRuntime } from '../src/runtime.js';

const execute = promisify(execFile);
function parsed(result: any): any {
  assert.equal(result.isError, undefined, JSON.stringify(result.content));
  return JSON.parse(result.content.find((item: any) => item.type === 'text').text);
}
async function until(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error('Account fixture did not reach the expected state.');
    await delay(20);
  }
}
function clientFor(dir: string) {
  const client = new Client({ name: 'accounts-test', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(projectRoot, 'dist/index.js'), 'serve'],
    cwd: os.tmpdir(), env: { CHATGPT_DATA_DIR: dir, CHATGPT_COOKIES_FILE: '' }, stderr: 'pipe' });
  transport.stderr?.on('data', () => {});
  return { client, transport, call: (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args }) };
}
const cookies = (value: string) => [{ name: '__Secure-next-auth.session-token', value, domain: '.chatgpt.com', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' as const }];

test('account registry preserves legacy login and jobs, isolates new profiles, and persists selection privately', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'images-accounts-registry-'));
  const config = loadConfig({ CHATGPT_DATA_DIR: dir, CHATGPT_COOKIES_FILE: path.join(dir, 'import.json') });
  const registry = new AccountRegistry(config);
  await saveCookies(dir, cookies('legacy-secret'));
  const original = await readFile(path.join(dir, 'session-cookies.json'));
  const store = new JobStore(dir);
  const legacy = store.create('Existing image'); store.update(legacy.id, { status: 'completed' }); store.close();
  try {
    assert.equal(await registry.active(), 'default');
    assert.equal((await registry.require('default')).dataDir, dir);
    assert.equal((await registry.require('default')).cookiesFile, config.cookiesFile);
    const second = await registry.add('work');
    assert.equal(second.dataDir, path.join(dir, 'accounts/work'));
    assert.equal(second.cookiesFile, undefined, 'Do not clone a configured global cookie import');
    assert.deepEqual(await readSavedCookies(second.dataDir), []);
    await saveCookies(second.dataDir, cookies('work-secret'));
    assert.deepEqual(await readFile(path.join(dir, 'session-cookies.json')), original);
    assert.equal(await registry.owner(legacy.id), 'default');
    const work = new JobStore(second.dataDir);
    const batch = work.createBatch(['work only'], 'same_chat'); work.close();
    await registry.use('work');
    assert.equal(await new AccountRegistry(config).active(), 'work');
    assert.equal(await registry.owner(batch.id, true), 'work');
    assert.equal(await registry.owner(batch.jobs[0]!.id), 'work');
    assert.equal((await stat(path.join(dir, 'active-account.json'))).mode & 0o777, 0o600);
    assert.equal((await stat(second.dataDir)).mode & 0o777, 0o700);
    for (const name of ['', '..', '../escape', '/tmp/escape', 'Work', 'work/a', 'a'.repeat(49)]) {
      await assert.rejects(registry.add(name), /Account names/);
      await assert.rejects(registry.use(name), /Account names/);
    }
    await assert.rejects(registry.add('work'), /already exists/);
    await assert.rejects(registry.add('default'), /already exists/);
    await assert.rejects(registry.use('missing'), /Unknown account/);
    await assert.rejects(registry.owner(randomUUID()), /Job not found/);
    await writeFile(path.join(dir, 'active-account.json'), '"../invalid"');
    await assert.rejects(registry.active(), /setting is invalid/);
    await registry.use('default'); assert.equal(await registry.active(), 'default');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('terminal account commands add/list/select without opening browsers or changing the original session', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'images-accounts-cli-'));
  const run = async (...args: string[]) => execute(process.execPath, [path.join(projectRoot, 'dist/index.js'), ...args], {
    cwd: os.tmpdir(), env: { ...process.env, CHATGPT_DATA_DIR: dir, CHATGPT_COOKIES_FILE: '' },
  });
  try {
    await saveCookies(dir, cookies('original-cli-secret'));
    const original = await readFile(path.join(dir, 'session-cookies.json'));
    assert.equal(JSON.parse((await run('account-add', '--account', 'second')).stdout).status, 'login_required');
    assert.equal(JSON.parse((await run('account-use', '--account', 'second')).stdout).account, 'second');
    const listed = JSON.parse((await run('accounts')).stdout);
    assert.equal(listed.active_account, 'second');
    assert.equal(listed.accounts.find((account: any) => account.account === 'default').has_saved_session, true);
    assert.equal(listed.accounts.find((account: any) => account.account === 'second').has_saved_session, false);
    assert.equal(listed.selection_mode, 'manual');
    assert.doesNotMatch(JSON.stringify(listed), /original-cli-secret/);
    const second = path.join(dir, 'accounts/second');
    await assert.rejects(readFile(path.join(second, 'worker.json')), { code: 'ENOENT' });
    await assert.rejects(stat(path.join(second, 'chrome-profile')), { code: 'ENOENT' });
    await assert.rejects(run('account-add', '--account', '../escape'));
    await assert.rejects(run('status', '--account', 'missing'));
    await assert.rejects(run('serve', '--account', 'second'));
    await run('account-use', '--account', 'default');
    assert.deepEqual(await readFile(path.join(dir, 'session-cookies.json')), original);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('stdio clients share server-selected queues and retrieve/cancel jobs across profiles by ID', { timeout: 20_000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'images-accounts-mcp-'));
  const config = loadConfig({ CHATGPT_DATA_DIR: dir });
  const registry = new AccountRegistry(config);
  await registry.add('default');
  const image = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#ee9911' } }).png().toBuffer();
  const calls: { account: string; prompt: string }[] = [];
  const openings: string[] = [];
  const releases: (() => void)[] = [];
  let disposing = false;
  const factory = (accountConfig: Config, account: string) => {
    openings.push(account);
    const browser = new ChatGPTBrowser(accountConfig);
    browser.sessionStatus = async () => ({ status: 'ready', message: 'Fixture account ready.' });
    browser.generate = async (id, prompt, submitted) => {
      calls.push({ account, prompt });
      submitted(`https://chatgpt.com/c/${id}`);
      if (prompt.startsWith('hold') && !disposing) await new Promise<void>(resolve => releases.push(resolve));
      const directory = path.join(accountConfig.dataDir, 'images', id);
      await mkdir(directory, { recursive: true });
      const file = path.join(directory, '1.png'); await writeFile(file, image);
      return { conversationUrl: `https://chatgpt.com/c/${id}`, images: [{ path: file, mimeType: 'image/png', bytes: image.length }] };
    };
    return browser;
  };
  const worker = await startSharedWorker(config, { browser: factory(config, 'default'), browserFactory: factory, idleMs: 30 });
  const first = clientFor(dir), second = clientFor(dir);
  try {
    await Promise.all([first.client.connect(first.transport), second.client.connect(second.transport)]);
    assert.equal(parsed(await first.call('add_account', { account: 'work' })).status, 'login_required');
    assert.equal(parsed(await second.call('list_accounts')).active_account, 'default');
    const legacy = parsed(await first.call('generate_image', { prompt: 'hold default' }));
    const pending = parsed(await second.call('generate_image', { prompt: 'cancel default' }));
    const batch = parsed(await first.call('generate_images', { prompts: ['batch one', 'batch two'] }));
    assert.equal(await registry.owner(legacy.id), 'default');
    assert.equal(parsed(await first.call('session_status')).status, 'busy');
    await registry.use('work'); // Simulate the persisted selection changed by the worker, without a public tool input.
    assert.deepEqual(parsed(await first.call('session_status')), { status: 'busy' });
    const work = parsed(await second.call('generate_image', { prompt: 'hold work' }));
    const workSecond = parsed(await first.call('generate_image', { prompt: 'work second' }));
    const workThird = parsed(await second.call('generate_image', { prompt: 'work third' }));
    assert.deepEqual(openings.sort(), ['default', 'work'], 'Concurrent clients must share a single runtime per account');
    assert.deepEqual(calls, [{ account: 'default', prompt: 'hold default' }], 'Another account waits instead of opening a simultaneous browser');
    assert.equal(parsed(await first.call('get_job_status', { job_id: pending.id })).account, undefined);
    assert.equal(await registry.owner(pending.id), 'default');
    assert.equal(parsed(await first.call('cancel_job', { job_id: pending.id })).status, 'cancelled');
    assert.equal(parsed(await second.call('get_batch_status', { batch_id: batch.id })).account, undefined);
    assert.equal(parsed(await first.call('wait_for_job', { job_id: legacy.id, wait_seconds: 0 })).account, undefined);
    assert.equal((await first.call('get_job_status', { account: 'work', job_id: legacy.id })).isError, true);
    assert.equal((await first.call('generate_image', { account: 'missing', prompt: 'never sent' })).isError, true);
    assert.equal((await first.call('add_account', { account: '../escape' })).isError, true);
    assert.equal((await first.call('add_account', { account: 'work' })).isError, true);
    const history = parsed(await first.call('list_jobs')).jobs;
    assert.ok(history.some((job: any) => job.id === work.id));
    assert.ok(history.some((job: any) => job.id === legacy.id));
    assert.equal(parsed(await first.call('list_jobs', { limit: 1 })).jobs.length, 1);
    releases[0]!();
    await until(async () => releases.length === 2);
    releases[1]!();
    await until(async () => parsed(await first.call('get_job_status', { job_id: workThird.id })).status === 'completed');
    await until(async () => parsed(await first.call('get_batch_status', { batch_id: batch.id })).status === 'completed');
    assert.deepEqual(calls.filter(call => call.account === 'work').map(call => call.prompt), ['hold work', 'work second', 'work third']);
    assert.deepEqual(calls.filter(call => call.account === 'default').map(call => call.prompt), ['hold default', 'batch one', 'batch two']);
    assert.equal(parsed(await first.call('get_image', { job_id: legacy.id, include_preview: false })).account, undefined);
    const finished = parsed(await second.call('wait_for_job', { job_id: workSecond.id, include_preview: false }));
    assert.deepEqual(Object.keys(finished).sort(), ['status', 'updatedAt']);
    const finishedImage = parsed(await second.call('get_image', { job_id: workSecond.id, include_preview: false }));
    assert.ok(finishedImage.path.startsWith(path.join(dir, 'accounts/work/images')));
    assert.equal((await first.call('get_image', { job_id: work.id })).content.some(item => item.type === 'image'), true);
    const detached = parsed(await first.call('generate_image', { prompt: 'hold detached' }));
    const afterDetach = parsed(await second.call('generate_image', { prompt: 'after detach' }));
    await until(async () => releases.length === 3);
    await Promise.all([first.client.close(), second.client.close()]);
    await delay(100);
    assert.equal(await lockfile.check(dir, { stale: 30_000 }), true, 'Named-account work keeps the shared worker alive after every client disconnects');
    releases.forEach(release => release());
    await worker.done;
    const saved = new JobStore((await registry.require('work')).dataDir);
    try {
      assert.equal(saved.get(detached.id).status, 'completed');
      assert.equal(saved.get(afterDetach.id).status, 'completed');
    } finally { saved.close(); }
    assert.equal(await registry.active(), 'work');
    for (const name of await registry.names()) assert.equal(await lockfile.check((await registry.require(name)).dataDir, { stale: 30_000 }), false);
  } finally {
    disposing = true;
    releases.forEach(release => release());
    await Promise.allSettled([first.client.close(), second.client.close()]);
    await worker.close(); await rm(dir, { recursive: true, force: true });
  }
});

test('cooldowns stay with their account across switching and worker restarts', { timeout: 15_000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'images-accounts-cooldown-'));
  const config = loadConfig({ CHATGPT_DATA_DIR: dir });
  const registry = new AccountRegistry(config);
  await registry.add('default');
  const secondConfig = await registry.add('second');
  let calls = 0;
  const browser = new ChatGPTBrowser(config);
  browser.generate = async () => { calls++; throw new BrowserError('Fixture limit.', 'image_usage_limit'); };
  const factory = (config: Config) => {
    const browser = new ChatGPTBrowser(config);
    browser.sessionStatus = async () => ({ status: 'ready', message: 'Fixture ready.' });
    browser.generate = async (_id, prompt) => {
      calls++;
      if (prompt === 'limit second account') throw new BrowserError('Second fixture limit.', 'image_usage_limit');
      return { images: [] };
    };
    return browser;
  };
  let worker = await startSharedWorker(config, { browser, browserFactory: factory });
  let connection = clientFor(dir);
  try {
    await connection.client.connect(connection.transport);
    const limited = parsed(await connection.call('generate_image', { prompt: 'limit first account' }));
    await until(async () => parsed(await connection.call('get_job_status', { job_id: limited.id })).status === 'failed');
    const cooldown = parsed(await connection.call('session_status'));
    assert.equal(cooldown.status, 'usage_limit');
    await saveCookies(secondConfig.dataDir, cookies('second-fixture-secret'));
    const ready = parsed(await connection.call('session_status'));
    assert.equal(ready.status, 'ready'); assert.equal(ready.account, undefined);
    const allowed = parsed(await connection.call('generate_image', { prompt: 'second account' }));
    assert.equal(await registry.owner(allowed.id), 'second');
    await until(async () => parsed(await connection.call('get_job_status', { job_id: allowed.id })).status === 'completed');
    const limitedSecond = parsed(await connection.call('generate_image', { prompt: 'limit second account' }));
    await until(async () => parsed(await connection.call('get_job_status', { job_id: limitedSecond.id })).status === 'failed');
    const secondCooldown = parsed(await connection.call('session_status'));
    const blocked = await connection.call('generate_images', { prompts: ['blocked'], reference_images: [path.join(dir, 'missing.png')] });
    assert.equal(blocked.isError, true);
    assert.equal(JSON.parse((blocked.content[0] as any).text).retryAfter, secondCooldown.retryAfter);
    assert.equal(JSON.parse((blocked.content[0] as any).text).account, undefined);
    const original = await registry.inspectDatabase('default', db => JSON.parse((db.prepare("SELECT body FROM settings WHERE key = 'image_cooldown'").get() as { body: string }).body));
    assert.equal(original.retryAfter, cooldown.retryAfter);
    assert.equal(calls, 3);
    await connection.client.close(); await worker.close();
    worker = await startSharedWorker(config, { browser, browserFactory: factory });
    connection = clientFor(dir); await connection.client.connect(connection.transport);
    assert.equal(parsed(await connection.call('list_accounts')).active_account, 'second');
    const restored = parsed(await connection.call('session_status'));
    assert.equal(restored.retryAfter, secondCooldown.retryAfter);
    assert.equal(calls, 3, 'Restart and switching never replay failed jobs');
    assert.equal(await registry.owner(limited.id), 'default');
  } finally { await connection.client.close(); await worker.close(); await rm(dir, { recursive: true, force: true }); }
});

test('named profiles resume queued jobs on worker startup and respect standalone login locks', { timeout: 10_000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'images-accounts-restart-'));
  const config = loadConfig({ CHATGPT_DATA_DIR: dir });
  const registry = new AccountRegistry(config);
  const named = await registry.add('second');
  const locked = await registry.add('login');
  const seed = new JobStore(named.dataDir);
  const queued = seed.create('resume queued');
  const running = seed.create('do not replay interrupted'); seed.update(running.id, { status: 'running' }); seed.close();
  const calls: string[] = [];
  const worker = await startSharedWorker(config, { browserFactory: config => {
    const browser = new ChatGPTBrowser(config);
    browser.generate = async (_id, prompt) => { calls.push(prompt); return { images: [] }; };
    return browser;
  } });
  const release = await acquireRuntime(locked);
  const connection = clientFor(dir);
  try {
    await connection.client.connect(connection.transport);
    await until(async () => parsed(await connection.call('get_job_status', { job_id: queued.id })).status === 'completed');
    assert.equal(parsed(await connection.call('get_job_status', { job_id: running.id })).status, 'failed');
    assert.deepEqual(calls, ['resume queued']);
    await registry.use('login');
    const lockedResult = await connection.call('session_status');
    assert.equal(lockedResult.isError, undefined);
    assert.equal(parsed(lockedResult).status, 'busy');
    assert.deepEqual(parsed(lockedResult), { status: 'busy' });
    await release();
    const unlocked = parsed(await connection.call('list_jobs'));
    assert.ok(unlocked.jobs.some((job: any) => job.id === queued.id && job.account === undefined));
  } finally { await release().catch(() => {}); await connection.client.close(); await worker.close(); await rm(dir, { recursive: true, force: true }); }
});

test('two real browser profiles keep cookies and local storage separate across reconnects', { timeout: 30_000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'images-accounts-browser-'));
  const config = loadConfig({ CHATGPT_DATA_DIR: dir, CHATGPT_BROWSER_MODE: 'playwright', CHATGPT_HEADLESS: 'true' });
  const registry = new AccountRegistry(config);
  const secondConfig = await registry.add('second');
  const fixture = createHttpServer((_req, res) => { res.setHeader('content-type', 'text/html'); res.end('<div contenteditable="true" role="textbox">Fixture</div>'); });
  await new Promise<void>(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(fixture.address() as { port: number }).port}/`;
  let first = new ChatGPTBrowser(config, { baseUrl });
  let second = new ChatGPTBrowser(secondConfig, { baseUrl });
  try {
    await first.importCookieValues(cookies('first-fixture-secret'));
    await second.importCookieValues(cookies('second-fixture-secret'));
    const firstPage = await first.open(), secondPage = await second.open();
    await firstPage.evaluate(() => localStorage.setItem('account-marker', 'first'));
    assert.equal(await secondPage.evaluate(() => localStorage.getItem('account-marker')), null);
    await secondPage.evaluate(() => localStorage.setItem('account-marker', 'second'));
    assert.equal((await firstPage.context().cookies('https://chatgpt.com'))[0]?.value, 'first-fixture-secret');
    assert.equal((await secondPage.context().cookies('https://chatgpt.com'))[0]?.value, 'second-fixture-secret');
    await Promise.all([first.close(), second.close()]);
    first = new ChatGPTBrowser(config, { baseUrl }); second = new ChatGPTBrowser(secondConfig, { baseUrl });
    assert.equal(await (await first.open()).evaluate(() => localStorage.getItem('account-marker')), 'first');
    assert.equal(await (await second.open()).evaluate(() => localStorage.getItem('account-marker')), 'second');
    assert.equal((await readSavedCookies(dir))[0]?.value, 'first-fixture-secret');
    assert.equal((await readSavedCookies(secondConfig.dataDir))[0]?.value, 'second-fixture-secret');
  } finally {
    await Promise.all([first.close(), second.close()]);
    await new Promise<void>(resolve => fixture.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
