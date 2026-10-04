import './support/headless.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { AccountManager, AccountRegistry } from '../src/accounts.js';
import { ChatGPTBrowser } from '../src/browser.js';
import { loadConfig } from '../src/config.js';
import { JobStore } from '../src/store.js';
import { JobQueue } from '../src/queue.js';
import { createServer } from '../src/server.js';
import { inspectSavedSession } from '../src/saved-session.js';
import { saveCookies } from '../src/session-store.js';

const token = (expires = -1, name = '__Secure-next-auth.session-token') => ({
  name, value: 'private-fixture-token', domain: '.chatgpt.com', path: '/', expires,
});

async function fixture(switching = true, managed = true) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'images-offline-status-'));
  const config = loadConfig({ CHATGPT_DATA_DIR: dir, CHATGPT_AUTO_SWITCH_ACCOUNTS: String(switching) });
  const registry = new AccountRegistry(config);
  await registry.add('default');
  await registry.setPriority('default', 100);
  const store = new JobStore(dir), browser = new ChatGPTBrowser(config), queue = new JobQueue(store, browser);
  let browserCalls = 0;
  const forbidden = async (): Promise<never> => { browserCalls++; throw new Error('Status touched a browser'); };
  browser.open = forbidden; browser.sessionStatus = forbidden; browser.shutdown = forbidden;
  const manager = new AccountManager(registry, { account: 'default', store, browser, queue }, () => {
    browserCalls++; throw new Error('Status opened another runtime');
  });
  const server = createServer(store, queue, browser, managed ? manager : undefined);
  const client = new Client({ name: 'offline-session-test', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st); await client.connect(ct);
  const call = async () => {
    const result = await client.callTool({ name: 'session_status', arguments: {} });
    assert.equal(result.isError, undefined);
    assert.equal(browserCalls, 0, 'No browser lifecycle, live check, or runtime creation');
    return JSON.parse((result.content[0] as { text: string }).text);
  };
  return { dir, config, registry, store, browser, queue, manager, client, call,
    async add(name: string, expires = -1) {
      const c = await registry.add(name);
      await registry.setPriority(name, 100);
      await saveCookies(c.dataDir, [token(expires)]);
      return c;
    },
    async close() {
      browser.shutdown = async () => {};
      await client.close(); await server.close(); await manager.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test('offline session status switches expired accounts and leaves saved cookies unchanged', async () => {
  const f = await fixture();
  try {
    await saveCookies(f.dir, [token(Date.now() / 1000 - 60)]);
    const expired = await f.add('a-expired', Date.now() / 1000 - 60);
    await f.add('b-ready', Date.now() / 1000 + 3600);
    const file = path.join(expired.dataDir, 'session-cookies.json');
    const original = await readFile(file);
    assert.deepEqual(await f.call(), { status: 'ready' });
    await f.registry.select('default');
    assert.deepEqual(await f.call(), { status: 'ready' });
    assert.equal(await f.registry.manualSelection(), 'b-ready', 'Subsequent generation uses the unexpired replacement');
    assert.equal(await f.registry.active(), 'b-ready');
    assert.deepEqual(await readFile(file), original);
    assert.deepEqual(await f.call(), { status: 'ready' });
    const tools = await f.client.listTools();
    assert.equal(tools.tools.find(t => t.name === 'session_status')!.annotations?.openWorldHint, false);
  } finally { await f.close(); }
});

test('offline session status reports login_required when all saved sessions are expired', async () => {
  const f = await fixture();
  try {
    await saveCookies(f.dir, [token(1)]); await f.add('second', 1);
    const state = await f.call();
    assert.equal(state.status, 'login_required'); assert.match(state.message, /expired/);
    assert.doesNotMatch(JSON.stringify(state), /private-fixture-token/);
  } finally { await f.close(); }
});

test('offline status respects disabled switching and manual selection', async () => {
  const f = await fixture(false);
  try {
    await saveCookies(f.dir, [token(1)]); await f.add('second');
    assert.equal((await f.call()).status, 'login_required');
    await f.registry.select('second');
    assert.deepEqual(await f.call(), { status: 'ready' });
    await saveCookies(f.dir, [token()]);
    f.store.recordImageLimit('image_usage_limit', 'Private cooldown explanation');
    await f.registry.select('default');
    assert.deepEqual(await f.call(), { status: 'usage_limit', retryAfter: f.store.imageCooldown()!.retryAfter });
    await f.registry.add('empty');
    await f.registry.select('empty');
    assert.equal((await f.call()).status, 'login_required', 'Disabled switching respects an empty manual choice');
  } finally { await f.close(); }
});

test('expired sessions require login even when cooldowns also exist', async () => {
  const f = await fixture();
  try {
    await saveCookies(f.dir, [token(1)]); await f.add('second', 1);
    f.store.recordImageLimit('image_usage_limit', 'Old quota does not make expired credentials usable');
    const state = await f.call();
    assert.equal(state.status, 'login_required'); assert.match(state.message, /expired/);
    assert.equal(state.retryAfter, undefined); assert.equal(state.reason, undefined);
  } finally { await f.close(); }
});

test('offline status reads quota history without recovering another profile running job', async () => {
  const f = await fixture();
  try {
    await saveCookies(f.dir, [token()]);
    f.store.recordImageLimit('image_usage_limit', 'Default cooldown');
    const second = await f.add('a-limited');
    const history = new JobStore(second.dataDir);
    const limit = history.recordImageLimit('image_usage_limit', 'Historical quota');
    const failed = history.create('private prompt');
    history.update(failed.id, { status: 'failed', errorCode: limit.errorCode, limitDetectedAt: limit.detectedAt, retryAfter: limit.retryAfter });
    const running = history.create('Must not recover this job');
    history.update(running.id, { status: 'running' }); history.close();
    const db = new Database(path.join(second.dataDir, 'jobs.sqlite'));
    db.prepare("DELETE FROM settings WHERE key = 'image_cooldown'").run();
    const before = db.prepare('SELECT body FROM jobs WHERE id = ?').get(running.id);
    await f.add('b-ready');
    assert.deepEqual(await f.call(), { status: 'ready' });
    assert.equal(await f.registry.active(), 'b-ready');
    assert.deepEqual(db.prepare('SELECT body FROM jobs WHERE id = ?').get(running.id), before);
    assert.equal(db.prepare("SELECT 1 FROM settings WHERE key = 'image_cooldown'").get(), undefined);
    db.close();
  } finally { await f.close(); }
});

test('offline status uses persisted cooldown settings for unopened profiles', async () => {
  const f = await fixture();
  try {
    await saveCookies(f.dir, [token(1)]);
    const a = await f.add('a-limited');
    const history = new JobStore(a.dataDir); history.recordImageLimit('image_usage_limit', 'Saved limit'); history.close();
    await f.add('b-ready');
    assert.deepEqual(await f.call(), { status: 'ready' });
    assert.equal(await f.registry.active(), 'b-ready');
    const old = new JobStore(a.dataDir);
    old.recordImageLimit('image_usage_limit', 'Expired history', undefined, new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString());
    old.close();
    await f.registry.select('a-limited');
    assert.deepEqual(await f.call(), { status: 'ready' });
    assert.equal(await f.registry.active(), 'a-limited', 'An expired cooldown no longer excludes this saved session');
  } finally { await f.close(); }
});

test('single-profile status uses saved credentials without live browser checks', async () => {
  const f = await fixture(true, false);
  try {
    assert.equal((await f.call()).status, 'login_required');
    await saveCookies(f.dir, [token()]);
    assert.deepEqual(await f.call(), { status: 'ready' });
    await saveCookies(f.dir, [token(1)]);
    assert.equal((await f.call()).status, 'login_required');
  } finally { await f.close(); }
});

test('saved session checks reject incomplete expired token parts and handle cookie export expiry', async () => {
  const f = await fixture();
  try {
    await saveCookies(f.dir, [token(-1, '__Secure-next-auth.session-token.0'), token(1, '__Secure-next-auth.session-token.1')]);
    assert.equal((await f.call()).status, 'login_required');
    await saveCookies(f.dir, [token(-1, '__Secure-next-auth.session-token.1')]);
    assert.equal((await f.call()).status, 'unavailable');
    const file = path.join(f.dir, 'export.json');
    const exported = { ...token(), expires: undefined, expirationDate: Date.now() / 1000 + 3600 };
    await writeFile(file, JSON.stringify({ cookies: [exported] }));
    assert.deepEqual(await inspectSavedSession({ ...f.config, cookiesFile: file }), { status: 'ready' });
    await writeFile(file, JSON.stringify({ cookies: [{ ...exported, expirationDate: 1 }] }));
    assert.equal((await inspectSavedSession({ ...f.config, cookiesFile: file })).status, 'login_required');
    await writeFile(file, 'private-invalid-data');
    const state = await inspectSavedSession({ ...f.config, cookiesFile: file });
    assert.equal(state.status, 'unavailable'); assert.doesNotMatch(JSON.stringify(state), /private-invalid-data/);
  } finally { await f.close(); }
});
