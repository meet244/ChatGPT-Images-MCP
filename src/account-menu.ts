import { createInterface } from 'node:readline';
import { styleText } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import * as prompts from '@clack/prompts';
import lockfile from 'proper-lockfile';
import { accountNamePattern, validateAccountName, type AccountRegistry } from './accounts.js';
import { accountOverview, describeStatus, type AccountOverview } from './account-overview.js';
import { acquireRuntime } from './runtime.js';
import { ChatGPTBrowser } from './browser.js';
import { stopChrome } from './chrome.js';
import { parseCookieInput } from './cookies.js';
import { importCookiesWithVerification } from './setup.js';
import { readCookieInput } from './terminal.js';
import { requestAccountRelease } from './shared-worker.js';
import { cli } from './config.js';

export interface MenuChoice<T extends string> { value: T; label: string; hint?: string }
export type Tone = 'info' | 'success' | 'warn' | 'error';
export interface AccountMenuIO {
  /** Resolves undefined when the user cancels with Escape or Ctrl+C. */
  select<T extends string>(message: string, choices: MenuChoice<T>[], initial?: T): Promise<T | undefined>;
  text(message: string, options?: { initial?: string; validate?: (value: string) => string | undefined }): Promise<string | undefined>;
  print(message: string, tone?: Tone): void;
}
export interface AccountMenuActions {
  signIn(account: string): Promise<void>;
  pasteCookies(account: string): Promise<void>;
  closeBrowser(account: string): Promise<void>;
  /** Make the account's session lock available, asking a running MCP server to free it if needed. */
  prepare(account: string): Promise<void>;
}

const output = process.stderr;
export const terminalIO: AccountMenuIO = {
  async select(message, choices, initial) {
    const result = await prompts.select({ message, options: choices.map(({ value, label, hint }) => ({ value, label, ...(hint ? { hint } : {}) })) as never,
      ...(initial !== undefined ? { initialValue: initial } : {}), maxItems: 14, output });
    return prompts.isCancel(result) ? undefined : result as never;
  },
  async text(message, options = {}) {
    const result = await prompts.text({ message, ...(options.initial !== undefined ? { initialValue: options.initial } : {}),
      ...(options.validate ? { validate: value => options.validate!(value ?? '') } : {}), output });
    return prompts.isCancel(result) ? undefined : result;
  },
  print(message, tone = 'info') { prompts.log[tone](message, { output }); },
};

const paint = (format: Parameters<typeof styleText>[0], text: string): string => styleText(format, text, { stream: output });
const planName = (plan?: string): string | undefined => plan ? plan[0]!.toUpperCase() + plan.slice(1) : undefined;

function accountRow(account: AccountOverview, pinned: boolean): string {
  const status = describeStatus(account);
  const details = [account.email && account.email !== account.name ? account.email : '', planName(account.plan) ?? '',
    account.name !== account.account ? `--account ${account.account}` : ''].filter(Boolean).join(' · ');
  const tags = [pinned ? paint('cyan', 'always first') : '', account.inUse ? paint('dim', 'in use by MCP server') : ''].filter(Boolean).join(' · ');
  const tone = status.tone === 'good' ? 'green' : status.tone === 'warn' ? 'yellow' : 'red';
  return `${paint('bold', account.name)}${details ? `  ${paint('dim', details)}` : ''}\n    ${paint(tone, status.text)}${tags ? ` · ${tags}` : ''}`;
}

function suggestName(existing: string[]): string {
  if (!existing.length) return 'main';
  for (let index = existing.length + 1; ; index++) if (!existing.includes(`account${index}`)) return `account${index}`;
}

