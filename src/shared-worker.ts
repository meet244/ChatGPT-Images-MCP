import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmod, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { createConnection, createServer as createNetServer, type Socket } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import lockfile from 'proper-lockfile';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { type Config, projectRoot, cli } from './config.js';
import { acquireRuntime } from './runtime.js';
import { ChatGPTBrowser } from './browser.js';
import { JobStore } from './store.js';
import { JobQueue } from './queue.js';
import { createServer } from './server.js';
import { setupSession } from './setup.js';
import { AccountRegistry, AccountManager, accountNamePattern, type AccountBrowserFactory } from './accounts.js';

interface WorkerEndpoint { version: 1; port: number; token: string; pid: number; }
const endpointFile = (config: Config): string => path.join(config.dataDir, 'worker.json');
const greeting = 'CHATGPT_IMAGES_WORKER_1';

/** Private handshake precedes the unchanged MCP JSON-line stream. */
async function readLine(socket: Socket, timeoutMs = 3000): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const cleanup = (): void => {
      clearTimeout(timer);
      socket.off('data', onData); socket.off('error', onError); socket.off('close', onClose);
      socket.pause();
    };
    const fail = (): void => { cleanup(); reject(new Error('Local worker connection failed.')); };
    const onError = (): void => fail();
    const onClose = (): void => fail();
    const onData = (chunk: Buffer): void => {
      buffer = Buffer.concat([buffer, chunk]);
      const newline = buffer.indexOf(10);
      if (newline < 0) { if (buffer.length > 512) fail(); return; }
      if (newline > 512) { fail(); return; }
      cleanup();
      if (buffer.length > newline + 1) socket.unshift(buffer.subarray(newline + 1));
      resolve(buffer.subarray(0, newline).toString('utf8'));
    };
    const timer = setTimeout(fail, timeoutMs);
    socket.on('data', onData); socket.once('error', onError); socket.once('close', onClose);
    socket.resume();
  });
}

async function connectExisting(config: Config): Promise<Socket | undefined> {
  let socket: Socket | undefined;
  try {
    const endpoint = JSON.parse(await readFile(endpointFile(config), 'utf8')) as WorkerEndpoint;
    if (endpoint.version !== 1 || !Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535 || !/^[a-f0-9]{64}$/.test(endpoint.token)) return;
    socket = createConnection({ host: '127.0.0.1', port: endpoint.port });
    // Keep errors handled between the private handshake and attaching the transport.
    socket.on('error', () => {});
    const reply = readLine(socket);
    socket.write(`${endpoint.token}\n`);
    if (await reply !== greeting) throw new Error('Unexpected worker.');
    return socket;
  } catch { socket?.destroy(); return undefined; }
}

async function connectWorker(config: Config): Promise<Socket> {
  await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  await chmod(config.dataDir, 0o700);
  const deadline = Date.now() + 8000;
  let launched = false;
  do {
    const socket = await connectExisting(config);
    if (socket) return socket;
    // One worker holds the existing runtime lock. Concurrent client startups
    // converge on it rather than starting independent browser/queue workers.
    if (!launched && !await lockfile.check(config.dataDir, { stale: 30_000 })) {
      launched = true;
      const log = await open(path.join(config.dataDir, 'worker.log'), 'a', 0o600);
      try {
        const child = spawn(process.execPath, [path.join(projectRoot, 'dist/index.js'), 'worker'], {
          detached: true,
          env: { ...process.env, CHATGPT_DATA_DIR: config.dataDir, CHATGPT_HEADLESS: String(config.headless), CHATGPT_BROWSER_MODE: config.browserMode },
          stdio: ['ignore', 'ignore', log.fd],
        });
        child.on('error', () => {});
        child.unref();
      } finally { await log.close(); }
    }
    await delay(100);
  } while (Date.now() < deadline);
  throw new Error('Could not connect to the shared MCP worker. Stop any older server or active login/setup command, then reconnect your MCP client. Saved cookies and jobs are retained; worker diagnostics are in .chatgpt-images/worker.log.');
}

export type AccountReleaseResult = 'released' | 'not_open' | 'busy' | 'unsupported' | 'error' | 'no_worker';

/** Ask a running worker to free one idle account so a terminal command can repair its session. */
export async function requestAccountRelease(config: Config, account: string): Promise<AccountReleaseResult> {
  if (!accountNamePattern.test(account)) throw new Error('Invalid account name.');
  let socket: Socket | undefined;
  try {
    const endpoint = JSON.parse(await readFile(endpointFile(config), 'utf8')) as WorkerEndpoint;
    if (endpoint.version !== 1 || !Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535 || !/^[a-f0-9]{64}$/.test(endpoint.token)) return 'no_worker';
    socket = createConnection({ host: '127.0.0.1', port: endpoint.port });
    socket.on('error', () => {});
    // Closing an idle browser can take several seconds.
    const reply = readLine(socket, 30_000);
    socket.write(`${endpoint.token} release ${account}\n`);
    const result = await reply;
    return ['released', 'not_open', 'busy', 'unsupported'].includes(result) ? result as AccountReleaseResult : 'error';
  } catch { return 'no_worker'; }
  finally { socket?.destroy(); }
}

export interface SharedWorkerHandle { close(): Promise<void>; done: Promise<void>; }

