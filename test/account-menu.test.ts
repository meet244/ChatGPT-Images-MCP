import './support/headless.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AccountRegistry } from '../src/accounts.js';
import { manageAccounts, type AccountMenuActions, type AccountMenuIO, type MenuChoice } from '../src/account-menu.js';
import { accountOverview, describeStatus } from '../src/account-overview.js';
import { loadConfig } from '../src/config.js';
import { saveCookies } from '../src/session-store.js';
import { JobStore } from '../src/store.js';
import { acquireRuntime } from '../src/runtime.js';

const CANCEL = Symbol('cancel');
type Step = string | typeof CANCEL | ((choices: MenuChoice<string>[]) => string);
/** Scripted terminal: each select/text prompt consumes the next step and fails on unexpected prompts. */
function scripted(steps: Step[]) {
  const printed: string[] = [], menus: { message: string; choices: MenuChoice<string>[]; initial?: string }[] = [], rejected: string[] = [];
  const next = (message: string): Step => {
    assert.ok(steps.length, `Unexpected prompt: ${message}`);
    return steps.shift()!;
  };
  const io: AccountMenuIO = {
    async select(message, choices, initial) {
      menus.push({ message, choices, ...(initial !== undefined ? { initial } : {}) });
      const step = next(message);
      if (step === CANCEL) return undefined;
      const value = typeof step === 'function' ? step(choices) : step;
      assert.ok(choices.some(choice => choice.value === value), `'${value}' is not offered by "${message}": ${choices.map(choice => choice.value).join(', ')}`);
      return value as never;
    },
    async text(message, options = {}) {
      let step = next(message);
      // Record validation failures, then continue with the following step as the corrected answer.
      while (typeof step === 'string' && options.validate?.(step)) { rejected.push(options.validate(step)!); step = next(message); }
      if (step === CANCEL) return undefined;
      return step as string;
    },
    print(message) { printed.push(message); },
  };
  const actions = { calls: [] as string[] } as AccountMenuActions & { calls: string[] };
  for (const name of ['signIn', 'pasteCookies', 'closeBrowser', 'prepare'] as const) actions[name] = async (account: string) => { actions.calls.push(`${name}:${account}`); };
  return { io, actions, printed, menus, rejected, done: () => assert.deepEqual(steps, [], 'Every scripted answer is used') };
}
const mainMenu = (menus: { message: string; choices: MenuChoice<string>[] }[]) => menus.filter(menu => menu.message.startsWith('ChatGPT accounts')).at(-1)!;