export async function manageAccounts(registry: AccountRegistry, io: AccountMenuIO = terminalIO,
  actions: AccountMenuActions = defaultActions(registry, io)): Promise<void> {
  let focus: string | undefined;
  while (true) {
    const overview = await accountOverview(registry);
    const pinned = overview.mode === 'manual' ? overview.manual : undefined;
    if (!overview.accounts.length) io.print('No accounts yet. Add your first ChatGPT account to start generating images.');
    const choice = await io.select(pinned
      ? `ChatGPT accounts · ${overview.accounts.find(account => account.account === pinned)?.name ?? pinned} is always used first`
      : 'ChatGPT accounts · the top one is used first; the next takes over at an image limit', [
      ...overview.accounts.map(account => ({ value: `account:${account.account}`, label: accountRow(account, account.account === pinned) })),
      { value: 'add', label: '+ Add an account' },
      ...(pinned ? [{ value: 'automatic', label: '↺ Go back to automatic order' }] : []),
      { value: 'exit', label: 'Exit' },
    ], focus ?? (overview.accounts.length ? undefined : 'add'));
    if (choice === undefined || choice === 'exit') return;
    focus = choice;
    try {
      if (choice === 'add') {
        const added = await addAccount(registry, io, actions, overview.accounts.map(account => account.account));
        if (added) focus = `account:${added}`;
      } else if (choice === 'automatic') {
        await registry.usePriorityOrder();
        io.print('Automatic order restored. The top account is used first.', 'success');
      } else {
        const index = overview.accounts.findIndex(account => `account:${account.account}` === choice);
        if (index >= 0) await accountActions(registry, io, actions, overview.accounts[index]!, index, overview.accounts.length, pinned);
      }
    } catch (error) { io.print(error instanceof Error ? error.message : 'Account operation failed.', 'error'); }
  }
}

export async function addAccount(registry: AccountRegistry, io: AccountMenuIO, actions: AccountMenuActions, existing: string[]): Promise<string | undefined> {
  const account = await io.text('Short name for this account (used in commands such as --account main)', {
    initial: suggestName(existing),
    validate: value => !accountNamePattern.test(value.trim()) ? 'Use lowercase letters, digits, - or _, starting with a letter (max 48).'
      : existing.includes(value.trim()) ? 'An account with this name already exists.' : undefined,
  });
  if (account === undefined) return undefined;
  await registry.add(validateAccountName(account.trim()));
  const method = await io.select('How do you want to sign in?', [
    { value: 'browser', label: 'Sign in with Chrome', hint: 'recommended' },
    { value: 'cookies', label: 'Paste session cookies', hint: 'if sign-in in Chrome is blocked' },
    { value: 'later', label: 'Later' },
  ], 'browser');
  if (method === 'browser') await runWithLock(actions, account.trim(), () => actions.signIn(account.trim()));
  else if (method === 'cookies') await runWithLock(actions, account.trim(), () => actions.pasteCookies(account.trim()));
  else io.print(`Added ${account.trim()}. Sign in whenever you're ready with ${cli('manage-accounts')}.`);
  return account.trim();
}

async function runWithLock(actions: AccountMenuActions, account: string, action: () => Promise<void>): Promise<void> {
  await actions.prepare(account);
  await action();
}

async function accountActions(registry: AccountRegistry, io: AccountMenuIO, actions: AccountMenuActions,
  account: AccountOverview, index: number, total: number, pinned?: string): Promise<void> {
  const signedIn = account.session === 'ready';
  const choice = await io.select(`${account.name}${account.name !== account.account ? ` (${account.account})` : ''}`, [
    { value: 'signin', label: signedIn ? 'Sign in again with Chrome' : 'Sign in with Chrome' },
    { value: 'cookies', label: 'Paste session cookies instead' },
    { value: 'rename', label: 'Rename' },
    ...(index > 0 ? [{ value: 'up', label: 'Move up', hint: 'used earlier' }] : []),
    ...(index < total - 1 ? [{ value: 'down', label: 'Move down', hint: 'used later' }] : []),
    pinned === account.account
      ? { value: 'automatic', label: 'Stop always using this account first' }
      : { value: 'pin', label: 'Always use this account first', hint: 'others still take over at its image limit' },
    { value: 'close', label: 'Close its Chrome window' },
    { value: 'delete', label: 'Delete this account' },
    { value: 'back', label: 'Back' },
  ], signedIn ? 'back' : 'signin');
  const name = account.account;
  if (choice === 'signin') await runWithLock(actions, name, () => actions.signIn(name));
  else if (choice === 'cookies') await runWithLock(actions, name, () => actions.pasteCookies(name));
  else if (choice === 'rename') {
    const label = await io.text('Display name', { initial: account.name,
      validate: value => !value.trim() || value.trim().length > 80 || /[\x00-\x1f\x7f]/.test(value) ? 'Use 1–80 characters.' : undefined });
    if (label !== undefined) { await registry.rename(name, label); io.print('Renamed. Commands still use the same --account name.', 'success'); }
  } else if (choice === 'up' || choice === 'down') {
    await registry.move(name, choice === 'up' ? -1 : 1);
    if (pinned) io.print(`Order saved. ${pinned} stays first until you go back to automatic order.`);
  } else if (choice === 'pin') {
    await registry.select(name);
    io.print(`${account.name} is now always used first. Other accounts still take over when it hits its image limit.`, 'success');
  } else if (choice === 'automatic') {
    await registry.usePriorityOrder();
    io.print('Automatic order restored. The top account is used first.', 'success');
  } else if (choice === 'close') await runWithLock(actions, name, () => actions.closeBrowser(name));
  else if (choice === 'delete') {
    const confirm = await io.text(`This deletes ${account.name}'s saved login, Chrome profile, job history and images. Type ${name} to confirm`);
    if (confirm?.trim() !== name) { io.print('Nothing was deleted.'); return; }
    await actions.prepare(name);
    await registry.remove(name);
    io.print(`Deleted ${account.name}.`, 'success');
  }
}

