import path from 'node:path';
import { access, readFile, stat } from 'node:fs/promises';
import { styleText } from 'node:util';
import { chromium, webkit } from 'playwright';
import { cli, installKind, projectRoot, type Config } from './config.js';
import { findChrome } from './chrome.js';
import type { AccountRegistry } from './accounts.js';
import { accountOverview, describeStatus } from './account-overview.js';
import { clientLabels, describeRegistration, inspectClient, systemEnvironment, type ClientEnvironment, type ClientName } from './clients.js';

export interface Check { section: string; status: 'ok' | 'warn' | 'fail' | 'info'; text: string; fix?: string }

export async function packageVersion(): Promise<string> {
  try { return (JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8')) as { version?: string }).version ?? 'unknown'; }
  catch { return 'unknown'; }
}

/** Whether a background server is running for this data folder, by its endpoint file and process. */
export async function runningServer(config: Config): Promise<number | undefined> {
  try {
    const { pid } = JSON.parse(await readFile(path.join(config.dataDir, 'worker.json'), 'utf8')) as { pid?: unknown };
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid < 1) return undefined;
    process.kill(pid, 0);
    return pid;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM' ? -1 : undefined;
  }
}

export async function browserCheck(config: Config): Promise<Check> {
  if (config.browserMode === 'cdp') {
    try { return { section: 'Setup', status: 'ok', text: `Google Chrome found at ${await findChrome(config)}` }; }
    catch { return { section: 'Setup', status: 'fail', text: 'Google Chrome was not found.', fix: 'Install Google Chrome, or set CHATGPT_CHROME_EXECUTABLE to its path.' }; }
  }
  const engine = config.browserMode === 'webkit' ? webkit : chromium;
  try {
    await access(engine.executablePath());
    return { section: 'Setup', status: 'ok', text: `Playwright ${config.browserMode === 'webkit' ? 'WebKit' : 'Chromium'} is installed` };
  } catch {
    return { section: 'Setup', status: 'fail', text: `Playwright ${config.browserMode === 'webkit' ? 'WebKit' : 'Chromium'} is not installed.`,
      fix: `npx playwright install ${config.browserMode === 'webkit' ? 'webkit' : 'chromium'}` };
  }
}

export function nodeCheck(version = process.versions.node): Check {
  const major = Number(version.split('.')[0]);
  return major >= 22 ? { section: 'Setup', status: 'ok', text: `Node.js ${version}` }
    : { section: 'Setup', status: 'fail', text: `Node.js ${version} is too old; version 22 or newer is required.`, fix: 'Install Node.js 22 or newer from https://nodejs.org' };
}

export async function runDoctor(config: Config, registry: AccountRegistry, environment: ClientEnvironment = systemEnvironment): Promise<Check[]> {
  const checks: Check[] = [];
  const installed = { npx: 'run through npx', global: 'installed globally with npm', source: `source checkout at ${path.resolve(projectRoot)}` }[installKind];
  checks.push({ section: 'Setup', status: 'info', text: `chatgpt-images-mcp ${await packageVersion()}, ${installed}` });
  checks.push(nodeCheck());
  checks.push(await browserCheck(config));
  try {
    const info = await stat(config.dataDir);
    if (process.platform !== 'win32' && info.mode & 0o077) {
      checks.push({ section: 'Setup', status: 'warn', text: `Data folder ${config.dataDir} can be read by other users on this computer.`, fix: `chmod 700 "${config.dataDir}"` });
    } else checks.push({ section: 'Setup', status: 'ok', text: `Data folder ${config.dataDir}` });
  } catch {
    checks.push({ section: 'Setup', status: 'info', text: `Data folder ${config.dataDir} will be created when you add an account` });
  }
  const pid = await runningServer(config);
  checks.push({ section: 'Setup', status: 'info', text: pid ? `Background server is running${pid > 0 ? ` (pid ${pid})` : ''}`
    : 'Background server is not running; it starts when Claude Code or Codex connects' });

  try {
    const overview = await accountOverview(registry);
    if (!overview.accounts.length) {
      checks.push({ section: 'Accounts', status: 'fail', text: 'No ChatGPT accounts yet.', fix: cli('manage-accounts') });
    }
    for (const account of overview.accounts) {
      const status = describeStatus(account);
      const label = `${account.name}${account.name !== account.account ? ` (${account.account})` : ''}: ${status.text}`;
      if (account.session !== 'ready') checks.push({ section: 'Accounts', status: 'warn', text: label, fix: `${cli('manage-accounts')}, then select ${account.account} and sign in` });
      else checks.push({ section: 'Accounts', status: status.tone === 'good' ? 'ok' : 'warn', text: label });
    }
    if (overview.accounts.length && !overview.accounts.some(account => account.session === 'ready')) {
      checks.push({ section: 'Accounts', status: 'fail', text: 'No account is signed in, so image requests will fail.', fix: cli('manage-accounts') });
    }
  } catch (error) {
    checks.push({ section: 'Accounts', status: 'fail', text: error instanceof Error ? error.message : 'Accounts could not be read.' });
  }

  for (const client of ['claude', 'codex'] as ClientName[]) {
    const state = await inspectClient(client, environment);
    const label = clientLabels[client];
    if (state.error) checks.push({ section: 'Clients', status: 'warn', text: `${label}: ${state.error}` });
    else if (state.matches) checks.push({ section: 'Clients', status: 'ok', text: `${label} is connected to this copy` });
    else if (state.registration) checks.push({ section: 'Clients', status: 'warn',
      text: `${label} runs a different copy: ${describeRegistration(state.registration)}. Its accounts and images are separate from these.`, fix: cli('init') });
    else if (state.installed) checks.push({ section: 'Clients', status: 'warn', text: `${label} is installed but not connected.`, fix: cli('init') });
    else checks.push({ section: 'Clients', status: 'info', text: `${label} is not installed` });
  }
  return checks;
}

export function formatChecks(checks: Check[], stream: NodeJS.WriteStream = process.stdout): string {
  const paint = (format: Parameters<typeof styleText>[0], text: string): string => styleText(format, text, { stream });
  const symbol = { ok: paint('green', '✓'), warn: paint('yellow', '!'), fail: paint('red', '✗'), info: paint('dim', '•') };
  const lines: string[] = [];
  let section = '';
  for (const check of checks) {
    if (check.section !== section) { section = check.section; lines.push(`${lines.length ? '\n' : ''}${paint('bold', section)}`); }
    lines.push(`  ${symbol[check.status]} ${check.text}`);
    if (check.fix) lines.push(`      ${paint('dim', '→')} ${check.fix}`);
  }
  const failed = checks.filter(check => check.status === 'fail').length, warned = checks.filter(check => check.status === 'warn').length;
  lines.push('', failed ? paint('red', `${failed} problem${failed === 1 ? '' : 's'} to fix.`)
    : warned ? paint('yellow', `Working, with ${warned} thing${warned === 1 ? '' : 's'} worth a look.`) : paint('green', 'Everything looks good.'));
  return lines.join('\n');
}