test('fresh installations start empty and the menu offers adding an account first', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'images-empty-accounts-'));
  const registry = new AccountRegistry(loadConfig({ CHATGPT_DATA_DIR: dir }));
  try {
    const store = new JobStore(dir); store.close();
    assert.deepEqual(await registry.names(), []);
    assert.equal(await registry.active(), undefined);
    assert.equal((await registry.list()).active_account, null);
    await assert.rejects(registry.require('default'), /Unknown account/);
    const terminal = scripted([CANCEL]);
    await manageAccounts(registry, terminal.io, terminal.actions);
    terminal.done();
    assert.match(terminal.printed.join('\n'), /No accounts yet/);
    const menu = mainMenu(terminal.menus);
    assert.deepEqual(menu.choices.map(choice => choice.value), ['add', 'exit']);
    assert.equal(terminal.menus[0]!.initial, 'add');
    assert.deepEqual(terminal.actions.calls, []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('adding an account validates its name, then signs in with Chrome by default or with cookies on request', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'images-add-menu-'));
  const registry = new AccountRegistry(loadConfig({ CHATGPT_DATA_DIR: dir }));
  try {
    const terminal = scripted(['add', 'Bad Name', 'main', 'browser', 'add', 'main', 'work', 'cookies', 'add', 'spare', 'later', 'exit']);
    await manageAccounts(registry, terminal.io, terminal.actions);
    terminal.done();
    assert.deepEqual(terminal.rejected, ['Use lowercase letters, digits, - or _, starting with a letter (max 48).', 'An account with this name already exists.']);
    // The session lock is prepared before every browser or cookie action.
    assert.deepEqual(terminal.actions.calls, ['prepare:main', 'signIn:main', 'prepare:work', 'pasteCookies:work']);
    assert.deepEqual(await registry.names(), ['main', 'spare', 'work']);
    const methods = terminal.menus.find(menu => menu.message === 'How do you want to sign in?')!;
    assert.equal(methods.initial, 'browser');
    assert.match(terminal.printed.join('\n'), /Added spare/);
    // Newest accounts get the highest priority, so they appear first.
    assert.deepEqual(mainMenu(terminal.menus).choices.map(choice => choice.value), ['account:spare', 'account:work', 'account:main', 'add', 'exit']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('the delete action asks for the profile ID, frees its lock first, and keeps the account on a wrong answer', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'images-delete-menu-'));
  const registry = new AccountRegistry(loadConfig({ CHATGPT_DATA_DIR: dir }));
  const config = await registry.add('work');
  await writeFile(path.join(config.dataDir, 'session-cookies.json'), '[]');
  await registry.select('work');
  try {
    const cancelled = scripted(['account:work', 'delete', 'wrong', 'exit']);
    await manageAccounts(registry, cancelled.io, cancelled.actions);
    cancelled.done();
    assert.deepEqual(await registry.names(), ['work']);
    assert.match(cancelled.printed.join('\n'), /Nothing was deleted/);
    assert.deepEqual(cancelled.actions.calls, []);
    const confirmed = scripted(['account:work', 'delete', 'work', 'exit']);
    await manageAccounts(registry, confirmed.io, confirmed.actions);
    confirmed.done();
    assert.deepEqual(confirmed.actions.calls, ['prepare:work']);
    const listing = await new AccountRegistry(registry.baseConfig).list();
    assert.deepEqual(listing.accounts, []);
    assert.equal(listing.selection_mode, 'priority');
    await assert.rejects(stat(config.dataDir), { code: 'ENOENT' });
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

test('account actions rename, reorder with move up/down, pin an account first, and restore automatic order', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'images-account-menu-'));
  const registry = new AccountRegistry(loadConfig({ CHATGPT_DATA_DIR: dir }));
  await registry.add('first');
  await registry.add('second');
  await registry.add('third');
  try {
    assert.deepEqual(await registry.orderedNames(), ['third', 'second', 'first']);
    const terminal = scripted([
      'account:first', 'rename', 'Work images',
      'account:first', 'up',
      'account:first', 'up',
      'account:first', (choices) => { assert.equal(choices.some(choice => choice.value === 'up'), false, 'The top account cannot move up'); return 'down'; },
      'account:third', 'pin',
      'automatic',
      'account:second', 'close',
      'account:second', 'signin',
      'exit',
    ]);
    await manageAccounts(registry, terminal.io, terminal.actions);
    terminal.done();
    const saved = await new AccountRegistry(registry.baseConfig).list();
    assert.equal(saved.selection_mode, 'priority');
    assert.deepEqual(saved.accounts.map(account => account.account), ['third', 'first', 'second']);
    assert.equal(saved.accounts[1]?.display_name, 'Work images');
    assert.deepEqual(saved.accounts.map(account => account.priority), [3, 2, 1]);
    assert.deepEqual(terminal.actions.calls, ['prepare:second', 'closeBrowser:second', 'prepare:second', 'signIn:second']);
    const messages = terminal.menus.map(menu => menu.message);
    assert.ok(messages.some(message => /third is always used first/.test(message)));
    assert.match(terminal.printed.join('\n'), /Automatic order restored/);
    // New accounts still go to the top after renumbering.
    await registry.add('fourth');
    assert.equal((await registry.orderedNames())[0], 'fourth');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('the account list shows email, plan, session expiry, cooldowns, images per generating profile and last use', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'images-account-overview-'));
  const registry = new AccountRegistry(loadConfig({ CHATGPT_DATA_DIR: dir }));
  const now = Date.now();
  const cookie = (expires: number) => [{ name: '__Secure-next-auth.session-token.0', value: 'a', domain: '.chatgpt.com', path: '/', expires, httpOnly: true, secure: true, sameSite: 'Lax' as const },
    { name: '__Secure-next-auth.session-token.1', value: 'b', domain: '.chatgpt.com', path: '/', expires: expires + 1000, httpOnly: true, secure: true, sameSite: 'Lax' as const }];
  const work = await registry.add('work'), spare = await registry.add('spare'), empty = await registry.add('empty');
  await saveCookies(work.dataDir, cookie(Math.floor((now + 30 * 86_400_000) / 1000)));
  await saveCookies(spare.dataDir, cookie(Math.floor((now + 2 * 86_400_000) / 1000)));
  await saveCookies(path.join(dir, 'accounts', 'expired'), cookie(Math.floor((now - 86_400_000) / 1000)));
  await registry.setProfile('work', { email: 'person@example.com', plan: 'plus' });
  await assert.rejects(registry.setProfile('work', { email: 'not an email' }), /could not be saved/);
  // work generated two images for its own job and one for spare's job after failover.
  const workStore = new JobStore(work.dataDir);
  const own = workStore.create('own');
  workStore.update(own.id, { status: 'completed', images: [{ path: '/a.png', mimeType: 'image/png', bytes: 1 }, { path: '/b.png', mimeType: 'image/png', bytes: 1 }] });
  workStore.close();
  const spareStore = new JobStore(spare.dataDir);
  const moved = spareStore.create('moved');
  spareStore.update(moved.id, { status: 'completed', executionAccount: 'work', images: [{ path: '/c.png', mimeType: 'image/png', bytes: 1 }] });
  spareStore.recordImageLimit('image_usage_limit', 'Limit reached.');
  spareStore.close();
  let held: (() => Promise<void>) | undefined = await acquireRuntime(empty);
  try {
    const overview = await accountOverview(registry, now);
    const byName = Object.fromEntries(overview.accounts.map(account => [account.account, account]));
    assert.equal(byName.work!.name, 'person@example.com');
    assert.equal(byName.work!.plan, 'plus');
    assert.equal(byName.work!.images, 3);
    assert.ok(byName.work!.lastUsed);
    assert.equal(byName.spare!.images, 0);
    assert.ok(byName.spare!.cooldownUntil);
    assert.equal(byName.empty!.session, 'missing');
    assert.equal(byName.empty!.inUse, true);
    assert.equal(byName.work!.inUse, false);
    assert.equal(describeStatus(byName.work!, now).text, 'ready · expires in 30 days · 3 images (3 in last 24h) · used just now');
    assert.equal(byName.work!.imagesLast24h, 3);
    assert.equal(describeStatus(byName.work!, now).tone, 'good');
    assert.match(describeStatus(byName.spare!, now).text, /^image limit · available /);
    assert.equal(describeStatus(byName.empty!, now).text, 'needs sign-in');
    assert.equal(byName.expired!.session, 'expired');
    assert.equal(describeStatus(byName.expired!, now).text, 'session expired · sign in again');
    assert.equal(describeStatus(byName.spare!, now).tone, 'warn');
    const terminal = scripted(['exit']);
    await manageAccounts(registry, terminal.io, terminal.actions);
    const labels = mainMenu(terminal.menus).choices.map(choice => choice.label).join('\n');
    assert.match(labels, /person@example\.com.*Plus · --account work/);
    assert.match(labels, /in use by MCP server/);
    // Account details stay out of MCP list_accounts output.
    assert.doesNotMatch(JSON.stringify(await registry.list()), /person@example|plus/);
    await rm(path.join(dir, 'accounts', 'expired'), { recursive: true });
    await writeFile(path.join(dir, 'account-settings.json'), JSON.stringify({ version: 1, mode: 'priority', accounts: { work: { email: 'bad email' } } }));
    await assert.rejects(registry.list(), /Account settings could not be read/);
  } finally { await held?.(); held = undefined; await rm(dir, { recursive: true, force: true }); }
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
