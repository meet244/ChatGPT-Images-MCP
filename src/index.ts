#!/usr/bin/env node
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig, projectRoot } from './config.js';
import { acquireRuntime } from './runtime.js';
import { ChatGPTBrowser } from './browser.js';
import { JobStore } from './store.js';
import { JobQueue } from './queue.js';
import { runSharedStdio, startSharedWorker } from './shared-worker.js';
import { parseCookieInput, readCookies } from './cookies.js';
import { readCookieInput } from './terminal.js';
import { setupSession, importCookiesWithVerification } from './setup.js';
import { openManualChrome, stopChrome } from './chrome.js';
import { AccountRegistry } from './accounts.js';

const help = `ChatGPT Images MCP (local browser, no OpenAI API)

Commands:
  serve                     Connect stdio to the shared local MCP worker (default)
  browser                   Open/reuse dedicated Chrome in CDP mode, then disconnect
  browser-manual            Open ordinary Chrome for manual challenge diagnostics
  browser-close             Close only this app's dedicated Chrome
  setup                     Check session; choose Log in or Paste cookies
  paste-cookies             Paste visible values for cookie .0, then .1
  import-cookies --file PATH Import a cookie JSON export into the local browser profile
  login                     Open a visible browser for manual login or verification
  status                    Check the browser session
  generate --prompt TEXT    Generate an image from the terminal and print saved paths
  recover --job ID           Save a finished image from an existing failed job's conversation
  accounts                  List profiles and the selected account (no browser opened)
  account-add --account NAME Create an empty profile; then run setup --account NAME
  account-use --account NAME Select the default account for new requests
  config                    Print MCP client configuration with absolute paths

Options:
  --account NAME            Account for browser/session/generate/recover commands
  --reference PATH          Reference image for generate (absolute path; repeat for up to 4)
  --headed                  Show the browser for this command
  --help                    Show this help

Settings: .env in the project directory; see .env.example.
Disconnect clients using an account before modifying its session; each profile has its own runtime lock.
serve always connects to the shared worker; choose accounts with use_account or per-tool account inputs.
`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({ options: {
    account: { type: 'string' }, file: { type: 'string' }, prompt: { type: 'string' }, job: { type: 'string' }, reference: { type: 'string', multiple: true }, headed: { type: 'boolean' }, help: { type: 'boolean' },
  }, allowPositionals: true });
  if (values.help) { console.log(help); return; }
  const command = positionals[0] ?? 'serve';
  if (positionals.length > 1 || !['serve', 'worker', 'browser', 'browser-manual', 'browser-close', 'setup', 'paste-cookies', 'login', 'import-cookies', 'status', 'generate', 'recover', 'config', 'accounts', 'account-add', 'account-use'].includes(command)) throw new Error(help);
  const baseConfig = loadConfig();
  const registry = new AccountRegistry(baseConfig);
  if (['account-add', 'account-use'].includes(command)) {
    if (!values.account) throw new Error(`Usage: ${command} --account NAME`);
    if (command === 'account-add') {
      await registry.add(values.account);
      console.log(JSON.stringify({ account: values.account, status: 'login_required', message: `Run npm run setup -- --account ${values.account} to sign in or paste cookies in the terminal. Then select it with account-use --account ${values.account}.` }, null, 2));
    } else console.log(JSON.stringify(await registry.use(values.account), null, 2));
    return;
  }
  if (command === 'accounts') { console.log(JSON.stringify(await registry.list(), null, 2)); return; }
  const sharedCommand = ['serve', 'worker', 'config'].includes(command);
  if (sharedCommand && values.account) throw new Error('serve/config use one shared worker for all accounts. Choose an account with account-use --account NAME or an MCP tool account argument.');
  if (command === 'recover' && !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(values.job ?? '')) throw new Error('Usage: recover --job JOB_ID');
  const account = sharedCommand ? 'default' : values.account ?? (command === 'recover' ? await registry.owner(values.job!) : await registry.active());
  const config = sharedCommand ? baseConfig : await registry.require(account);
  if (command === 'config') {
    console.log(JSON.stringify({ mcpServers: { 'chatgpt-images': { command: process.execPath, args: [path.join(projectRoot, 'dist/index.js'), 'serve'], env: { CHATGPT_DATA_DIR: config.dataDir } } } }, null, 2));
    return;
  }
  if (command === 'import-cookies' && !values.file) throw new Error('Usage: import-cookies --file /absolute/path/to/cookies.json');
  if (command === 'generate' && (!values.prompt?.trim() || values.prompt.length > 16_000)) throw new Error('Usage: generate --prompt "Describe the image" (1–16000 characters)');
  if (command === 'browser' && config.browserMode !== 'cdp') throw new Error('The browser command keeps CDP Chrome open. For other browser modes, run login in a terminal or let the MCP server manage the browser.');
  if (['login', 'setup', 'paste-cookies'].includes(command) && !process.stdin.isTTY) throw new Error(`Run ${command} in an interactive terminal.`);
  if (values.headed || command === 'login') config.headless = false;
  if (command === 'serve') { await runSharedStdio(config); return; }
  if (command === 'worker') {
    const worker = await startSharedWorker(config);
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void worker.close().finally(() => process.exit(0)); });
    await worker.done;
    return;
  }
  console.error(`Account: ${account}`);
  const release = await acquireRuntime(config);
  const browser = new ChatGPTBrowser(config);
  let store: JobStore | undefined;
  let queue: JobQueue | undefined;
  let cleanupPromise: Promise<void> | undefined;
  const cleanup = (): Promise<void> => cleanupPromise ??= (async () => {
    // Close browser first so a running job can terminate before the database is closed.
    const stopped = queue?.stop();
    await browser.close().catch(() => {});
    await stopped;
    store?.close();
    await release();
  })();
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void cleanup().finally(() => process.exit(0)); });

  try {
    if (command === 'browser-manual') {
      await openManualChrome(config);
      console.error('Ordinary dedicated Chrome opened with ChatGPT and Cloudflare’s compatibility checker. Remote debugging is disabled; MCP cannot control this window. Close this dedicated Chrome instance manually before running browser or status again. Your everyday Chrome can stay open.');
    } else if (command === 'browser-close') {
      console.error(await stopChrome(config) ? 'Dedicated Chrome closed.' : 'Dedicated Chrome is not running.');
    } else if (command === 'browser') {
      await browser.open();
      console.error('Dedicated Chrome is open. The MCP will reconnect to this session; the browser stays open after this command exits.');
    } else if (command === 'setup') {
      const state = await setupSession(browser, config.headless);
      if (state.status !== 'ready') process.exitCode = 1;
    } else if (command === 'paste-cookies') {
      const cookies = parseCookieInput(await readCookieInput());
      const { state } = await importCookiesWithVerification(browser, cookies);
      console.error(JSON.stringify(state, null, 2));
      if (state.status !== 'ready') process.exitCode = 1;
    } else if (command === 'login') {
      await browser.open();
      const readline = createInterface({ input: process.stdin, output: process.stdout });
      try { await readline.question('Sign in or complete verification in the browser, then press Enter here to save the session.\n'); }
      finally { readline.close(); }
      console.log(JSON.stringify(await browser.sessionStatus(false), null, 2));
    } else if (command === 'import-cookies') {
      const { count, state } = await importCookiesWithVerification(browser, await readCookies(path.resolve(values.file!)));
      console.log(`Imported ${count} cookies into the local browser profile.`);
      console.log(JSON.stringify(state, null, 2));
      if (state.status !== 'ready') process.exitCode = 1;
    } else if (command === 'recover') {
      store = new JobStore(config.dataDir);
      const job = store.get(values.job!);
      if (job.status === 'completed') console.log(JSON.stringify(job, null, 2));
      else {
        if (job.status !== 'failed' || !job.conversationUrl) throw new Error('Recovery requires a failed/interrupted job with a recorded conversation. Stop the current test/server first.');
        console.error(`Recovering existing image for job ${job.id}; no new prompt will be submitted.`);
        const result = await browser.recover(job.id, job.conversationUrl);
        console.log(JSON.stringify(store.update(job.id, { status: 'completed', ...result, error: undefined }), null, 2));
      }
    } else if (command === 'status') {
      console.log(JSON.stringify(await browser.sessionStatus(), null, 2));
    } else {
      store = new JobStore(config.dataDir);
      queue = new JobQueue(store, browser);
      if (command === 'generate') queue.assertGenerationAllowed();
      if (process.stdin.isTTY) {
        const state = await setupSession(browser, config.headless);
        if (command === 'generate' && state.status !== 'ready') throw new Error('Session is not ready. Resolve the session check before generating an image.');
      }
      if (command === 'generate') {
        const job = await queue.enqueueWithReferences(values.prompt!.trim(), values.reference);
        console.error(`Generating image; job ${job.id}`);
        while (['queued', 'running'].includes(store.get(job.id).status)) await delay(500);
        const completed = store.get(job.id);
        console.log(JSON.stringify(completed, null, 2));
        if (completed.status !== 'completed') process.exitCode = 1;
      }
    }
  } finally { await cleanup(); }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : 'Command failed.');
  process.exitCode = 1;
});
