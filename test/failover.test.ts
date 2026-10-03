import './support/headless.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import sharp from 'sharp';
import { AccountRegistry, AccountManager } from '../src/accounts.js';
import { BrowserError, TextOnlyResponseError, ChatGPTBrowser, type GenerationOptions, type SessionStatus } from '../src/browser.js';
import { loadConfig, type Config } from '../src/config.js';
import { JobQueue } from '../src/queue.js';
import { JobStore, type ImageArtifact } from '../src/store.js';
import { createServer } from '../src/server.js';
import { saveCookies } from '../src/session-store.js';
import { acquireRuntime } from '../src/runtime.js';

const parsed = (result: any) => JSON.parse(result.content.find((item: any) => item.type === 'text').text);
async function until(predicate: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 3000;
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error('Failover fixture did not finish.');
    await delay(5);
  }
}
interface Call { account: string; prompt: string; references: ImageArtifact[]; options: GenerationOptions; }
async function fixture(autoSwitch = true) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'images-failover-'));
  const config = loadConfig({ CHATGPT_DATA_DIR: dir, CHATGPT_AUTO_SWITCH_ACCOUNTS: String(autoSwitch) });
  const registry = new AccountRegistry(config);
  await saveCookies(dir, [{ name: '__Secure-next-auth.session-token', value: 'default-fixture-session', domain: '.chatgpt.com', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' }]);
  const image = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#ee9911' } }).png().toBuffer();
  const calls: Call[] = [];
  const closed: string[] = [];
  const statuses = new Map<string, SessionStatus>();
  let behavior: (call: Call) => Promise<void> = async () => {};
  const factory = (config: Config, account: string) => {
    const browser = new ChatGPTBrowser(config);
    browser.shutdown = async () => { closed.push(account); };
    browser.sessionStatus = async () => statuses.get(account) ?? { status: 'ready', message: 'Fixture ready.' };
    browser.generate = async (id, prompt, submitted, references = [], options = {}) => {
      const call = { account, prompt, references, options };
      calls.push(call);
      const conversationUrl = options.conversationUrl ?? `https://chatgpt.com/c/${account}-${id}`;
      submitted(conversationUrl);
      await behavior(call);
      const directory = path.join(config.dataDir, 'images', id);
      await mkdir(directory, { recursive: true });
      const file = path.join(directory, '1.png'); await writeFile(file, image);
      return { conversationUrl, images: [{ path: file, mimeType: 'image/png', bytes: image.length }] };
    };
    return browser;
  };
  const store = new JobStore(dir), browser = factory(config, 'default'), queue = new JobQueue(store, browser);
  const manager = new AccountManager(registry, { account: 'default', store, browser, queue }, factory);
  const server = createServer(store, queue, browser, manager);
  const client = new Client({ name: 'failover-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });
  return {
    dir, config, registry, store, manager, calls, closed, statuses, image, call, factory,
    behavior(value: typeof behavior) { behavior = value; },
    async add(name: string, signedIn = true) {
      const config = await registry.add(name);
      // Existing failover scenarios use equal priorities to exercise active-account tie breaking.
      await registry.setPriority(name, 100);
      if (signedIn) await saveCookies(config.dataDir, [{ name: '__Secure-next-auth.session-token', value: 'fixture-session', domain: '.chatgpt.com', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' }]);
      return config;
    },
    async finished(id: string) {
      await until(() => !['queued', 'running'].includes(store.get(id).status));
      return parsed(await call('get_job_status', { job_id: id }));
    },
    async close() { await client.close(); await server.close(); await manager.close(); await rm(dir, { recursive: true, force: true }); },
  };
}

test('same-chat batches keep their profile open until all images finish, then close and preserve retrieval', async () => {
  for (const mandatory of [false, true]) {
    const f = await fixture();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    try {
      f.behavior(async ({ prompt }) => { if (prompt === 'second') await gate; });
      const batch = parsed(await f.call('generate_images', { prompts: ['first', 'second'], same_chat_mandatory: mandatory }));
      await until(() => f.calls.length === 2);
      assert.equal(f.store.getBatch(batch.id).jobs[0]!.status, 'completed');
      assert.deepEqual(f.closed, [], 'Do not close between batch images');
      release();
      await until(() => !f.manager.isBusy());
      assert.equal(f.store.getBatch(batch.id).status, 'completed');
      assert.deepEqual(f.closed, ['default']);
      assert.equal((await f.call('get_image', { job_id: batch.jobs[0].id })).isError, undefined);
      const next = parsed(await f.call('generate_image', { prompt: 'another image' }));
      await until(() => !f.manager.isBusy());
      assert.equal(f.store.get(next.id).status, 'completed');
      assert.deepEqual(f.closed, ['default', 'default']);
    } finally { release(); await f.close(); }
  }
});

test('a profile borrowed during quota failover stays open while another queue still needs it', async () => {
  const f = await fixture();
  let releaseForwarded!: () => void, releaseOwn!: () => void;
  const forwarded = new Promise<void>(resolve => { releaseForwarded = resolve; });
  const own = new Promise<void>(resolve => { releaseOwn = resolve; });
  try {
    await f.add('second');
    f.behavior(async ({ account, prompt }) => {
      if (account === 'default') throw new BrowserError('Confirmed quota.', 'image_usage_limit');
      await (prompt === 'forwarded' ? forwarded : own);
    });
    const first = parsed(await f.call('generate_image', { prompt: 'forwarded' }));
    await until(() => f.calls.some(call => call.account === 'second'));
    const second = parsed(await f.call('generate_image', { prompt: 'own queue' }));
    assert.equal(second.account, 'second');
    releaseForwarded();
    await until(() => f.calls.some(call => call.prompt === 'own queue'));
    await until(() => f.closed.includes('default'));
    assert.equal(f.closed.includes('second'), false, 'The borrowed profile still has work in its own queue');
    releaseOwn();
    await until(() => !f.manager.isBusy());
    assert.deepEqual(f.closed.sort(), ['default', 'second']);
    assert.equal((await f.call('get_image', { job_id: first.id })).isError, undefined);
    assert.equal((await f.call('get_image', { job_id: second.id })).isError, undefined);
  } finally { releaseForwarded(); releaseOwn(); await f.close(); }
});

test('live priority updates choose the highest number, fail over in priority order, and support manual selection', async () => {
  const f = await fixture();
  const finish = async (id: string) => {
    await until(async () => parsed(await f.call('get_job_status', { job_id: id })).status === 'completed');
    return parsed(await f.call('get_job_status', { job_id: id }));
  };
  try {
    await f.add('a-later'); await f.add('z-first'); await f.add('empty', false);
    await f.registry.setPriority('empty', 100);
    await f.registry.setPriority('default', 10);
    await f.registry.setPriority('a-later', 20);
    await f.registry.setPriority('z-first', 30);
    f.behavior(async ({ account }) => { if (account === 'z-first') throw new BrowserError('Confirmed quota.', 'image_usage_limit'); });
    const first = parsed(await f.call('generate_image', { prompt: 'prioritized image' }));
    assert.equal(first.account, 'z-first');
    const completed = await finish(first.id);
    assert.equal(completed.executionAccount, 'a-later');
    assert.deepEqual(f.calls.map(call => call.account), ['z-first', 'a-later']);
    await f.registry.rename('z-first', 'Personal images');
    assert.equal(await f.registry.owner(first.id), 'z-first');
    assert.equal((await f.call('get_image', { job_id: first.id })).isError, undefined);
    const second = parsed(await f.call('generate_image', { prompt: 'skip cooling profile' }));
    assert.equal(second.account, 'a-later'); await finish(second.id);
    await f.registry.setPriority('default', 50);
    const third = parsed(await f.call('generate_image', { prompt: 'live new priority' }));
    assert.equal(third.account, 'default'); await finish(third.id);
    await f.registry.select('a-later');
    const fourth = parsed(await f.call('generate_image', { prompt: 'manual choice' }));
    assert.equal(fourth.account, 'a-later'); await finish(fourth.id);
    await f.registry.usePriorityOrder();
    const fifth = parsed(await f.call('generate_image', { prompt: 'priority restored' }));
    assert.equal(fifth.account, 'default'); await finish(fifth.id);
  } finally { await f.close(); }
});

test('automatic failover skips unusable profiles, keeps the job ID and image retrieval, and persists selection', async () => {
  const f = await fixture();
  let release: (() => Promise<void>) | undefined;
  try {
    await f.add('a-empty', false);
    await f.add('b-challenge'); f.statuses.set('b-challenge', { status: 'challenge', message: 'Fixture challenge.' });
    const locked = await f.add('c-locked'); release = await acquireRuntime(locked);
    const cooling = await f.add('d-cooling');
    const saved = new JobStore(cooling.dataDir); saved.recordImageLimit('image_usage_limit', 'Already exhausted.'); saved.close();
    await f.add('e-ready');
    f.behavior(async ({ account }) => { if (account === 'default') throw new BrowserError('Confirmed quota.', 'free_tier_exhausted', 'tomorrow'); });
    const admitted = parsed(await f.call('generate_image', { prompt: 'one image' }));
    const job = await f.finished(admitted.id);
    assert.equal(job.status, 'completed'); assert.equal(job.account, 'default');
    assert.equal(job.executionAccount, 'e-ready'); assert.deepEqual(job.attemptedAccounts, ['default', 'e-ready']);
    assert.deepEqual(f.calls.map(call => call.account), ['default', 'e-ready']);
    assert.equal(await f.registry.owner(job.id), 'default'); assert.equal(await f.registry.active(), 'e-ready');
    const preview = await f.call('wait_for_job', { job_id: job.id, wait_seconds: 0 });
    assert.equal(preview.content.some(item => item.type === 'image'), true);
    assert.ok(parsed(preview).image.path.startsWith(path.join(f.dir, 'accounts/e-ready/images')));
    const cooldown = f.store.imageCooldown();
    await f.registry.use('default');
    const ready = parsed(await f.call('session_status'));
    assert.equal(ready.status, 'ready'); assert.equal(ready.account, 'e-ready');
    assert.equal(f.calls.length, 2, 'Session routing must not submit another prompt');
    const next = parsed(await f.call('generate_image', { prompt: 'skip the saved cooldown' }));
    assert.equal(next.account, 'e-ready');
    await until(async () => parsed(await f.call('get_job_status', { job_id: next.id })).status === 'completed');
    assert.deepEqual(f.store.imageCooldown(), cooldown, 'Skipped profiles retain their original cooldown');
    const history = parsed(await f.call('list_jobs')).jobs;
    assert.ok(history.some((item: any) => item.id === job.id && item.account === 'default'));
    assert.ok(history.some((item: any) => item.id === next.id && item.account === 'e-ready'));
    assert.equal(parsed(await f.call('list_jobs', { limit: 1 })).jobs[0].id, next.id);
    assert.equal((await f.call('get_job_status', { account: 'e-ready', job_id: job.id })).isError, true, 'Removed account inputs are rejected');
  } finally { await release?.(); await f.close(); }
});

test('session status switches an assumed-exhausted account to a ready account without submitting images', async () => {
  const f = await fixture();
  try {
    await f.add('a-challenge'); await f.add('b-ready');
    f.statuses.set('a-challenge', { status: 'challenge', message: 'Verification required' });
    f.store.recordTextOnlyFailure(); f.store.recordTextOnlyFailure();
    const cooldown = f.store.imageCooldown();
    const result = parsed(await f.call('session_status'));
    assert.equal(result.status, 'ready');
    assert.equal(result.account, 'b-ready');
    assert.equal(await f.registry.active(), 'b-ready');
    assert.equal(result.errorCode, undefined);
    assert.deepEqual(f.closed, ['a-challenge', 'b-ready']);
    assert.equal(f.calls.length, 0);
    assert.deepEqual(f.store.imageCooldown(), cooldown);
  } finally { await f.close(); }
});

test('session status reselects if the chosen fallback becomes exhausted before its session is inspected', async () => {
  const f = await fixture();
  try {
    await f.add('second'); await f.add('third');
    f.store.recordImageLimit('image_usage_limit', 'Default quota.');
    const inspect = f.manager.inspectSession.bind(f.manager);
    f.manager.inspectSession = async runtime => {
      if (runtime.account === 'second') runtime.store.recordImageLimit('image_usage_limit', 'Quota detected by concurrent work.');
      return inspect(runtime);
    };
    const result = parsed(await f.call('session_status'));
    assert.equal(result.status, 'ready');
    assert.equal(result.account, 'third');
    assert.equal(await f.registry.active(), 'third');
    assert.equal(f.calls.length, 0);
    assert.deepEqual(f.closed, ['second', 'third']);
  } finally { await f.close(); }
});

for (const status of ['challenge', 'login_required', 'unavailable', 'browser_error'] as const) {
  test(`session status selects an existing fallback and reports ${status} instead of the exhausted account's limit`, async () => {
    const f = await fixture();
    try {
      await f.add('second');
      f.store.recordTextOnlyFailure(); f.store.recordTextOnlyFailure();
      const runtime = await f.manager.resolve('second');
      runtime.browser.sessionStatus = async () => {
        if (status === 'browser_error') throw new BrowserError('Could not initialize dedicated Chrome.');
        return { status, message: 'Replacement session requires attention.' };
      };
      const result = parsed(await f.call('session_status'));
      assert.equal(result.account, 'second');
      assert.equal(result.status, status === 'browser_error' ? 'unavailable' : status);
      assert.equal(await f.registry.active(), 'second');
      for (const key of ['errorCode', 'error', 'detectedAt', 'retryAfter']) assert.equal(result[key], undefined);
      assert.doesNotMatch(result.message, /No other|Assumed|exhausted/);
      assert.equal(f.calls.length, 0);
      assert.deepEqual(f.closed, ['second'], 'Close the selected browser even when readiness fails');
    } finally { await f.close(); }
  });
}

test('session status reports a locked replacement as busy instead of pretending no other account exists', async () => {
  const f = await fixture();
  let release: (() => Promise<void>) | undefined;
  try {
    const config = await f.add('second');
    release = await acquireRuntime(config);
    f.store.recordImageLimit('image_usage_limit', 'Confirmed quota.');
    const result = parsed(await f.call('session_status'));
    assert.equal(result.account, 'second');
    assert.equal(result.status, 'busy');
    assert.match(result.message, /in use/);
    assert.equal(result.errorCode, undefined);
    assert.equal(f.calls.length, 0);
  } finally { await release?.(); await f.close(); }
});

test('session status reports an unreadable replacement session without exposing cookie values or old quota details', async () => {
  const f = await fixture();
  try {
    const config = await f.add('second');
    await writeFile(path.join(config.dataDir, 'session-cookies.json'), 'private-invalid-cookie-store');
    f.store.recordImageLimit('image_usage_limit', 'Confirmed quota.');
    const result = parsed(await f.call('session_status'));
    assert.equal(result.account, 'second');
    assert.equal(result.status, 'unavailable');
    assert.equal(result.errorCode, undefined);
    assert.doesNotMatch(JSON.stringify(result), /private-invalid-cookie-store|No other/);
  } finally { await f.close(); }
});

test('session status switches to a busy replacement promptly without navigating or interrupting generation', { timeout: 5000 }, async () => {
  const f = await fixture();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  try {
    await f.add('second');
    await f.registry.use('second');
    f.behavior(async () => { await gate; });
    const job = parsed(await f.call('generate_image', { prompt: 'hold second' }));
    await until(() => f.calls.length === 1);
    f.store.recordImageLimit('image_usage_limit', 'Confirmed quota.');
    await f.registry.use('default');
    let timer: ReturnType<typeof setTimeout> | undefined;
    let response;
    try {
      response = await Promise.race([f.call('session_status'), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Session status waited behind active generation')), 1000);
      })]);
    } finally { clearTimeout(timer); }
    const result = parsed(response);
    assert.equal(result.account, 'second');
    assert.equal(result.status, 'busy');
    assert.equal(f.calls.length, 1);
    assert.deepEqual(f.closed, []);
    release();
    await until(async () => parsed(await f.call('get_job_status', { job_id: job.id })).status === 'completed');
  } finally { release(); await f.close(); }
});

test('batch failover preserves references and continues in the replacement chat', async () => {
  const f = await fixture();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  try {
    await f.add('second');
    f.behavior(async ({ account, prompt }) => {
      if (prompt === 'first') await gate;
      if (account === 'default' && prompt === 'second') throw new BrowserError('Confirmed quota.', 'image_usage_limit');
    });
    const reference = path.join(f.dir, 'reference.png'); await writeFile(reference, f.image);
    const batch = parsed(await f.call('generate_images', { prompts: ['first', 'second', 'third'], reference_images: [reference], aspect_ratio: '3:4' }));
    await rm(reference); release();
    await until(() => f.store.getBatch(batch.id).status === 'completed');
    const result = parsed(await f.call('get_batch_status', { batch_id: batch.id }));
    assert.equal(result.account, 'default'); assert.deepEqual(result.jobs.map((job: any) => job.id), batch.jobs.map((job: any) => job.id));
    assert.deepEqual(result.jobs.map((job: any) => job.executionAccount), ['default', 'second', 'second']);
    assert.deepEqual(f.calls.map(({ account, prompt }) => [account, prompt]), [['default', 'first'], ['default', 'second'], ['second', 'second'], ['second', 'third']]);
    assert.equal(f.calls[1]!.options.reuseReferences, true);
    assert.equal(f.calls[2]!.options.conversationUrl, undefined); assert.equal(f.calls[2]!.options.reuseReferences, undefined);
    assert.equal(f.calls[3]!.options.conversationUrl, result.jobs[1].conversationUrl);
    assert.equal(f.calls[3]!.options.reuseReferences, true);
    for (const call of f.calls) {
      assert.equal(call.options.aspectRatio, '3:4'); assert.deepEqual(await readFile(call.references[0]!.path), f.image);
    }
  } finally { release(); await f.close(); }
});

test('already queued singles continue in order on the replacement account without resubmitting to the exhausted profile', async () => {
  const f = await fixture();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  try {
    await f.add('second');
    f.behavior(async ({ account }) => {
      if (account === 'default') { await gate; throw new BrowserError('Confirmed quota.', 'image_usage_limit'); }
    });
    const first = parsed(await f.call('generate_image', { prompt: 'first' }));
    const pending = parsed(await f.call('generate_image', { prompt: 'already queued' }));
    const cancelled = parsed(await f.call('generate_image', { prompt: 'cancelled' }));
    await f.call('cancel_job', { job_id: cancelled.id });
    release();
    assert.equal((await f.finished(first.id)).status, 'completed');
    const job = await f.finished(pending.id);
    assert.equal(job.status, 'completed'); assert.equal(job.account, 'default'); assert.equal(job.executionAccount, 'second');
    assert.deepEqual(job.attemptedAccounts, ['second']);
    assert.deepEqual(f.calls.map(call => [call.account, call.prompt]), [['default', 'first'], ['second', 'first'], ['second', 'already queued']]);
  } finally { release(); await f.close(); }
});

test('a manual selection made during fallback readiness is retained for future requests', async () => {
  const f = await fixture();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let checking = false;
  try {
    await f.add('second'); await f.add('third');
    const second = await f.manager.resolve('second');
    second.browser.sessionStatus = async () => { checking = true; await gate; return { status: 'ready', message: 'Fixture ready.' }; };
    f.behavior(async ({ account }) => { if (account === 'default') throw new BrowserError('Confirmed quota.', 'image_usage_limit'); });
    const job = parsed(await f.call('generate_image', { prompt: 'finish on second' }));
    await until(() => checking);
    await f.registry.use('third'); release();
    assert.equal((await f.finished(job.id)).executionAccount, 'second');
    assert.equal(await f.registry.active(), 'third');
  } finally { release(); await f.close(); }
});

test('every account exhausted: bounded attempts, pending jobs stop, and new admission is blocked without copying references', async () => {
  const f = await fixture();
  try {
    await f.add('second'); await f.add('third');
    f.behavior(async () => { throw new BrowserError('Confirmed quota.', 'image_usage_limit'); });
    const batch = parsed(await f.call('generate_images', { prompts: ['limited', 'never submitted'] }));
    await until(() => f.store.getBatch(batch.id).status === 'failed');
    assert.deepEqual(f.calls.map(call => call.account), ['default', 'second', 'third']);
    const result = f.store.getBatch(batch.id);
    assert.equal(result.jobs[0]!.status, 'failed'); assert.equal(result.jobs[1]!.status, 'cancelled');
    assert.equal(result.jobs[0]!.errorCode, 'image_usage_limit'); assert.ok(result.jobs[0]!.retryAfter);
    const blocked = await f.call('generate_image', { prompt: 'blocked', reference_images: [path.join(f.dir, 'missing.png')] });
    assert.equal(blocked.isError, true); assert.equal(parsed(blocked).status, 'blocked');
    assert.equal(f.calls.length, 3); assert.equal(f.store.list().length, 2);
  } finally { await f.close(); }
});

for (const mode of ['disabled', 'timeout'] as const) test(`${mode} requests do not switch or retry`, async () => {
  const f = await fixture(mode !== 'disabled');
  try {
    await f.add('second');
    f.behavior(async () => { throw new BrowserError(mode === 'timeout' ? 'Timed out; submission uncertain.' : 'Confirmed quota.', mode === 'timeout' ? undefined : 'image_usage_limit'); });
    const job = parsed(await f.call('generate_image', { prompt: 'no retry' }));
    const result = await f.finished(job.id);
    assert.equal(result.status, 'failed'); assert.deepEqual(f.calls.map(call => call.account), ['default']);
    assert.equal(await f.registry.active(), 'default');
    if (mode !== 'timeout') {
      const blocked = await f.call('generate_images', { prompts: ['blocked'], reference_images: [path.join(f.dir, 'missing.png')] });
      assert.equal(blocked.isError, true); assert.equal(parsed(blocked).account, 'default');
      assert.equal(parsed(blocked).status, 'blocked');
    } else assert.equal(f.store.imageCooldown(), undefined);
  } finally { await f.close(); }
});

test('requests on another account wait for current generation before switching browsers', async () => {
  const f = await fixture();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let running = 0, maximum = 0;
  try {
    await f.add('second');
    f.behavior(async ({ account, prompt }) => {
      if (account === 'default') throw new BrowserError('Confirmed quota.', 'image_usage_limit');
      running++; maximum = Math.max(maximum, running);
      try { if (prompt === 'hold destination') await gate; } finally { running--; }
    });
    await f.registry.use('second');
    const destination = parsed(await f.call('generate_image', { prompt: 'hold destination' }));
    await f.registry.use('default');
    await until(() => running === 1);
    const forwarded = parsed(await f.call('generate_image', { prompt: 'forwarded' }));
    await delay(20);
    assert.equal(f.store.imageCooldown(), undefined, 'The other account must not open during destination generation');
    assert.equal((await f.manager.inspectSession(await f.manager.resolve('second'))).status, 'busy');
    assert.equal(f.calls.filter(call => call.account === 'second').length, 1);
    release();
    assert.equal((await f.finished(forwarded.id)).status, 'completed');
    await until(async () => parsed(await f.call('get_job_status', { job_id: destination.id })).status === 'completed');
    assert.equal(maximum, 1);
  } finally { release(); await f.close(); }
});

test('quota switching waits for Chrome to close and closes each rejected fallback before opening the next', async () => {
  const f = await fixture();
  let release!: () => void;
  const closing = new Promise<void>(resolve => { release = resolve; });
  const events: string[] = [];
  try {
    await f.add('a-challenge'); await f.add('b-ready');
    const original = await f.manager.resolve('default');
    original.browser.shutdown = async () => { events.push('closing default'); await closing; events.push('closed default'); };
    for (const name of ['a-challenge', 'b-ready']) {
      const runtime = await f.manager.resolve(name);
      runtime.browser.sessionStatus = async () => {
        events.push(`open ${name}`);
        return { status: name === 'a-challenge' ? 'challenge' : 'ready', message: 'Fixture session' };
      };
      runtime.browser.shutdown = async () => { events.push(`closed ${name}`); };
    }
    f.behavior(async ({ account }) => { if (account === 'default') throw new BrowserError('Confirmed quota.', 'image_usage_limit'); });
    const job = parsed(await f.call('generate_image', { prompt: 'switch sequentially' }));
    await until(() => events.includes('closing default'));
    assert.deepEqual(events, ['closing default']);
    await delay(20);
    assert.equal(f.calls.length, 1);
    release();
    assert.equal((await f.finished(job.id)).status, 'completed');
    await until(() => !f.manager.isBusy());
    assert.deepEqual(events, ['closing default', 'closed default', 'open a-challenge', 'closed a-challenge', 'open b-ready', 'closed b-ready']);
  } finally { release(); await f.close(); }
});

test('failed Chrome closure stops switching before any fallback opens', async () => {
  const f = await fixture();
  let checked = 0;
  try {
    await f.add('second'); await f.add('third');
    const original = await f.manager.resolve('default');
    original.browser.shutdown = async () => { throw new Error('Fixture close failed'); };
    for (const name of ['second', 'third']) {
      const runtime = await f.manager.resolve(name);
      runtime.browser.sessionStatus = async () => { checked++; return { status: 'ready', message: 'Ready' }; };
    }
    f.behavior(async ({ account }) => { if (account === 'default') throw new BrowserError('Confirmed quota.', 'image_usage_limit'); });
    const job = parsed(await f.call('generate_image', { prompt: 'stop when Chrome cannot close' }));
    const result = await f.finished(job.id);
    assert.equal(result.status, 'failed');
    assert.match(result.error, /Account switching stopped/);
    assert.equal(checked, 0);
    assert.deepEqual(f.calls.map(call => call.account), ['default']);
    original.browser.shutdown = async () => {};
  } finally { await f.close(); }
});

test('no ready fallback closes the final challenged profile', async () => {
  const f = await fixture();
  try {
    await f.add('second');
    f.statuses.set('second', { status: 'challenge', message: 'Verification required' });
    f.behavior(async () => { throw new BrowserError('Confirmed quota.', 'image_usage_limit'); });
    const job = parsed(await f.call('generate_image', { prompt: 'no ready account' }));
    assert.equal((await f.finished(job.id)).status, 'failed');
    await until(() => !f.manager.isBusy());
    assert.deepEqual(f.closed, ['default', 'second']);
  } finally { await f.close(); }
});

test('restart resumes an automatic queued job on a fallback but never replays an interrupted attempt', async () => {
  const f = await fixture();
  try {
    await f.add('second');
    f.store.recordImageLimit('image_usage_limit', 'Saved quota.');
    const queued = f.store.create('resume queued'); f.store.update(queued.id, { autoSwitchAccount: true });
    const interrupted = f.store.create('do not replay'); f.store.update(interrupted.id, { status: 'running', autoSwitchAccount: true, executionAccount: 'second' });
    // Reopen the owning database exactly as the shared worker does on restart.
    const recovered = new JobStore(f.dir);
    const browser = new ChatGPTBrowser(f.config), queue = new JobQueue(recovered, browser);
    browser.generate = async () => { throw new Error('The exhausted browser must not receive a prompt.'); };
    const manager = new AccountManager(f.registry, { account: 'default', store: recovered, queue, browser }, config => {
      const browser = new ChatGPTBrowser(config);
      browser.sessionStatus = async () => ({ status: 'ready', message: 'Fixture ready.' });
      browser.generate = async () => { f.calls.push({ account: 'second', prompt: 'resume queued', references: [], options: {} }); return { images: [], conversationUrl: 'https://chatgpt.com/c/resumed' }; };
      return browser;
    });
    try {
      queue.kick();
      await until(() => recovered.get(queued.id).status === 'completed');
      assert.equal(recovered.get(interrupted.id).status, 'failed');
      assert.equal(recovered.get(queued.id).executionAccount, 'second');
      assert.equal(await f.registry.owner(queued.id), 'default');
      assert.equal(f.calls.length, 1);
    } finally { await manager.close(); }
  } finally { await f.close(); }
});

test('account switching config defaults on and rejects invalid boolean values', () => {
  assert.equal(loadConfig({}).autoSwitchAccounts, true);
  assert.equal(loadConfig({ CHATGPT_AUTO_SWITCH_ACCOUNTS: 'false' }).autoSwitchAccounts, false);
  assert.throws(() => loadConfig({ CHATGPT_AUTO_SWITCH_ACCOUNTS: 'yes' }), /must be true or false/);
});

for (const references of [false, true]) for (const mandatory of [false, true]) test(`quota after two images: same_chat_mandatory=${mandatory}, references=${references}`, async () => {
  const f = await fixture();
  try {
    await f.add('second');
    f.behavior(async ({ account, prompt }) => {
      if (account === 'default' && prompt === 'third') throw new BrowserError('Confirmed quota.', 'image_usage_limit');
    });
    const reference = path.join(f.dir, 'reference.png');
    if (references) await writeFile(reference, f.image);
    const batch = parsed(await f.call('generate_images', { prompts: ['first', 'second', 'third'], same_chat_mandatory: mandatory,
      aspect_ratio: '16:9', ...(references ? { reference_images: [reference] } : {}) }));
    await until(() => f.store.getBatch(batch.id).status === 'completed');
    const result = parsed(await f.call('get_batch_status', { batch_id: batch.id }));
    assert.equal(result.sameChatMandatory, mandatory); assert.equal(result.attempt, mandatory ? 1 : 0);
    assert.deepEqual(result.jobs.map((job: any) => job.id), batch.jobs.map((job: any) => job.id));
    const expected = [['default', 'first'], ['default', 'second'], ['default', 'third'],
      ...(mandatory ? [['second', 'first'], ['second', 'second']] : []), ['second', 'third']];
    assert.deepEqual(f.calls.map(call => [call.account, call.prompt]), expected);
    assert.deepEqual(result.jobs.map((job: any) => job.executionAccount), mandatory ? ['second', 'second', 'second'] : ['default', 'default', 'second']);
    const fallbackCalls = f.calls.filter(call => call.account === 'second');
    assert.equal(fallbackCalls[0]!.options.conversationUrl, undefined);
    assert.equal(fallbackCalls[0]!.options.reuseReferences, undefined);
    for (const call of f.calls) {
      assert.equal(call.options.aspectRatio, '16:9'); assert.equal(call.references.length, references ? 1 : 0);
      assert.equal(call.options.allowConversationRollover, !mandatory);
      if (references) assert.deepEqual(await readFile(call.references[0]!.path), f.image);
    }
    if (mandatory) {
      assert.equal(new Set(result.jobs.map((job: any) => job.conversationUrl)).size, 1);
      for (const job of result.jobs) {
        assert.equal(job.batchAttempt, 1); assert.equal(job.previousAttempts.length, 1);
        assert.equal(job.previousAttempts[0].executionAccount, 'default');
      }
      for (const job of result.jobs.slice(0, 2)) {
        assert.equal(job.previousAttempts[0].status, 'completed');
        assert.notEqual(job.previousAttempts[0].images[0].path, job.images[0].path);
        assert.deepEqual(await readFile(job.previousAttempts[0].images[0].path), f.image, 'Old images are retained');
      }
      assert.equal(fallbackCalls[1]!.options.conversationUrl, result.jobs[0].conversationUrl);
      assert.equal(fallbackCalls[1]!.options.reuseReferences, true);
    } else assert.ok(result.jobs.every((job: any) => job.previousAttempts === undefined));
  } finally { await f.close(); }
});

test('mandatory batch restarts completely on each replacement and never loops back to a tried account', async () => {
  const f = await fixture();
  try {
    await f.add('second'); await f.add('third');
    f.behavior(async ({ account, prompt }) => {
      if ((account === 'default' && prompt === 'three') || (account === 'second' && prompt === 'two')) {
        throw new BrowserError('Confirmed quota.', 'image_usage_limit');
      }
    });
    const batch = parsed(await f.call('generate_images', { prompts: ['one', 'two', 'three'], same_chat_mandatory: true }));
    await until(() => f.store.getBatch(batch.id).status === 'completed');
    const result = f.store.getBatch(batch.id);
    assert.equal(result.attempt, 2);
    assert.deepEqual(f.calls.map(call => [call.account, call.prompt]), [['default', 'one'], ['default', 'two'], ['default', 'three'],
      ['second', 'one'], ['second', 'two'], ['third', 'one'], ['third', 'two'], ['third', 'three']]);
    assert.ok(result.jobs.every(job => job.executionAccount === 'third' && job.batchAttempt === 2));
    assert.equal(new Set(result.jobs.map(job => job.conversationUrl)).size, 1);
    assert.equal(result.jobs[0]!.previousAttempts!.length, 2);
    assert.deepEqual(result.jobs[0]!.batchTriedAccounts, ['default', 'second', 'third']);
  } finally { await f.close(); }
});

test('mandatory batch preserves partial history and stops when all accounts run out', async () => {
  const f = await fixture();
  try {
    await f.add('second');
    f.behavior(async ({ prompt }) => { if (prompt === 'two') throw new BrowserError('Confirmed quota.', 'image_usage_limit'); });
    const batch = parsed(await f.call('generate_images', { prompts: ['one', 'two', 'three'], same_chat_mandatory: true }));
    await until(() => f.store.getBatch(batch.id).status === 'failed');
    const result = f.store.getBatch(batch.id);
    assert.deepEqual(result.jobs.map(job => job.status), ['completed', 'failed', 'cancelled']);
    assert.deepEqual(f.calls.map(call => [call.account, call.prompt]), [['default', 'one'], ['default', 'two'], ['second', 'one'], ['second', 'two']]);
    assert.equal(result.jobs[0]!.executionAccount, 'second');
    assert.equal(result.jobs[0]!.previousAttempts![0]!.executionAccount, 'default');
    assert.deepEqual(await readFile(result.jobs[0]!.previousAttempts![0]!.images![0]!.path), f.image);
  } finally { await f.close(); }
});

test('removed different_chat input is rejected before any work is admitted', async () => {
  const f = await fixture();
  try {
    const result = await f.call('generate_images', { prompts: ['one'], same_chat_mandatory: true, different_chat: true });
    assert.equal(result.isError, true); assert.match(JSON.stringify(result.content), /different_chat/);
    assert.equal(f.store.list().length, 0); assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});

test('mandatory batch reserves its replay capacity until completion', async () => {
  const f = await fixture();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  try {
    f.behavior(async ({ prompt }) => { if (prompt === 'hold') await gate; });
    const batch = parsed(await f.call('generate_images', { prompts: ['first', 'hold', ...Array.from({ length: 23 }, (_, i) => `next-${i}`)], same_chat_mandatory: true }));
    await until(() => f.calls.some(call => call.prompt === 'hold'));
    assert.equal(f.store.queueCapacityUsed(), 25);
    const blocked = await f.call('generate_image', { prompt: 'overflow' });
    assert.equal(blocked.isError, true); assert.match(JSON.stringify(blocked.content), /Queue is full/);
    release(); await until(() => f.store.getBatch(batch.id).status === 'completed');
    assert.equal(f.store.queueCapacityUsed(), 0);
  } finally { release(); await f.close(); }
});

test('a persisted mandatory batch restart resumes from prompt one on its recorded replacement profile', async () => {
  const f = await fixture();
  try {
    await f.add('second');
    f.store.recordImageLimit('image_usage_limit', 'Saved quota.');
    const batch = f.store.createBatch(['one', 'two', 'three'], 'same_chat', [], '3:4', true, true);
    const previousImage = path.join(f.dir, 'previous.png'); await writeFile(previousImage, f.image);
    f.store.update(batch.jobs[0]!.id, { status: 'completed', executionAccount: 'default', attemptedAccounts: ['default'],
      conversationUrl: 'https://chatgpt.com/c/original', images: [{ path: previousImage, mimeType: 'image/png', bytes: f.image.length }] });
    f.store.update(batch.jobs[1]!.id, { status: 'running', executionAccount: 'default', attemptedAccounts: ['default'] });
    f.store.restartBatch(batch.id, 'second', batch.jobs[1]!.id, 'Confirmed quota.');
    await f.manager.close();
    f.config.autoSwitchAccounts = false; // Disabling future failover must not split the already accepted mandatory batch.
    const recovered = new JobStore(f.dir), browser = f.factory(f.config, 'default'), queue = new JobQueue(recovered, browser);
    const manager = new AccountManager(f.registry, { account: 'default', store: recovered, queue, browser }, f.factory);
    try {
      queue.kick(); await until(() => recovered.getBatch(batch.id).status === 'completed');
      const result = recovered.getBatch(batch.id);
      assert.equal(result.sameChatMandatory, true); assert.equal(result.attempt, 1);
      assert.deepEqual(f.calls.map(call => [call.account, call.prompt]), [['second', 'one'], ['second', 'two'], ['second', 'three']]);
      assert.equal(new Set(result.jobs.map(job => job.conversationUrl)).size, 1);
      assert.deepEqual(await readFile(result.jobs[0]!.previousAttempts![0]!.images![0]!.path), f.image);
    } finally { await manager.close(); }
  } finally { await f.close(); }
});

test('an uncertain failure in a mandatory batch stops it without replaying completed prompts', async () => {
  const f = await fixture();
  try {
    await f.add('second');
    f.behavior(async ({ prompt }) => { if (prompt === 'two') throw new BrowserError('Timed out; submission uncertain.'); });
    const batch = parsed(await f.call('generate_images', { prompts: ['one', 'two', 'three'], same_chat_mandatory: true }));
    await until(() => f.store.getBatch(batch.id).status === 'failed');
    const result = f.store.getBatch(batch.id);
    assert.equal(result.attempt, 0); assert.deepEqual(result.jobs.map(job => job.status), ['completed', 'failed', 'cancelled']);
    assert.deepEqual(f.calls.map(call => [call.account, call.prompt]), [['default', 'one'], ['default', 'two']]);
    assert.equal(f.store.imageCooldown(), undefined);
  } finally { await f.close(); }
});

test('a mandatory batch cannot complete with results from an unexpectedly changed conversation', async () => {
  const f = await fixture();
  try {
    await f.add('second');
    const runtime = await f.manager.resolve('default');
    const generate = runtime.browser.generate.bind(runtime.browser);
    runtime.browser.generate = async (...args) => {
      const result = await generate(...args);
      return args[1] === 'two' ? { ...result, conversationUrl: 'https://chatgpt.com/c/unexpected' } : result;
    };
    const batch = parsed(await f.call('generate_images', { prompts: ['one', 'two', 'three'], same_chat_mandatory: true }));
    await until(() => f.store.getBatch(batch.id).status === 'failed');
    const result = f.store.getBatch(batch.id);
    assert.deepEqual(result.jobs.map(job => job.status), ['completed', 'failed', 'cancelled']);
    assert.match(result.jobs[1]!.error!, /changed the required batch conversation/);
    assert.equal(result.jobs[1]!.conversationUrl, 'https://chatgpt.com/c/unexpected');
    assert.equal(f.calls.length, 2); assert.equal(f.store.imageCooldown(), undefined);
    assert.deepEqual(await readFile(result.jobs[1]!.images![0]!.path), f.image);
  } finally { await f.close(); }
});

for (const mandatory of [false, true]) test(`second consecutive text-only response switches account and finishes the remaining batch: mandatory=${mandatory}`, async () => {
  const f = await fixture();
  try {
    await f.add('second');
    f.behavior(async ({ account }) => { if (account === 'default') throw new TextOnlyResponseError(); });
    const first = parsed(await f.call('generate_image', { prompt: 'first text-only failure' }));
    assert.equal((await f.finished(first.id)).status, 'failed');
    assert.equal(f.store.imageCooldown(), undefined, 'One text-only response must not exhaust or retry the account');
    assert.deepEqual(f.calls.map(call => call.account), ['default']);
    const reference = path.join(f.dir, 'reference.png'); await writeFile(reference, f.image);
    const batch = parsed(await f.call('generate_images', { prompts: ['cafe', 'flight'], reference_images: [reference],
      same_chat_mandatory: mandatory, aspect_ratio: '3:4' }));
    await until(() => f.store.getBatch(batch.id).status === 'completed');
    const result = f.store.getBatch(batch.id);
    assert.deepEqual(f.calls.map(call => [call.account, call.prompt]),
      [['default', 'first text-only failure'], ['default', 'cafe'], ['second', 'cafe'], ['second', 'flight']]);
    assert.equal(f.store.imageCooldown()?.errorCode, 'image_usage_limit');
    assert.match(f.store.imageCooldown()!.error, /Assumed.*two consecutive.*text-only/);
    assert.equal(result.attempt, mandatory ? 1 : 0);
    assert.ok(result.jobs.every(job => job.executionAccount === 'second'));
    assert.equal(f.calls[2]!.options.conversationUrl, undefined);
    assert.equal(f.calls[2]!.options.reuseReferences, undefined);
    assert.equal(f.calls[3]!.options.conversationUrl, result.jobs[0]!.conversationUrl);
    assert.equal(f.calls[3]!.options.reuseReferences, true);
    for (const call of f.calls.slice(1)) {
      assert.equal(call.options.aspectRatio, '3:4');
      assert.deepEqual(await readFile(call.references[0]!.path), f.image);
    }
    assert.equal(f.store.get(first.id).status, 'failed', 'Do not replay earlier failed requests');
  } finally { await f.close(); }
});

for (const interruption of ['success', 'timeout'] as const) test(`${interruption} resets consecutive text-only failures`, async () => {
  const f = await fixture();
  try {
    await f.add('second');
    f.behavior(async ({ prompt }) => {
      if (prompt.startsWith('text')) throw new TextOnlyResponseError();
      if (prompt === 'timeout') throw new BrowserError('Timed out; submission uncertain.');
    });
    for (const prompt of ['text one', interruption, 'text two']) {
      const job = parsed(await f.call('generate_image', { prompt }));
      await f.finished(job.id);
      assert.equal(f.store.imageCooldown(), undefined);
    }
    assert.deepEqual(f.calls.map(call => call.account), ['default', 'default', 'default']);
    const job = parsed(await f.call('generate_image', { prompt: 'text three' }));
    const result = await f.finished(job.id);
    // Both accounts return text: the replacement has only one failure and is not exhausted.
    assert.equal(result.status, 'failed');
    assert.deepEqual(result.attemptedAccounts, ['default', 'second']);
    assert.ok(f.store.imageCooldown());
    assert.equal((await f.manager.resolve('second')).store.imageCooldown(), undefined);
  } finally { await f.close(); }
});

for (const mode of ['disabled', 'no fallback'] as const) test(`text-only threshold with ${mode} persists cooldown and blocks new admission`, async () => {
  const f = await fixture(mode !== 'disabled');
  try {
    if (mode === 'disabled') await f.add('second');
    f.behavior(async () => { throw new TextOnlyResponseError(); });
    for (const prompt of ['one', 'two']) {
      const job = parsed(await f.call('generate_image', { prompt }));
      assert.equal((await f.finished(job.id)).status, 'failed');
    }
    assert.deepEqual(f.calls.map(call => call.account), ['default', 'default']);
    const cooldown = f.store.imageCooldown()!;
    assert.equal(cooldown.errorCode, 'image_usage_limit');
    const blocked = await f.call('generate_image', { prompt: 'blocked', reference_images: [path.join(f.dir, 'missing.png')] });
    assert.equal(blocked.isError, true);
    assert.equal(parsed(blocked).status, 'blocked');
    assert.equal(parsed(blocked).retryAfter, cooldown.retryAfter);
    assert.deepEqual(f.store.imageCooldown(), cooldown, 'Admission must not extend the cooldown');
  } finally { await f.close(); }
});

test('forwarded text-only failures exhaust the execution account and can continue on a third account', async () => {
  const f = await fixture();
  try {
    await f.add('second'); await f.add('third');
    const second = await f.manager.resolve('second');
    assert.equal(second.store.recordTextOnlyFailure(), undefined);
    f.behavior(async ({ account }) => {
      if (account === 'default') throw new BrowserError('Confirmed quota.', 'image_usage_limit');
      if (account === 'second') throw new TextOnlyResponseError();
    });
    const job = parsed(await f.call('generate_image', { prompt: 'forwarded' }));
    const result = await f.finished(job.id);
    assert.equal(result.status, 'completed');
    assert.equal(result.account, 'default');
    assert.equal(result.executionAccount, 'third');
    assert.deepEqual(result.attemptedAccounts, ['default', 'second', 'third']);
    assert.match(second.store.imageCooldown()!.error, /two consecutive.*text-only/);
    assert.equal((await f.manager.resolve('third')).store.imageCooldown(), undefined);
  } finally { await f.close(); }
});
