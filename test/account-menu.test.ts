import './support/headless.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AccountRegistry } from '../src/accounts.js';
import { manageAccounts } from '../src/account-menu.js';
import { loadConfig } from '../src/config.js';
import { saveCookies } from '../src/session-store.js';
import { JobStore } from '../src/store.js';
import { acquireRuntime } from '../src/runtime.js';

test('fresh installations and empty worker databases have no implicit default account', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'images-empty-accounts-'));
  const registry = new AccountRegistry(loadConfig({ CHATGPT_DATA_DIR: dir }));
  try {
    const store = new JobStore(dir); store.close();
    assert.deepEqual(await registry.names(), []);
    assert.equal(await registry.active(), undefined);
    assert.deepEqual((await registry.list()).accounts, []);
    assert.equal((await registry.list()).active_account, null);
    await assert.rejects(registry.require('default'), /Unknown account/);
    const answers = ['2', '0'], messages: string[] = [];
    await manageAccounts(registry, { question: async () => answers.shift()!, print: message => messages.push(message) });
    assert.match(messages.join('\n'), /No accounts configured/);
    assert.match(messages.join('\n'), /8\) Delete an account/);
    await registry.add('personal');
    assert.deepEqual(await registry.names(), ['personal']);
    assert.equal(await registry.active(), 'personal');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('the delete menu cancels without changes and deletes the selected last account after confirmation', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'images-delete-menu-'));
  const registry = new AccountRegistry(loadConfig({ CHATGPT_DATA_DIR: dir }));
  const config = await registry.add('work');
  await writeFile(path.join(config.dataDir, 'session-cookies.json'), '[]');
  await registry.select('work');
  try {
    for (const confirm of ['', 'wrong']) {
      const answers = ['8', '1', confirm, '0'];
      await manageAccounts(registry, { question: async () => answers.shift()!, print: () => {} });
      assert.deepEqual(await registry.names(), ['work']);
      assert.equal(await registry.active(), 'work');
    }
    const answers = ['8', '1', 'work', '0'], messages: string[] = [];
    await manageAccounts(registry, { question: async () => answers.shift()!, print: message => messages.push(message) });
    assert.match(messages.join('\n'), /Deleted work/);
    const listing = await new AccountRegistry(registry.baseConfig).list();
    assert.deepEqual(listing.accounts, []);
    assert.equal(listing.active_account, null);
    assert.equal(listing.selection_mode, 'priority');
    assert.equal(listing.manual_account, undefined);
    await assert.rejects(stat(config.dataDir), { code: 'ENOENT' });
    await registry.add('work');
    assert.deepEqual(await registry.names(), ['work']);
    assert.equal((await registry.list()).accounts[0]!.has_saved_session, false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('deleting a selected account falls back to a remaining profile and cannot delete a locked account', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'images-delete-lock-'));
  const registry = new AccountRegistry(loadConfig({ CHATGPT_DATA_DIR: dir }));
  const work = await registry.add('work');
  await registry.add('personal');
  await registry.select('work');
  let release: (() => Promise<void>) | undefined = await acquireRuntime(work);
  try {
    await assert.rejects(registry.remove('work'), /in use/);
    assert.equal(await registry.active(), 'work');
    await release(); release = undefined;
    await registry.remove('work');
    const listing = await registry.list();
    assert.deepEqual(await registry.names(), ['personal']);
    assert.equal(listing.active_account, 'personal');
    assert.equal(listing.selection_mode, 'priority');
    await assert.rejects(registry.remove('../escape'), /Account names/);
    await assert.rejects(registry.remove('missing'), /Unknown account/);
  } finally { await release?.(); await rm(dir, { recursive: true, force: true }); }
});

