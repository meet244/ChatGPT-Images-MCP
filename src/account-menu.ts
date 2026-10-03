import { AccountRegistry, validateAccountName } from './accounts.js';
import { ChatGPTBrowser } from './browser.js';
import { parseCookieInput } from './cookies.js';
import { acquireRuntime } from './runtime.js';
import { importCookiesWithVerification } from './setup.js';
import { question, readCookieInput } from './terminal.js';
import { stopChrome } from './chrome.js';

export interface AccountMenuIO {
  question(prompt: string): Promise<string>;
  print(message: string): void;
}
const terminal: AccountMenuIO = { question, print: message => { process.stderr.write(`${message}\n`); } };

/** Session changes require the same per-profile lock as the worker. Metadata changes do not. */
export async function pasteAccountCookies(registry: AccountRegistry, account: string): Promise<void> {
  const config = await registry.require(account);
  const release = await acquireRuntime(config);
  const browser = new ChatGPTBrowser(config);
  try {
    const { state } = await importCookiesWithVerification(browser, parseCookieInput(await readCookieInput()));
    process.stderr.write(`${state.status}: ${state.message}\n`);
  } finally { await browser.close().finally(release); }
}

export async function manageAccounts(registry: AccountRegistry, io: AccountMenuIO = terminal,
  pasteCookies: (account: string) => Promise<void> = account => pasteAccountCookies(registry, account),
  closeBrowser: (account: string) => Promise<void> = async account => {
    const config = await registry.require(account);
    const release = await acquireRuntime(config);
    try { io.print(await stopChrome(config) ? 'Dedicated Chrome closed.' : 'Dedicated controlled Chrome is not running.'); }
    finally { await release(); }
  }): Promise<void> {
  while (true) {
    const listing = await registry.list();
    io.print(`\nChatGPT accounts — ${listing.selection_mode === 'manual' ? `manual selection (${listing.manual_account})` : 'automatic priority order'}`);
    io.print('Higher priority numbers run first. New accounts get the current maximum + 1. Equal priorities prefer the last used account, then profile ID.');
    listing.accounts.forEach((account, index) => {
      io.print(`${index + 1}) ${account.display_name} [${account.account}] | priority ${account.priority} | ${account.has_saved_session ? 'cookies saved' : 'needs cookies'}${account.active ? ' | last selected' : ''}`);
    });
    if (!listing.accounts.length) io.print('No accounts configured. Choose option 1 to add your first account.');
    io.print('\n1) Add account and paste cookies\n2) Paste/replace cookies for an account\n3) Rename an account\n4) Set an account priority\n5) Select an account manually\n6) Use automatic priority order\n7) Close an account’s controlled Chrome\n8) Delete an account\n0) Exit');
    const choice = (await io.question('Option: ')).trim();
    if (choice === '0' || choice.toLowerCase() === 'q') return;
    try {
      if (choice === '1') {
        const account = validateAccountName((await io.question('New profile ID (e.g. work): ')).trim());
        await registry.add(account);
        io.print(`Created ${account}. If cookie setup is interrupted, select option 2 to resume.`);
        await pasteCookies(account);
      } else if (choice === '6') {
        await registry.usePriorityOrder();
        io.print('Automatic priority order enabled for new requests.');
      } else if (['2', '3', '4', '5', '7', '8'].includes(choice)) {
        if (!listing.accounts.length) { io.print('No accounts configured. Choose option 1 to add one first.'); continue; }
        const answer = (await io.question('Account number or profile ID (Enter to cancel): ')).trim();
        if (!answer) continue;
        const account = /^\d+$/.test(answer) ? listing.accounts[Number(answer) - 1]?.account : answer;
        if (!account) throw new Error('Choose an account number from the list.');
        await registry.require(account);
        if (choice === '2') await pasteCookies(account);
        if (choice === '3') {
          const label = await io.question('New display name: ');
          await registry.rename(account, label);
          io.print('Display name updated. The profile ID stays fixed so existing sessions and images remain linked.');
        }
        if (choice === '4') {
          const priority = (await io.question('Priority (0–999999; higher runs first): ')).trim();
          if (!/^\d+$/.test(priority)) throw new Error('Enter a whole priority number.');
          await registry.setPriority(account, Number(priority));
          io.print(`Priority saved.${listing.selection_mode === 'manual' ? ' Manual selection is still enabled; choose option 6 to use priority order.' : ' New requests will use the updated order.'}`);
        }
        if (choice === '5') {
          await registry.select(account);
          io.print(`New requests prefer ${account}; quota fallbacks follow priority order. Choose option 6 to return to automatic priority order.`);
        }
        if (choice === '7') await closeBrowser(account);
        if (choice === '8') {
          const confirm = (await io.question(`Delete '${account}' and its saved cookies, browser profile, jobs, and images? Type '${account}' to confirm (Enter to cancel): `)).trim();
          if (confirm !== account) { io.print('Deletion cancelled.'); continue; }
          await registry.remove(account);
          io.print(`Deleted ${account}.`);
        }
      } else io.print('Choose an option from 0 to 8.');
    } catch (error) { io.print(error instanceof Error ? error.message : 'Account operation failed.'); }
  }
}
