import './support/headless.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, projectRoot, cli, launchCommand, installKind } from '../src/config.js';
import { AccountRegistry } from '../src/accounts.js';
import { saveCookies } from '../src/session-store.js';
import { describeRegistration, inspectClient, pointsHere, registerClient, type ClientEnvironment } from '../src/clients.js';
import { formatChecks, nodeCheck, runDoctor } from '../src/doctor.js';
import { runInit } from '../src/init.js';
import type { AccountMenuActions, AccountMenuIO, MenuChoice } from '../src/account-menu.js';

const entry = path.join(projectRoot, 'dist', 'index.js');

/** Fake Claude Code / Codex CLIs: records calls and answers `codex mcp get` from an in-memory registration. */
function fakeClients(dir: string, options: { claude?: object; codex?: { command: string; args: string[] }; installed?: string[] } = {}) {
  const calls: string[][] = [];
  let codex = options.codex;
  const claudeConfigFile = path.join(dir, '.claude.json');
  const environment: ClientEnvironment = {
    claudeConfigFile,
    which: async command => (options.installed ?? ['claude', 'codex']).includes(command) ? `/usr/local/bin/${command}` : undefined,
    run: async (command, args) => {
      calls.push([command, ...args]);
      if (command === 'codex' && args[1] === 'get') return codex
        ? { code: 0, stdout: JSON.stringify({ name: 'chatgpt-images', transport: { type: 'stdio', ...codex } }), stderr: '' }
        : { code: 1, stdout: '', stderr: "Error: No MCP server named 'chatgpt-images' found." };
      if (command === 'codex' && args[1] === 'add') codex = { command: args[4]!, args: args.slice(5) };
      return { code: 0, stdout: '', stderr: '' };
    },
  };
  return { environment, calls, claudeConfigFile };
}

test('commands and launch settings match a source checkout', () => {
  assert.equal(installKind, 'source');
  assert.equal(cli('setup --account work'), 'npm run cli -- setup --account work');
  const launch = launchCommand();
  assert.deepEqual(launch.args, [entry, 'serve']);
  assert.match(path.basename(launch.command), /^node(\.exe)?$/);
});