const releaseMessages = {
  busy: 'The MCP server is generating images right now. Try again when it finishes.',
  unsupported: "The running MCP server holds this original 'default' account. Close your Claude Code and Codex sessions, then try again.",
  error: 'The MCP server could not free this account. Close your Claude Code and Codex sessions, then try again.',
} as const;

export function defaultActions(registry: AccountRegistry, io: AccountMenuIO): AccountMenuActions {
  return {
    async prepare(account) {
      const config = await registry.require(account);
      if (!await lockfile.check(config.dataDir, { stale: 30_000 }).catch(() => false)) return;
      const result = await requestAccountRelease(registry.baseConfig, account);
      if (result === 'released') {
        const deadline = Date.now() + 5000;
        while (await lockfile.check(config.dataDir, { stale: 30_000 }).catch(() => false)) {
          if (Date.now() > deadline) break;
          await delay(100);
        }
        return;
      }
      throw new Error(result === 'busy' || result === 'unsupported' || result === 'error' ? releaseMessages[result]
        : `Account '${account}' is in use by another terminal command (setup, status or another menu). Finish it, then try again.`);
    },
    async signIn(account) {
      const config = await registry.require(account);
      config.headless = false;
      const release = await acquireRuntime(config);
      const browser = new ChatGPTBrowser(config);
      const controller = new AbortController();
      const reader = process.stdin.isTTY ? createInterface({ input: process.stdin, output, terminal: true, historySize: 0 }) : undefined;
      reader?.on('line', line => { if (line.trim().toLowerCase() === 'q') controller.abort(); });
      reader?.on('SIGINT', () => controller.abort());
      let profile: { email?: string; plan?: string } | undefined;
      let state;
      try {
        io.print('Opening Chrome. Sign in to ChatGPT there; this continues by itself once you are signed in.\nType q and press Enter to cancel. If Google blocks sign-in in that window, cancel and choose "Paste session cookies".');
        state = await browser.waitForSignIn({ signal: controller.signal, onStatus: status => {
          if (status === 'challenge') io.print('Complete the verification check in the Chrome window.', 'warn');
        } });
        if (state.status === 'ready') profile = await browser.accountProfile();
      } finally {
        reader?.close();
        if (process.stdin.isTTY) process.stdin.setRawMode(false);
        process.stdin.pause();
        try { await browser.shutdown(); } catch { io.print('Chrome could not be closed automatically. Quit that Chrome window yourself.', 'warn'); }
        await release();
      }
      if (state.status !== 'ready') { io.print(state.message, 'warn'); return; }
      if (profile) await registry.setProfile(account, profile);
      io.print(`Signed in${profile?.email ? ` as ${profile.email}` : ''}${profile?.plan ? ` (${planName(profile.plan)})` : ''}. This account is ready for image requests.`, 'success');
    },
    async pasteCookies(account) {
      const config = await registry.require(account);
      const release = await acquireRuntime(config);
      const browser = new ChatGPTBrowser(config);
      let result;
      try { result = await importCookiesWithVerification(browser, parseCookieInput(await readCookieInput())); }
      finally { await browser.close().finally(release); }
      if (result.state.status !== 'ready') { io.print(`${result.state.status}: ${result.state.message}`, 'warn'); return; }
      if (result.profile) await registry.setProfile(account, result.profile);
      io.print(`Cookies saved${result.profile?.email ? ` for ${result.profile.email}` : ''}. This account is ready for image requests.`, 'success');
    },
    async closeBrowser(account) {
      const config = await registry.require(account);
      const release = await acquireRuntime(config);
      try { io.print(await stopChrome(config) ? 'Chrome closed.' : 'Its Chrome window is not open.'); }
      finally { await release(); }
    },
  };
}
