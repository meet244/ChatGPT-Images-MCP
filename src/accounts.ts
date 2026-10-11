import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readdir, readFile, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import Database from 'better-sqlite3';
import lockfile from 'proper-lockfile';
import type { Config } from './config.js';
import { cli } from './config.js';
import { ChatGPTBrowser, BrowserError, TextOnlyResponseError, type GenerationOptions } from './browser.js';
import { JobStore, imageCooldownMs, type ImageCooldown, type Job } from './store.js';
import { JobQueue, CooldownError, BatchRestartError } from './queue.js';
import { acquireRuntime } from './runtime.js';
import { stopChrome } from './chrome.js';
import { inspectSavedSession, type SavedSessionStatus } from './saved-session.js';

export const accountNamePattern = /^[a-z][a-z0-9_-]{0,47}$/;
export function validateAccountName(name: string): string {
  if (!accountNamePattern.test(name)) throw new Error('Account names must use 1–48 lowercase letters, digits, underscores or hyphens, starting with a letter.');
  return name;
}

interface AccountSettings {
  version: 1;
  mode: 'priority' | 'manual';
  selected?: string;
  legacyDefaultDeleted?: boolean;
  accounts: Record<string, { label?: string; priority?: number; email?: string; plan?: string }>;
}
export interface AccountProfile { email?: string; plan?: string }
const validEmail = (value: unknown): boolean => typeof value === 'string' && /^[^\s@\x00-\x1f]{1,64}@[^\s@\x00-\x1f]{1,190}$/.test(value);
const validPlan = (value: unknown): boolean => typeof value === 'string' && /^[a-z0-9_-]{1,32}$/.test(value);
const defaultPriority = 100;

export class NoAccountsError extends Error {
  constructor() { super(`No accounts configured. Run ${cli('manage-accounts')} in a terminal and add an account first.`); }
}