/** One queue/browser; each authenticated local connection gets its own MCP session. */
export async function startSharedWorker(config: Config, options: { browser?: ChatGPTBrowser; browserFactory?: AccountBrowserFactory; idleMs?: number } = {}): Promise<SharedWorkerHandle> {
  const release = await acquireRuntime(config);
  const browser = options.browser ?? new ChatGPTBrowser(config);
  let store: JobStore;
  try { store = new JobStore(config.dataDir); }
  catch (error) { await release(); throw error; }
  const queue = new JobQueue(store, browser);
  const accounts = new AccountManager(new AccountRegistry(config), { account: 'default', store, queue, browser }, options.browserFactory);
  const token = randomBytes(32).toString('hex');
  const connections = new Map<Socket, ReturnType<typeof createServer>>();
  const sockets = new Set<Socket>();
  let timer: NodeJS.Timeout | undefined;
  let closing: Promise<void> | undefined;
  let resolveDone!: () => void;
  const done = new Promise<void>(resolve => { resolveDone = resolve; });
  const listener = createNetServer(socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => {
      sockets.delete(socket);
      const server = connections.get(socket);
      connections.delete(socket);
      void server?.close().catch(() => {});
      scheduleIdle();
    });
    void (async () => {
      const [provided = '', request, account] = (await readLine(socket)).split(' ');
      if (closing || provided.length !== token.length || !timingSafeEqual(Buffer.from(provided), Buffer.from(token))) throw new Error('Invalid worker handshake.');
      // Terminal account repair: one reply line, then close. MCP connections send only the token.
      if (request !== undefined) {
        if (request !== 'release' || !account || !accountNamePattern.test(account)) throw new Error('Invalid worker request.');
        const result = await accounts.release(account).catch(() => 'error');
        socket.end(`${result}\n`);
        return;
      }
      if (timer) clearTimeout(timer);
      const server = createServer(store, queue, browser, accounts);
      connections.set(socket, server);
      await server.connect(new StdioServerTransport(socket, socket));
      socket.write(`${greeting}\n`);
      socket.resume();
    })().catch(() => socket.destroy());
  });
  function scheduleIdle(wait = options.idleMs ?? 1000): void {
    if (timer) clearTimeout(timer);
    if (closing || connections.size) return;
    timer = setTimeout(() => {
      if (connections.size) return;
      // Accepted image jobs continue even if their submitting client disconnects.
      if (accounts.isBusy()) scheduleIdle();
      else void close();
    }, wait);
  }
  function close(): Promise<void> {
    return closing ??= (async () => {
      if (timer) clearTimeout(timer);
      if (listener.listening) listener.close();
      for (const socket of sockets) socket.destroy();
      try {
        await accounts.close();
        await Promise.allSettled([...connections.values()].map(server => server.close()));
      } finally {
        await rm(endpointFile(config), { force: true });
        await release();
        resolveDone();
      }
    })();
  }
  try {
    await accounts.resumePending();
    await new Promise<void>((resolve, reject) => {
      listener.once('error', reject);
      listener.listen(0, '127.0.0.1', () => { listener.off('error', reject); resolve(); });
    });
    const address = listener.address();
    if (!address || typeof address === 'string') throw new Error('Local worker failed to listen.');
    const temporary = path.join(config.dataDir, `.worker-${process.pid}-${token.slice(0,8)}.tmp`);
    try {
      const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify({ version: 1, port: address.port, token, pid: process.pid } satisfies WorkerEndpoint)); }
      finally { await file.close(); }
      await rename(temporary, endpointFile(config));
    } finally { await rm(temporary, { force: true }); }
    listener.on('error', () => { void close(); });
    if ((await accounts.registry.names()).includes('default')) queue.kick();
    // Give the launching client time to attach; afterwards idle workers exit promptly.
    scheduleIdle(5000);
    return { close, done };
  } catch (error) { await close(); throw error; }
}

export async function runSharedStdio(config: Config): Promise<void> {
  const registry = new AccountRegistry(config);
  const account = await registry.active();
  const selected = account ? await registry.require(account) : undefined;
  // Preserve interactive setup, but never acquire the worker's runtime lock merely
  // to establish a second MCP connection. Protocol clients never get terminal prompts.
  if (!selected) console.error(`No accounts configured. Run ${cli('manage-accounts')} to add one.`);
  else if (process.stdin.isTTY && !await lockfile.check(selected.dataDir, { stale: 30_000 })) {
    const release = await acquireRuntime(selected);
    const browser = new ChatGPTBrowser(selected);
    try {
      const state = await setupSession(browser, selected.headless);
      if (state.status !== 'ready') console.error('Starting MCP with an unready browser session. Check session_status after resolving the displayed issue.');
    } finally { await browser.close().catch(() => {}); await release(); }
  } else {
    const browser = new ChatGPTBrowser(selected);
    console.error(await browser.hasSavedSession()
      ? 'Saved ChatGPT session token found. Use session_status to check whether it is still valid.'
      : `No saved ChatGPT session token for the selected account. Run ${cli('manage-accounts')} in a terminal and sign in to '${await registry.active()}'.`);
  }
  const socket = await connectWorker(config);
  const stop = (): void => { socket.destroy(); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  const inputError = (): void => stop();
  process.stdin.on('error', inputError);
  try {
    const disconnected = new Promise<void>(resolve => socket.once('close', resolve));
    process.stdin.pipe(socket);
    socket.pipe(process.stdout, { end: false });
    console.error('ChatGPT Images MCP running on stdio (shared local worker).');
    socket.resume();
    await disconnected;
  } finally {
    process.stdin.unpipe(socket); socket.unpipe(process.stdout); process.stdin.pause(); socket.destroy();
    process.stdin.off('error', inputError);
    process.off('SIGINT', stop); process.off('SIGTERM', stop);
  }
}
