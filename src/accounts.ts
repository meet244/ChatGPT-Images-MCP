import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import Database from 'better-sqlite3';
import type { Config } from './config.js';
import { ChatGPTBrowser } from './browser.js';
import { JobStore } from './store.js';
import { JobQueue } from './queue.js';
import { acquireRuntime } from './runtime.js';

export const accountNamePattern = /^[a-z][a-z0-9_-]{0,47}$/;
export function validateAccountName(name: string): string {
  if (!accountNamePattern.test(name)) throw new Error('Account names must use 1–48 lowercase letters, digits, underscores or hyphens, starting with a letter.');
  return name;
}

/** The existing data directory is always default; its credentials never move. */
export class AccountRegistry {
  constructor(readonly baseConfig: Config) {}
  private get directory(): string { return path.join(this.baseConfig.dataDir, 'accounts'); }
  async names(): Promise<string[]> {
    try {
      const entries = await readdir(this.directory, { withFileTypes: true });
      return ['default', ...entries.filter(entry => entry.isDirectory() && entry.name !== 'default' && accountNamePattern.test(entry.name)).map(entry => entry.name).sort()];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ['default'];
      throw error;
    }
  }
  async require(name: string): Promise<Config> {
    validateAccountName(name);
    if (!(await this.names()).includes(name)) throw new Error(`Unknown account '${name}'. Add it with account-add --account ${name}, then sign in.`);
    return name === 'default' ? { ...this.baseConfig } : {
      ...this.baseConfig, dataDir: path.join(this.directory, name),
      // A global cookie import belongs only to the original account.
      cookiesFile: undefined,
    };
  }
  async active(): Promise<string> {
    try {
      const saved: unknown = JSON.parse(await readFile(path.join(this.baseConfig.dataDir, 'active-account.json'), 'utf8'));
      if (typeof saved !== 'string') throw new Error();
      await this.require(saved);
      return saved;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'default';
      throw new Error('The selected account setting is invalid. Run account-use --account default to repair it.');
    }
  }
  async add(name: string): Promise<Config> {
    validateAccountName(name);
    if (name === 'default') throw new Error("Account 'default' already exists with your original session.");
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.baseConfig.dataDir, 0o700);
    await chmod(this.directory, 0o700);
    try { await mkdir(path.join(this.directory, name), { mode: 0o700 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`Account '${name}' already exists. Use setup --account ${name} to finish signing in.`);
      throw error;
    }
    return this.require(name);
  }
  async use(name: string): Promise<{ account: string }> {
    await this.require(name);
    await mkdir(this.baseConfig.dataDir, { recursive: true, mode: 0o700 });
    const temporary = path.join(this.baseConfig.dataDir, `.account-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify(name), { flag: 'wx', mode: 0o600 });
      await rename(temporary, path.join(this.baseConfig.dataDir, 'active-account.json'));
    } finally { await rm(temporary, { force: true }); }
    return { account: name };
  }
  async list() {
    const active = await this.active();
    const accounts = await Promise.all((await this.names()).map(async name => {
      const config = await this.require(name);
      try {
        const browser = new ChatGPTBrowser(config);
        return { account: name, active: name === active, has_saved_session: await browser.hasSavedSession() };
      } catch {
        return { account: name, active: name === active, has_saved_session: false, error: 'Saved session could not be read. Run setup for this account.' };
      }
    }));
    return { active_account: active, accounts };
  }
  /** Read-only lookup never recovers jobs or takes another account's browser lock. */
  async inspectDatabase<T>(name: string, inspect: (db: Database.Database) => T): Promise<T | undefined> {
    const config = await this.require(name);
    const file = path.join(config.dataDir, 'jobs.sqlite');
    try { await stat(file); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw new Error(`Cannot read jobs for account '${name}'.`);
    }
    let db: Database.Database;
    try { db = new Database(file, { readonly: true, fileMustExist: true }); }
    catch { throw new Error(`Cannot read jobs for account '${name}'.`); }
    try { return inspect(db); } finally { db.close(); }
  }
  async owner(id: string, batch = false): Promise<string> {
    for (const name of await this.names()) {
      const found = await this.inspectDatabase(name, db => batch
        ? db.prepare("SELECT 1 FROM jobs WHERE json_extract(body, '$.batchId') = ? LIMIT 1").get(id)
        : db.prepare('SELECT 1 FROM jobs WHERE id = ?').get(id));
      if (found) return name;
    }
    throw new Error(batch ? 'Batch not found.' : 'Job not found.');
  }
}

export interface AccountRuntime { account: string; store: JobStore; queue: JobQueue; browser: ChatGPTBrowser; }
export type AccountBrowserFactory = (config: Config, account: string) => ChatGPTBrowser;

/** One isolated FIFO queue per account, shared by every connected client. */
export class AccountManager {
  private runtimes = new Map<string, AccountRuntime>();
  private opening = new Map<string, Promise<AccountRuntime>>();
  private releases = new Map<string, () => Promise<void>>();
  private closing?: Promise<void>;
  constructor(readonly registry: AccountRegistry, initial: AccountRuntime,
    private browserFactory: AccountBrowserFactory = config => new ChatGPTBrowser(config)) {
    this.runtimes.set('default', initial);
  }
  async resolve(account?: string, id?: string, batch = false): Promise<AccountRuntime> {
    if (this.closing) throw new Error('Server is shutting down.');
    const name = account ?? (id ? await this.registry.owner(id, batch) : await this.registry.active());
    if (this.closing) throw new Error('Server is shutting down.');
    const existing = this.runtimes.get(name);
    if (existing) return existing;
    const pending = this.opening.get(name);
    if (pending) return pending;
    const opening = this.open(name);
    this.opening.set(name, opening);
    try { return await opening; } finally { this.opening.delete(name); }
  }
  private async open(name: string): Promise<AccountRuntime> {
    const config = await this.registry.require(name);
    let release: () => Promise<void>;
    try { release = await acquireRuntime(config); }
    catch { throw new Error(`Account '${name}' is in use by another worker or session command. Finish that command, or disconnect MCP clients using this profile before modifying its session.`); }
    let store: JobStore | undefined;
    try {
      store = new JobStore(config.dataDir);
      const browser = this.browserFactory(config, name);
      const queue = new JobQueue(store, browser);
      const runtime = { account: name, store, queue, browser };
      this.runtimes.set(name, runtime);
      this.releases.set(name, release);
      queue.kick();
      return runtime;
    } catch (error) { store?.close(); await release(); throw error; }
  }
  async resumePending(): Promise<void> {
    for (const name of await this.registry.names()) {
      if (name === 'default') continue;
      const pending = await this.registry.inspectDatabase(name, db => db.prepare("SELECT 1 FROM jobs WHERE status IN ('queued', 'running') LIMIT 1").get());
      if (pending) await this.resolve(name);
    }
  }
  isBusy(): boolean {
    return this.opening.size > 0 || [...this.runtimes.values()].some(({ queue, store }) => queue.isBusy() || store.byStatus('queued').length > 0);
  }
  close(): Promise<void> {
    return this.closing ??= (async () => {
      await Promise.allSettled([...this.opening.values()]);
      const results = await Promise.allSettled([...this.runtimes.values()].map(async ({ store, queue, browser, account }) => {
        const stopped = queue.stop();
        try { await browser.close().catch(() => {}); await stopped; }
        finally { try { store.close(); } finally { await this.releases.get(account)?.(); } }
      }));
      const failed = results.find(result => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
    })();
  }
}