test('deleting a legacy default account retains shared settings and other accounts and never recreates it', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'images-delete-default-'));
  const external = path.join(dir, 'external-cookies.json');
  await writeFile(external, '[]');
  const registry = new AccountRegistry(loadConfig({ CHATGPT_DATA_DIR: dir, CHATGPT_COOKIES_FILE: external }));
  await writeFile(path.join(dir, 'session-cookies.json'), '[]');
  await mkdir(path.join(dir, 'chrome-profile'));
  const store = new JobStore(dir); store.create('legacy job'); store.close();
  const other = await registry.add('work');
  await registry.select('default');
  try {
    await registry.remove('default');
    assert.deepEqual(await new AccountRegistry(registry.baseConfig).names(), ['work']);
    assert.equal((await registry.list()).active_account, 'work');
    await stat(other.dataDir);
    await stat(path.join(dir, 'account-settings.json'));
    for (const name of ['session-cookies.json', 'chrome-profile', 'jobs.sqlite']) await assert.rejects(stat(path.join(dir, name)), { code: 'ENOENT' });
    assert.equal(await readFile(external, 'utf8'), '[]');
    await registry.remove('work');
    assert.deepEqual(await registry.names(), []);
    await registry.add('default');
    assert.deepEqual(await registry.names(), ['default'], 'Only explicitly adding default recreates it');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('interactive menu adds, renames, prioritizes and selects profiles, then restores automatic order', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'images-account-menu-'));
  const registry = new AccountRegistry(loadConfig({ CHATGPT_DATA_DIR: dir }));
  const answers = ['9', '1', 'work', '3', '1', 'Work images', '4', 'work', '102', '5', 'work', '6', '2', '1', '0'];
  const messages: string[] = [], pasted: string[] = [];
  try {
    await manageAccounts(registry, {
      question: async () => { assert.ok(answers.length); return answers.shift()!; },
      print: message => messages.push(message),
    }, async account => { pasted.push(account); });
    assert.deepEqual(pasted, ['work', 'work']);
    const saved = await new AccountRegistry(registry.baseConfig).list();
    assert.equal(saved.selection_mode, 'priority');
    assert.equal(saved.accounts[0]?.account, 'work');
    assert.equal(saved.accounts[0]?.display_name, 'Work images');
    assert.equal(saved.accounts[0]?.priority, 102);
    assert.match(messages.join('\n'), /Choose an option/);
    assert.match(messages.join('\n'), /manual selection \(work\)/);
    assert.match(messages.join('\n'), /Automatic priority order enabled/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('renaming preserves credential files and job ownership; concurrent settings updates persist privately', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'images-account-settings-'));
  const registry = new AccountRegistry(loadConfig({ CHATGPT_DATA_DIR: dir }));
  await saveCookies(dir, [{ name: '__Secure-next-auth.session-token', value: 'private-fixture', domain: '.chatgpt.com', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' }]);
  const original = await readFile(path.join(dir, 'session-cookies.json'));
  const store = new JobStore(dir), job = store.create('Keep existing history');
  store.close();
  try {
    await registry.add('second');
    const other = new AccountRegistry(registry.baseConfig);
    await Promise.all([registry.rename('default', 'Personal'), other.setPriority('second', 2), registry.setPriority('default', 1)]);
    const listed = await other.list();
    assert.equal(listed.accounts.find(account => account.account === 'default')?.display_name, 'Personal');
    assert.deepEqual(await other.orderedNames(), ['second', 'default']);
    assert.equal(await other.owner(job.id), 'default');
    assert.deepEqual(await readFile(path.join(dir, 'session-cookies.json')), original);
    const file = path.join(dir, 'account-settings.json');
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.doesNotMatch(await readFile(file, 'utf8'), /private-fixture/);
    for (const priority of [-1, 0.5, NaN, Infinity, 1000000]) await assert.rejects(registry.setPriority('default', priority), /Priority/);
    await assert.rejects(registry.rename('default', '\x1b[31m'), /Display names/);
    await registry.select('default');
    assert.deepEqual(await other.orderedNames(), ['default', 'second']);
    await other.usePriorityOrder();
    assert.deepEqual(await registry.orderedNames(), ['second', 'default']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('new accounts receive maximum priority + 1, including concurrent additions and custom priorities', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'images-priority-allocation-'));
  const registry = new AccountRegistry(loadConfig({ CHATGPT_DATA_DIR: dir }));
  const other = new AccountRegistry(registry.baseConfig);
  const priority = async (name: string) => (await registry.list()).accounts.find(account => account.account === name)!.priority;
  try {
    await registry.add('first');
    assert.equal(await priority('first'), 1);
    await registry.setPriority('first', 500);
    await other.add('second');
    assert.equal(await priority('second'), 501);
    await registry.add('default');
    await registry.setPriority('default', 900);
    await other.add('third');
    assert.equal(await priority('third'), 901);
    await Promise.all([registry.add('fourth'), other.add('fifth')]);
    assert.deepEqual([await priority('fourth'), await priority('fifth')].sort((a, b) => a - b), [902, 903]);
    const expected = (await registry.list()).accounts.map(account => account.account);
    assert.deepEqual(await other.orderedNames(), expected);
    await assert.rejects(other.add('first'), /already exists/);
    await registry.setPriority('third', 999999);
    await assert.rejects(other.add('overflow'), /maximum priority/);
    assert.equal((await registry.names()).includes('overflow'), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