/** Existing root-level sessions retain their paths; new installations start empty. */
export class AccountRegistry {
  constructor(readonly baseConfig: Config) {}
  private get directory(): string { return path.join(this.baseConfig.dataDir, 'accounts'); }
  private get settingsFile(): string { return path.join(this.baseConfig.dataDir, 'account-settings.json'); }
  private async settings(): Promise<AccountSettings> {
    try {
      const value: AccountSettings = JSON.parse(await readFile(this.settingsFile, 'utf8'));
      if (value.version !== 1 || !['priority', 'manual'].includes(value.mode) || !value.accounts || typeof value.accounts !== 'object' || Array.isArray(value.accounts)
        || (value.legacyDefaultDeleted !== undefined && typeof value.legacyDefaultDeleted !== 'boolean')
        || (value.mode === 'manual' && (typeof value.selected !== 'string' || !accountNamePattern.test(value.selected)))) throw new Error();
      for (const [name, entry] of Object.entries(value.accounts)) {
        if (!accountNamePattern.test(name) || !entry || typeof entry !== 'object'
          || (entry.label !== undefined && (typeof entry.label !== 'string' || !entry.label.trim() || entry.label.length > 80 || /[\x00-\x1f\x7f]/.test(entry.label)))
          || (entry.priority !== undefined && (!Number.isInteger(entry.priority) || entry.priority < 0 || entry.priority > 999999))
          || (entry.email !== undefined && !validEmail(entry.email)) || (entry.plan !== undefined && !validPlan(entry.plan))) throw new Error();
      }
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, mode: 'priority', accounts: {} };
      throw new Error('Account settings could not be read. Repair account-settings.json before managing accounts.');
    }
  }
  private async updateSettings(update: (settings: AccountSettings) => void | Promise<void>): Promise<void> {
    await mkdir(this.baseConfig.dataDir, { recursive: true, mode: 0o700 });
    const release = await lockfile.lock(this.settingsFile, { realpath: false, retries: { retries: 8, minTimeout: 30, maxTimeout: 200 } });
    const temporary = path.join(this.baseConfig.dataDir, `.settings-${randomUUID()}.tmp`);
    try {
      const settings = await this.settings();
      await update(settings);
      await writeFile(temporary, JSON.stringify(settings, null, 2), { flag: 'wx', mode: 0o600 });
      await rename(temporary, this.settingsFile);
    } finally { await rm(temporary, { force: true }); await release(); }
  }
  /** Display names change without moving authentication profiles or historical artifact paths. */
  async rename(name: string, label: string): Promise<void> {
    await this.require(name);
    label = label.trim();
    if (!label || label.length > 80 || /[\x00-\x1f\x7f]/.test(label)) throw new Error('Display names must contain 1–80 characters without control characters.');
    await this.updateSettings(async settings => {
      await this.require(name);
      settings.accounts[name] = { ...settings.accounts[name], label };
    });
  }
  async setPriority(name: string, priority: number): Promise<void> {
    await this.require(name);
    if (!Number.isInteger(priority) || priority < 0 || priority > 999999) throw new Error('Priority must be a whole number between 0 and 999999. Higher numbers run first.');
    await this.updateSettings(async settings => {
      await this.require(name);
      settings.accounts[name] = { ...settings.accounts[name], priority };
    });
  }
  /** Detected after sign-in; shown in the terminal menu only, never in MCP responses. */
  async setProfile(name: string, profile: AccountProfile): Promise<void> {
    await this.require(name);
    if ((profile.email !== undefined && !validEmail(profile.email)) || (profile.plan !== undefined && !validPlan(profile.plan))) throw new Error('Account details could not be saved.');
    await this.updateSettings(async settings => {
      await this.require(name);
      settings.accounts[name] = { ...settings.accounts[name], ...(profile.email ? { email: profile.email } : {}), ...(profile.plan ? { plan: profile.plan } : {}) };
    });
  }
  async profile(name: string): Promise<AccountProfile> {
    const entry = (await this.settings()).accounts[name];
    return { ...(entry?.email ? { email: entry.email } : {}), ...(entry?.plan ? { plan: entry.plan } : {}) };
  }
  /** Swap with the neighbouring account in priority order; priorities are renumbered to keep the order strict. */
  async move(name: string, direction: -1 | 1): Promise<void> {
    await this.require(name);
    await this.updateSettings(async settings => {
      const [names, active] = await Promise.all([this.names(), this.active()]);
      const order = names.sort((a, b) => (settings.accounts[b]?.priority ?? defaultPriority) - (settings.accounts[a]?.priority ?? defaultPriority)
        || Number(b === active) - Number(a === active) || a.localeCompare(b));
      const index = order.indexOf(name), target = index + direction;
      if (index < 0 || target < 0 || target >= order.length) return;
      [order[index], order[target]] = [order[target]!, order[index]!];
      order.forEach((account, position) => { settings.accounts[account] = { ...settings.accounts[account], priority: order.length - position }; });
    });
  }
  async select(name: string): Promise<void> {
    await this.require(name);
    await this.updateSettings(async settings => { await this.require(name); settings.mode = 'manual'; settings.selected = name; });
    await this.use(name);
  }
  async usePriorityOrder(): Promise<void> {
    await this.updateSettings(settings => { settings.mode = 'priority'; delete settings.selected; });
  }
  async manualSelection(): Promise<string | undefined> {
    const settings = await this.settings();
    return settings.mode === 'manual' ? settings.selected : undefined;
  }
  async orderedNames(): Promise<string[]> {
    const [names, active, settings] = await Promise.all([this.names(), this.active(), this.settings()]);
    return names.sort((a, b) => {
      if (settings.mode === 'manual') {
        if (a === settings.selected) return -1;
        if (b === settings.selected) return 1;
      }
      return (settings.accounts[b]?.priority ?? defaultPriority) - (settings.accounts[a]?.priority ?? defaultPriority)
        || Number(b === active) - Number(a === active) || a.localeCompare(b);
    });
  }
  async names(): Promise<string[]> {
    const settings = await this.settings();
    let legacy = !!settings.accounts.default;
    if (!legacy && !settings.legacyDefaultDeleted) {
      legacy = !!this.baseConfig.cookiesFile;
      if (!legacy) {
        try { await stat(path.join(this.baseConfig.dataDir, 'session-cookies.json')); legacy = true; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
      if (!legacy) {
        const file = path.join(this.baseConfig.dataDir, 'jobs.sqlite');
        try {
          await stat(file);
          const db = new Database(file, { readonly: true, fileMustExist: true });
          try { legacy = !!db.prepare('SELECT 1 FROM jobs LIMIT 1').get(); }
          finally { db.close(); }
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
    }
    const original = legacy ? ['default'] : [];
    try {
      const entries = await readdir(this.directory, { withFileTypes: true });
      return [...original, ...entries.filter(entry => entry.isDirectory() && entry.name !== 'default' && accountNamePattern.test(entry.name)).map(entry => entry.name).sort()];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return original;
      throw error;
    }
  }
  async require(name: string | undefined): Promise<Config> {
    if (name === undefined) throw new NoAccountsError();
    validateAccountName(name);
    if (!(await this.names()).includes(name)) throw new Error(`Unknown account '${name}'. Add it with ${cli('manage-accounts')}, then sign in.`);
    return name === 'default' ? { ...this.baseConfig } : {
      ...this.baseConfig, dataDir: path.join(this.directory, name),
      // A global cookie import belongs only to the original account.
      cookiesFile: undefined,
    };
  }
  async active(): Promise<string | undefined> {
    const names = await this.names();
    try {
      const saved: unknown = JSON.parse(await readFile(path.join(this.baseConfig.dataDir, 'active-account.json'), 'utf8'));
      if (typeof saved !== 'string' || !accountNamePattern.test(saved)) throw new Error();
      return names.includes(saved) ? saved : names[0];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return names[0];
      throw new Error(`The selected account setting is invalid. Run ${cli('manage-accounts')} and select an account to repair it.`);
    }
  }
  async add(name: string): Promise<Config> {
    validateAccountName(name);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.baseConfig.dataDir, 0o700);
    await chmod(this.directory, 0o700);
    const directory = name === 'default' ? this.baseConfig.dataDir : path.join(this.directory, name);
    let created = false;
    try {
      // Allocate the priority and create the profile under one shared settings lock.
      // Concurrent additions therefore each receive a distinct maximum + 1.
      await this.updateSettings(async settings => {
        const names = await this.names();
        if (names.includes(name)) throw Object.assign(new Error(), { code: 'EEXIST' });
        const maximum = names.reduce((max, account) => Math.max(max, settings.accounts[account]?.priority ?? defaultPriority), 0);
        if (maximum === 999999) throw new Error('Cannot add an account: maximum priority is already 999999. Lower that priority first.');
        if (name !== 'default') { await mkdir(directory, { mode: 0o700 }); created = true; }
        else delete settings.legacyDefaultDeleted;
        settings.accounts[name] = { priority: maximum + 1 };
      });
    }
    catch (error) {
      // Only remove an empty profile created by this call if settings could not be saved.
      if (created) await rmdir(directory).catch(() => {});
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`Account '${name}' already exists. Use ${cli(`setup --account ${name}`)} to finish signing in.`);
      throw error;
    }
    return this.require(name);
  }
  async remove(name: string): Promise<void> {
    const config = await this.require(name);
    // Do not erase credentials, databases, or profiles held by a running worker/setup.
    let release: () => Promise<void>;
    try { release = await acquireRuntime(config); }
    catch { throw new Error(`Account '${name}' is in use. Disconnect MCP clients and finish setup commands, then delete it again.`); }
    try {
      await this.updateSettings(async settings => {
        await this.require(name);
        await stopChrome(config);
        if (name === 'default') {
          // The root also contains shared registry/worker files and other accounts.
          for (const file of ['session-cookies.json', 'chrome-profile', 'browser-profile', 'webkit-profile', 'jobs.sqlite', 'jobs.sqlite-wal', 'jobs.sqlite-shm', 'images', 'references']) {
            await rm(path.join(config.dataDir, file), { recursive: true, force: true });
          }
          settings.legacyDefaultDeleted = true;
        } else await rm(config.dataDir, { recursive: true, force: true });
        delete settings.accounts[name];
        if (settings.selected === name) { settings.mode = 'priority'; delete settings.selected; }
        // Remove only this profile's last-used selection, leaving other selections intact.
        const activeFile = path.join(this.baseConfig.dataDir, 'active-account.json');
        try {
          if (JSON.parse(await readFile(activeFile, 'utf8')) === name) await rm(activeFile, { force: true });
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      });
    } finally { await release(); }
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
    const [active, settings] = await Promise.all([this.active(), this.settings()]);
    const accounts = await Promise.all((await this.names()).map(async name => {
      const config = await this.require(name);
      try {
        const browser = new ChatGPTBrowser(config);
        return { account: name, display_name: settings.accounts[name]?.label ?? name, priority: settings.accounts[name]?.priority ?? defaultPriority, active: name === active, has_saved_session: await browser.hasSavedSession() };
      } catch {
        return { account: name, display_name: settings.accounts[name]?.label ?? name, priority: settings.accounts[name]?.priority ?? defaultPriority, active: name === active, has_saved_session: false, error: `Saved session could not be read. Run ${cli('manage-accounts')} and sign in to this account again.` };
      }
    }));
    accounts.sort((a, b) => b.priority - a.priority || Number(b.active) - Number(a.active) || a.account.localeCompare(b.account));
    return { active_account: active ?? null, selection_mode: settings.mode, manual_account: settings.mode === 'manual' ? settings.selected : undefined, accounts };
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

export class AccountSelectionError extends Error {
  constructor(readonly account: string, readonly status: 'busy' | 'unavailable', message: string) { super(message); }
}

class BrowserSwitchError extends Error {
  constructor(account: string) {
    super(`Could not close dedicated Chrome for account '${account}'. Account switching stopped; close that dedicated Chrome before retrying.`);
  }
}

/** Isolated FIFO queues share one browser slot across every connected client. */
export class AccountManager {
  private runtimes = new Map<string, AccountRuntime>();
  private opening = new Map<string, Promise<AccountRuntime>>();
  private releases = new Map<string, () => Promise<void>>();
  private browserOperations = new Map<string, { tail: Promise<void>; count: number }>();
  private browserTail: Promise<void> = Promise.resolve();
  private activeBrowser?: AccountRuntime;
  private generationProfiles = new Map<string, Set<string>>();
  private closeCandidates = new Set<string>();
  private closing?: Promise<void>;
  constructor(readonly registry: AccountRegistry, initial: AccountRuntime,
    private browserFactory: AccountBrowserFactory = config => new ChatGPTBrowser(config)) {
    this.runtimes.set('default', initial);
    this.configureQueue(initial);
  }
  get autoSwitchAccounts(): boolean { return this.registry.baseConfig.autoSwitchAccounts; }

  /** All profiles share one browser slot, including fallback checks and cleanup. */
  private async activateBrowser(runtime: AccountRuntime): Promise<void> {
    if (this.activeBrowser === runtime) return;
    if (this.activeBrowser) {
      const previous = this.activeBrowser;
      try { await previous.browser.shutdown(); }
      catch { throw new BrowserSwitchError(previous.account); }
      this.activeBrowser = undefined;
    }
    this.activeBrowser = runtime;
  }
  private withBrowser<T>(runtime: AccountRuntime, action: () => Promise<T>, activate = true): Promise<T> {
    let operations = this.browserOperations.get(runtime.account);
    if (!operations) {
      operations = { tail: Promise.resolve(), count: 0 };
      this.browserOperations.set(runtime.account, operations);
    }
    const state = operations;
    state.count++;
    const pending = this.browserTail.then(async () => {
      if (this.closing) throw new Error('Server is shutting down.');
      if (activate) await this.activateBrowser(runtime);
      return action();
    });
    const result = pending.finally(() => {
      state.count--;
      if (!state.count && !this.closing && this.closeCandidates.has(runtime.account)) void this.closeUnusedProfiles();
    });
    state.tail = result.then(() => {}, () => {});
    this.browserTail = state.tail;
    return result;
  }
  async inspectSession(runtime: AccountRuntime) {
    const cooldown = runtime.store.imageCooldown();
    if (cooldown) return { status: 'usage_limit', message: new CooldownError(cooldown).message, ...cooldown };
    if ([...this.browserOperations.values()].some(operations => operations.count)) {
      return { status: 'busy', message: 'Browser is processing a job or session check. Try again when the queue is idle.' };
    }
    return this.withBrowser(runtime, () => runtime.queue.inspectSession(runtime.browser, async () => {
      await runtime.browser.shutdown();
      if (this.activeBrowser === runtime) this.activeBrowser = undefined;
    }));
  }
  /** MCP status reads saved sessions/history without opening runtimes or browsers. */
  async inspectSavedSession(): Promise<SavedSessionStatus> {
    const names = await this.registry.orderedNames();
    if (!names.length) throw new NoAccountsError();
    if ([...this.runtimes.values()].some(({ queue }) => queue.hasPendingWork())) return { status: 'busy' };
    const manual = await this.registry.manualSelection();
    let replaceManual = false;
    let limited: SavedSessionStatus | undefined;
    let attention: { account: string; state: SavedSessionStatus } | undefined;
    let missing: SavedSessionStatus | undefined;
    for (const account of names) {
      let state: SavedSessionStatus;
      try {
        const runtime = this.runtimes.get(account);
        const cooldown = runtime ? runtime.store.imageCooldown() : await this.registry.inspectDatabase(account, db => {
          const row = db.prepare("SELECT body FROM settings WHERE key = 'image_cooldown'").get() as { body: string } | undefined;
          let value: ImageCooldown | undefined;
          if (row) value = JSON.parse(row.body);
          else {
            const previous = db.prepare("SELECT body FROM jobs WHERE status = 'failed' AND json_extract(body, '$.errorCode') IN ('free_tier_exhausted', 'image_usage_limit') ORDER BY COALESCE(json_extract(body, '$.limitDetectedAt'), json_extract(body, '$.updatedAt')) DESC LIMIT 1").get() as { body: string } | undefined;
            if (previous) {
              const job = JSON.parse(previous.body) as Job;
              const detectedAt = job.limitDetectedAt ?? job.updatedAt;
              value = { errorCode: job.errorCode!, error: job.error ?? '', detectedAt,
                retryAfter: new Date(Date.parse(detectedAt) + imageCooldownMs).toISOString() };
            }
          }
          if (!value) return;
          if (!['free_tier_exhausted', 'image_usage_limit'].includes(value.errorCode)
            || !Number.isFinite(Date.parse(value.detectedAt)) || !Number.isFinite(Date.parse(value.retryAfter))) throw new Error();
          return Date.now() < Date.parse(value.retryAfter) ? value : undefined;
        });
        const saved = await inspectSavedSession(await this.registry.require(account));
        state = saved.reason === 'expired' ? saved
          : cooldown ? { status: 'usage_limit', retryAfter: cooldown.retryAfter } : saved;
      } catch {
        state = { status: 'unavailable', message: `Saved session history could not be read. Run ${cli('manage-accounts')} and sign in to this account again.` };
      }
      if (account === manual && state.reason) replaceManual = true;
      if (state.status === 'ready') {
        if (this.isBusy()) return { status: 'busy' };
        if (replaceManual) await this.registry.select(account);
        else if (await this.registry.active() !== account) await this.registry.use(account);
        return this.isBusy() ? { status: 'busy' } : state;
      }
      if (state.status === 'usage_limit') limited ??= state;
      else if (state.reason === 'missing') {
        if (!this.autoSwitchAccounts && account === manual) { attention = { account, state }; break; }
        missing ??= state;
        continue;
      }
      else attention ??= { account, state };
      if (!this.autoSwitchAccounts) break;
    }
    if (attention) {
      if (this.isBusy()) return { status: 'busy' };
      if (await this.registry.active() !== attention.account) await this.registry.use(attention.account);
      return attention.state;
    }
    return limited ?? missing!;
  }
  private configureQueue(runtime: AccountRuntime): void {
    runtime.queue.setExecutor((job, submitted, options, previous) => this.generate(runtime, job, submitted, options, previous));
    runtime.queue.setIdleHandler(async () => {
      const profiles = this.generationProfiles.get(runtime.account);
      this.generationProfiles.delete(runtime.account);
      for (const profile of profiles ?? []) this.closeCandidates.add(profile);
      await this.closeUnusedProfiles();
    });
  }
  private trackProfile(owner: AccountRuntime, profile: AccountRuntime): void {
    let profiles = this.generationProfiles.get(owner.account);
    if (!profiles) { profiles = new Set(); this.generationProfiles.set(owner.account, profiles); }
    profiles.add(profile.account);
  }
  private profileNeeded(runtime: AccountRuntime): boolean {
    return runtime.queue.hasPendingWork() || [...this.generationProfiles.values()].some(profiles => profiles.has(runtime.account));
  }
  private async closeUnusedProfiles(): Promise<void> {
    if (this.closing) return;
    for (const account of this.closeCandidates) {
      if (this.closing) return;
      const runtime = this.runtimes.get(account);
      if (!runtime || this.profileNeeded(runtime) || this.browserOperations.get(account)?.count) continue;
      try {
        await this.withBrowser(runtime, async () => {
          // Recheck inside the browser mutex: another queue may have claimed this profile meanwhile.
          if (this.profileNeeded(runtime) || (this.browserOperations.get(account)?.count ?? 0) > 1) return;
          this.closeCandidates.delete(account);
          if (this.activeBrowser === runtime) {
            await runtime.browser.shutdown();
            this.activeBrowser = undefined;
          }
        }, false);
      } catch {
        this.closeCandidates.delete(account);
        if (!this.closing) process.stderr.write(`Could not close idle Chrome for account '${account}'. Saved job results are retained.\n`);
      }
    }
  }
  private async fallback(excluded: Set<string>, owner?: AccountRuntime, allowUnready = false): Promise<AccountRuntime | undefined> {
    let unready: AccountRuntime | undefined;
    let selectionError: AccountSelectionError | undefined;
    // Manual selection overrides the initial priority; fallbacks still follow priority order.
    for (const name of await this.registry.orderedNames()) {
      if (excluded.has(name)) continue;
      excluded.add(name);
      const config = await this.registry.require(name);
      let eligible: AccountRuntime | undefined;
      try {
        if (!await new ChatGPTBrowser(config).hasSavedSession()) continue;
        const runtime = await this.resolve(name);
        if (owner) this.trackProfile(owner, runtime);
        if (runtime.store.imageCooldown()) continue;
        eligible = runtime;
        // Status calls must not wait behind a long generation merely to validate
        // a fallback. inspectSession will report this selected profile as busy.
        if (allowUnready && [...this.browserOperations.values()].some(operation => operation.count)) return runtime;
        const status = await this.withBrowser(runtime, () => runtime.browser.sessionStatus());
        if (status.status === 'ready' && !runtime.store.imageCooldown()) return runtime;
        if (allowUnready && !runtime.store.imageCooldown()) unready ??= runtime;
      } catch (error) {
        // Locked, unreadable, signed-out, and challenged profiles are not usable fallbacks.
        if (error instanceof BrowserSwitchError) throw error;
        if (this.closing) throw new Error('Server is shutting down.');
        if (allowUnready && eligible) unready ??= eligible;
        else if (allowUnready) selectionError ??= error instanceof AccountSelectionError ? error
          : new AccountSelectionError(name, 'unavailable', `Saved session for account '${name}' could not be checked. Run ${cli('manage-accounts')} and sign in to it again.`);
      }
    }
    // Session checks must show an existing replacement's verification/login/error
    // state instead of falsely reporting that every account has exhausted usage.
    if (unready) return unready;
    if (selectionError) throw selectionError;
    // The final rejected candidate must not remain open when no fallback is ready.
    if (this.activeBrowser) {
      const runtime = this.activeBrowser;
      await this.withBrowser(runtime, async () => {
        if (this.activeBrowser !== runtime) return;
        try { await runtime.browser.shutdown(); }
        catch { throw new BrowserSwitchError(runtime.account); }
        this.activeBrowser = undefined;
      }, false);
    }
  }
  private async selectAfterLimit(exhausted: string, replacement: string): Promise<void> {
    // An in-flight job must not overwrite an unrelated manual account selection.
    if (await this.registry.active() === exhausted) await this.registry.use(replacement);
  }
  async resolveGeneration(options: { allowUnreadyFallback?: boolean } = {}): Promise<AccountRuntime> {
    const [ordered, listing] = await Promise.all([this.registry.orderedNames(), this.registry.list()]);
    if (!ordered.length) throw new NoAccountsError();
    const preferred = listing.selection_mode === 'manual' ? listing.manual_account
      : ordered.find(name => listing.accounts.some(account => account.account === name && account.has_saved_session));
    const runtime = await this.resolve(preferred ?? listing.active_account ?? undefined);
    const cooldown = runtime.store.imageCooldown();
    if (!cooldown) { await this.registry.use(runtime.account); return runtime; }
    if (!this.autoSwitchAccounts) throw new CooldownError(cooldown, runtime.account);
    const replacement = await this.fallback(new Set([runtime.account]), undefined, options.allowUnreadyFallback);
    if (!replacement) throw new CooldownError(cooldown, runtime.account, true);
    await this.selectAfterLimit(runtime.account, replacement.account);
    return replacement;
  }
  async listJobs(limit: number): Promise<Array<Job & { account: string }>> {
    const jobs = await Promise.all((await this.registry.names()).map(async account => {
      const rows = await this.registry.inspectDatabase(account, db => db.prepare('SELECT body FROM jobs ORDER BY created_at DESC, rowid DESC LIMIT ?').all(limit) as { body: string }[]);
      return (rows ?? []).map(row => ({ ...JSON.parse(row.body) as Job, account }));
    }));
    return jobs.flat().sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
  }
  private async generate(owner: AccountRuntime, job: Job, submitted: (url: string) => void, options: GenerationOptions, previous?: Job) {
    const automatic = Boolean(job.autoSwitchAccount && this.autoSwitchAccounts);
    const batchAccount = job.sameChatMandatory ? job.batchExecutionAccount : undefined;
    const startAccount = job.sameChatMandatory ? batchAccount ?? previous?.executionAccount
      : automatic ? previous?.executionAccount : undefined;
    let runtime = startAccount ? await this.resolve(startAccount) : owner;
    const excluded = new Set<string>([runtime.account, ...(job.batchTriedAccounts ?? [])]);
    const attemptedAccounts: string[] = [];
    while (true) {
      this.trackProfile(owner, runtime);
      try {
        return await this.withBrowser(runtime, async () => {
          const cooldown = runtime.store.imageCooldown();
          if (cooldown) throw new CooldownError(cooldown, runtime.account);
          await this.activateBrowser(runtime);
          attemptedAccounts.push(runtime.account);
          owner.store.update(job.id, { executionAccount: runtime.account, attemptedAccounts: [...attemptedAccounts], conversationUrl: undefined });
          // Conversations are private to a profile. Switching starts a fresh chat with the original snapshots.
          const sameAccount = runtime.account === (previous?.executionAccount ?? owner.account);
          const generationOptions = { ...options };
          if (!sameAccount) { delete generationOptions.conversationUrl; delete generationOptions.reuseReferences; }
          try {
            const generationId = job.batchAttempt ? `${job.id}-attempt-${job.batchAttempt}` : job.id;
            const result = await runtime.browser.generate(generationId, job.prompt, submitted, job.referenceImages ?? [], generationOptions);
            runtime.store.resetTextOnlyFailures();
            if (job.sameChatMandatory && generationOptions.conversationUrl && result.conversationUrl !== generationOptions.conversationUrl) {
              owner.store.update(job.id, { images: result.images, conversationUrl: result.conversationUrl });
              throw new BrowserError('ChatGPT changed the required batch conversation. The batch stopped; inspect the saved image and conversation before submitting again.');
            }
            return result;
          } catch (error) {
            if (error instanceof TextOnlyResponseError) {
              const cooldown = runtime.store.recordTextOnlyFailure();
              if (cooldown) throw new CooldownError(cooldown, runtime.account);
              throw error;
            }
            runtime.store.resetTextOnlyFailures();
            if (!(error instanceof BrowserError) || !error.code) throw error;
            // Save the limit before releasing the profile to another waiting request.
            throw new CooldownError(runtime.store.recordImageLimit(error.code, error.message, error.resetText), runtime.account);
          }
        }, false);
      } catch (error) {
        if (!(error instanceof CooldownError) || !automatic || this.closing) throw error;
        const replacement = await this.fallback(excluded, owner);
        if (!replacement) throw new CooldownError(error.cooldown, error.account, true);
        await this.selectAfterLimit(runtime.account, replacement.account);
        if (job.sameChatMandatory && job.batchId) {
          owner.store.restartBatch(job.batchId, replacement.account, job.id, error.message);
          throw new BatchRestartError('Mandatory same-chat batch restarted on another account.');
        }
        runtime = replacement;
      }
    }
  }
  async resolve(account?: string, id?: string, batch = false): Promise<AccountRuntime> {
    if (this.closing) throw new Error('Server is shutting down.');
    const name = account ?? (id ? await this.registry.owner(id, batch) : await this.registry.active());
    if (!name) throw new NoAccountsError();
    await this.registry.require(name);
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
    catch { throw new AccountSelectionError(name, 'busy', `Account '${name}' is in use by another worker or session command. Finish that command, or disconnect MCP clients using this profile before modifying its session.`); }
    let store: JobStore | undefined;
    try {
      store = new JobStore(config.dataDir);
      const browser = this.browserFactory(config, name);
      const queue = new JobQueue(store, browser);
      const runtime = { account: name, store, queue, browser };
      this.configureQueue(runtime);
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
  /**
   * Let a terminal command repair an idle account's session while this worker runs.
   * Only an idle worker releases a profile; the next request reopens it as usual.
   */
  async release(name: string): Promise<'released' | 'not_open' | 'busy' | 'unsupported'> {
    // The original account shares the worker's own data-directory lock.
    if (name === 'default') return 'unsupported';
    if (this.closing || this.isBusy()) return 'busy';
    const runtime = this.runtimes.get(name);
    if (!runtime) return 'not_open';
    return this.withBrowser(runtime, async () => {
      if (this.runtimes.get(name) !== runtime || this.profileNeeded(runtime) || (this.browserOperations.get(name)?.count ?? 0) > 1) return 'busy';
      if (this.activeBrowser === runtime) {
        await runtime.browser.shutdown();
        this.activeBrowser = undefined;
      }
      this.runtimes.delete(name);
      this.closeCandidates.delete(name);
      try { await runtime.queue.stop(); }
      finally {
        try { runtime.store.close(); }
        finally { await this.releases.get(name)?.(); this.releases.delete(name); }
      }
      return 'released';
    }, false);
  }
  isBusy(): boolean {
    return this.opening.size > 0 || [...this.browserOperations.values()].some(operations => operations.count > 0)
      || [...this.runtimes.values()].some(({ queue }) => queue.isBusy());
  }
  close(): Promise<void> {
    return this.closing ??= (async () => {
      await Promise.allSettled([...this.opening.values()]);
      const results = await Promise.allSettled([...this.runtimes.values()].map(async ({ store, queue, browser, account }) => {
        const stopped = queue.stop();
        try {
          await browser.close().catch(() => {});
          await stopped;
          await this.browserOperations.get(account)?.tail;
          await browser.shutdown();
        }
        finally { try { store.close(); } finally { await this.releases.get(account)?.(); } }
      }));
      const failed = results.find(result => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
    })();
  }
}