test('registrations are recognised by entry path, linked commands and copy type', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'images-clients-'));
  try {
    const { environment } = fakeClients(dir);
    assert.equal(await pointsHere({ command: '/usr/bin/node', args: [entry, 'serve'] }, environment), true);
    // A `chatgpt-images-mcp` command linked to this copy, as npm link creates.
    const bin = path.join(dir, 'bin');
    await mkdir(bin);
    await symlink(entry, path.join(bin, 'chatgpt-images-mcp'));
    assert.equal(await pointsHere({ command: path.join(bin, 'chatgpt-images-mcp'), args: [] }, environment), true);
    assert.equal(await pointsHere({ command: 'npx', args: ['-y', 'github:meet244/ChatGPT-Images-MCP'] }, environment), false);
    assert.equal(await pointsHere({ command: '/usr/bin/node', args: ['/elsewhere/dist/index.js', 'serve'] }, environment), false);
    assert.match(describeRegistration({ command: 'npx', args: ['-y', 'github:meet244/ChatGPT-Images-MCP'] }), /^the GitHub copy/);
    assert.match(describeRegistration({ command: 'npx', args: ['-y', 'chatgpt-images-mcp@latest'] }), /^the npm package/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('client inspection reads Claude Code JSON and Codex output, and registration replaces entries correctly', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'images-clients-'));
  try {
    const fake = fakeClients(dir, { codex: { command: 'npx', args: ['-y', 'github:meet244/ChatGPT-Images-MCP'] } });
    assert.deepEqual(await inspectClient('claude', fake.environment), { client: 'claude', installed: true, matches: false });
    await writeFile(fake.claudeConfigFile, JSON.stringify({ mcpServers: { 'chatgpt-images': { type: 'stdio', command: '/usr/bin/node', args: [entry, 'serve'] } } }));
    assert.equal((await inspectClient('claude', fake.environment)).matches, true);
    await writeFile(fake.claudeConfigFile, '{not json');
    assert.match((await inspectClient('claude', fake.environment)).error!, /Could not read/);
    const codex = await inspectClient('codex', fake.environment);
    assert.equal(codex.matches, false);
    assert.deepEqual(codex.registration?.args, ['-y', 'github:meet244/ChatGPT-Images-MCP']);

    const { command, args } = launchCommand();
    await registerClient('claude', true, fake.environment);
    await registerClient('codex', true, fake.environment);
    assert.deepEqual(fake.calls.filter(call => call[2] !== 'get'), [
      ['claude', 'mcp', 'remove', 'chatgpt-images', '-s', 'user'],
      ['claude', 'mcp', 'add', '--scope', 'user', 'chatgpt-images', '--', command, ...args],
      ['codex', 'mcp', 'add', 'chatgpt-images', '--', command, ...args],
    ]);
    assert.equal((await inspectClient('codex', fake.environment)).matches, true);
    const missing = fakeClients(dir, { installed: [] });
    assert.deepEqual(await inspectClient('codex', missing.environment), { client: 'codex', installed: false, matches: false });
    assert.deepEqual(missing.calls, [], 'An uninstalled Codex CLI is never run');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('doctor reports requirements, each account, and which copy each client runs, with fixes', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'images-doctor-'));
  const config = loadConfig({ CHATGPT_DATA_DIR: path.join(dir, 'data'), CHATGPT_BROWSER_MODE: 'playwright', CHATGPT_HEADLESS: 'true' });
  const registry = new AccountRegistry(config);
  try {
    const fake = fakeClients(dir, { codex: { command: 'npx', args: ['-y', 'github:meet244/ChatGPT-Images-MCP'] } });
    let checks = await runDoctor(config, registry, fake.environment);
    assert.ok(checks.some(check => check.status === 'fail' && /No ChatGPT accounts/.test(check.text) && check.fix === cli('manage-accounts')));
    const work = await registry.add('work');
    await registry.add('spare');
    await saveCookies(work.dataDir, [{ name: '__Secure-next-auth.session-token', value: 'x', domain: '.chatgpt.com', path: '/', expires: Math.floor(Date.now() / 1000) + 30 * 86_400, httpOnly: true, secure: true, sameSite: 'Lax' }]);
    checks = await runDoctor(config, registry, fake.environment);
    const text = formatChecks(checks);
    assert.equal(checks.some(check => check.status === 'fail'), false);
    assert.match(text, /✓ work: ready · expires in 30 days/);
    assert.match(text, /! spare: needs sign-in\n.*select spare and sign in/);
    assert.match(text, /! Claude Code is installed but not connected\.\n.*init/);
    assert.match(text, /! Codex runs a different copy: the GitHub copy.*separate/);
    assert.match(text, /Working, with 3 things worth a look\./);
    assert.equal(nodeCheck('20.11.0').status, 'fail');
    assert.equal(nodeCheck('22.0.0').status, 'ok');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('init adds the first account, connects Claude Code, and asks before replacing Codex settings', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'images-init-'));
  const config = loadConfig({ CHATGPT_DATA_DIR: path.join(dir, 'data'), CHATGPT_BROWSER_MODE: 'playwright', CHATGPT_HEADLESS: 'true' });
  const registry = new AccountRegistry(config);
  const steps = ['main', 'browser', 'keep'];
  const printed: string[] = [], selects: { message: string; choices: MenuChoice<string>[] }[] = [];
  const io: AccountMenuIO = {
    select: async (message, choices) => { selects.push({ message, choices }); const value = steps.shift(); assert.ok(choices.some(choice => choice.value === value), `${value} for ${message}`); return value as never; },
    text: async () => steps.shift(),
    print: message => { printed.push(message); },
  };
  const signedIn: string[] = [];
  const actions: AccountMenuActions = {
    prepare: async () => {}, closeBrowser: async () => {}, pasteCookies: async () => {},
    signIn: async account => { signedIn.push(account); await saveCookies((await registry.require(account)).dataDir, [{ name: '__Secure-next-auth.session-token', value: 'x', domain: '.chatgpt.com', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' }]); },
  };
  try {
    const fake = fakeClients(dir, { codex: { command: 'npx', args: ['-y', 'github:meet244/ChatGPT-Images-MCP'] } });
    assert.equal(await runInit(config, registry, { io, actions, environment: fake.environment, manageAccounts: async () => assert.fail('Not needed') }), true);
    assert.deepEqual(steps, []);
    assert.deepEqual(signedIn, ['main']);
    const { command, args } = launchCommand();
    assert.deepEqual(fake.calls.filter(call => call[2] !== 'get'), [['claude', 'mcp', 'add', '--scope', 'user', 'chatgpt-images', '--', command, ...args]],
      'Claude Code is connected; the existing Codex entry is kept because the user chose to keep it');
    const codexPrompt = selects.find(select => /^Codex currently runs the GitHub copy/.test(select.message))!;
    assert.match(codexPrompt.choices[0]!.hint!, /forgets approval settings/);
    assert.match(printed.join('\n'), /Connected Claude Code[\s\S]*Kept Codex's existing setup[\s\S]*Restart any open/);

    // A second run with everything connected asks nothing about clients.
    await writeFile(fake.claudeConfigFile, JSON.stringify({ mcpServers: { 'chatgpt-images': { command, args } } }));
    const again = fakeClients(dir, { codex: { command, args } });
    await writeFile(again.claudeConfigFile, JSON.stringify({ mcpServers: { 'chatgpt-images': { command, args } } }));
    steps.push('continue');
    printed.length = 0;
    assert.equal(await runInit(config, registry, { io, actions, environment: again.environment, manageAccounts: async () => {} }), true);
    assert.deepEqual(again.calls.filter(call => call[2] !== 'get'), []);
    assert.match(printed.join('\n'), /Claude Code is already connected[\s\S]*Codex is already connected/);

    // No clients installed: init explains instead of claiming success.
    const none = fakeClients(path.join(dir, 'none'), { installed: [] });
    steps.push('continue');
    assert.equal(await runInit(config, registry, { io, actions, environment: none.environment, manageAccounts: async () => {} }), false);
    assert.match(printed.join('\n'), /No coding agent is connected/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('init does not report success while no account is signed in', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'images-init-unready-'));
  const config = loadConfig({ CHATGPT_DATA_DIR: path.join(dir, 'data'), CHATGPT_BROWSER_MODE: 'playwright', CHATGPT_HEADLESS: 'true' });
  const registry = new AccountRegistry(config);
  const steps = ['main', 'later'], printed: string[] = [];
  const io: AccountMenuIO = { select: async () => steps.shift() as never, text: async () => steps.shift(), print: message => { printed.push(message); } };
  const noop = async () => {};
  try {
    const fake = fakeClients(dir);
    assert.equal(await runInit(config, registry, { io, actions: { prepare: noop, signIn: noop, pasteCookies: noop, closeBrowser: noop }, environment: fake.environment, manageAccounts: noop }), false);
    assert.equal(fake.calls.filter(call => call[2] === 'add').length, 2, 'Clients are still connected so signing in later is enough');
    assert.match(printed.join('\n'), /Added main\. Sign in whenever you're ready with npm run cli -- manage-accounts[\s\S]*No account is signed in yet/);
    assert.doesNotMatch(printed.join('\n'), /Restart any open/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
