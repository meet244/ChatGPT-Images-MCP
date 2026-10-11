import { cli, type Config } from './config.js';
import type { AccountRegistry } from './accounts.js';
import { accountOverview } from './account-overview.js';
import { addAccount, type AccountMenuActions, type AccountMenuIO } from './account-menu.js';
import { browserCheck, nodeCheck } from './doctor.js';
import { clientLabels, describeRegistration, inspectClient, registerClient, type ClientEnvironment, type ClientName } from './clients.js';

export interface InitDependencies {
  io: AccountMenuIO;
  actions: AccountMenuActions;
  environment: ClientEnvironment;
  manageAccounts(): Promise<void>;
}

/** Guided first-time setup: requirements, a signed-in account, and Claude Code / Codex registration. */
export async function runInit(config: Config, registry: AccountRegistry, { io, actions, environment, manageAccounts }: InitDependencies): Promise<boolean> {
  for (const check of [nodeCheck(), await browserCheck(config)]) {
    if (check.status === 'fail') { io.print(`${check.text}${check.fix ? `\n${check.fix}` : ''}`, 'error'); return false; }
    io.print(check.text, 'success');
  }

  let overview = await accountOverview(registry);
  if (!overview.accounts.length) {
    io.print("Let's add your first ChatGPT account.");
    if (!await addAccount(registry, io, actions, [])) { io.print(`Setup stopped. Run ${cli('init')} again whenever you're ready.`, 'warn'); return false; }
  } else {
    const ready = overview.accounts.filter(account => account.session === 'ready').length;
    const choice = await io.select(`You have ${overview.accounts.length} account${overview.accounts.length === 1 ? '' : 's'}, ${ready} signed in.`, [
      { value: 'continue', label: 'Continue' },
      { value: 'add', label: 'Add another account' },
      { value: 'manage', label: 'Manage accounts', hint: 'sign in, reorder, delete' },
    ], ready ? 'continue' : 'manage');
    if (choice === undefined) return false;
    if (choice === 'add') await addAccount(registry, io, actions, overview.accounts.map(account => account.account));
    if (choice === 'manage') await manageAccounts();
  }
  overview = await accountOverview(registry);
  const signedIn = overview.accounts.some(account => account.session === 'ready');
  if (!signedIn) io.print(`No account is signed in yet, so image requests will fail. Run ${cli('manage-accounts')} to sign in.`, 'warn');

  let connected = 0;
  for (const client of ['claude', 'codex'] as ClientName[]) {
    const label = clientLabels[client];
    const state = await inspectClient(client, environment);
    if (state.matches) { io.print(`${label} is already connected.`, 'success'); connected++; continue; }
    if (state.error) { io.print(`${label}: ${state.error} Skipped.`, 'warn'); continue; }
    if (!state.installed) { io.print(`${label} is not installed. Skipped.`); continue; }
    if (state.registration) {
      const replace = await io.select(`${label} currently runs ${describeRegistration(state.registration)}. Replace it with this copy?`, [
        { value: 'replace', label: 'Replace it', hint: client === 'codex' ? 'Codex also forgets approval settings for this server' : 'your accounts here will be used' },
        { value: 'keep', label: 'Keep the existing one' },
      ], 'replace');
      if (replace !== 'replace') { io.print(`Kept ${label}'s existing setup. It won't see the accounts set up here.`); continue; }
    }
    try {
      await registerClient(client, !!state.registration, environment);
      io.print(`Connected ${label}.`, 'success');
      connected++;
    } catch (error) { io.print(error instanceof Error ? error.message : `Could not connect ${label}.`, 'error'); }
  }
  if (!connected) {
    io.print(`No coding agent is connected. Install Claude Code or Codex, then run ${cli('init')} again.`, 'warn');
    return false;
  }
  if (!signedIn) return false;
  io.print('Restart any open Claude Code or Codex sessions, then ask: "Use chatgpt-images to generate a watercolor fox."');
  return true;
}
