import path from 'node:path';
import { lstat, readdir, rm, stat } from 'node:fs/promises';
import lockfile from 'proper-lockfile';
import type { AccountRegistry } from './accounts.js';
import type { Config } from './config.js';
import { acquireRuntime } from './runtime.js';
import { runningChrome } from './chrome.js';
import type { Job, JobStatus } from './store.js';
import { pruneReferences } from './references.js';
import { requestAccountRelease } from './shared-worker.js';

/** Chrome rebuilds these by itself; deleting them never signs an account out. */
const cacheFolders = ['Default/Cache', 'Default/Code Cache', 'Default/GPUCache', 'Default/DawnGraphiteCache', 'Default/DawnWebGPUCache',
  'GrShaderCache', 'GraphiteDawnCache', 'ShaderCache'];
const profileFolders = ['chrome-profile', 'browser-profile'];

export async function folderSize(target: string): Promise<number> {
  let info;
  try { info = await lstat(target); } catch { return 0; }
  if (!info.isDirectory()) return info.size;
  let total = 0;
  let entries: string[] = [];
  try { entries = await readdir(target); } catch { return 0; }
  for (const entry of entries) total += await folderSize(path.join(target, entry));
  return total;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 ** 3) return `${Math.round(bytes / 1024 / 1024)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

export interface AccountDisk { account: string; profile: number; cache: number; images: number; references: number }

async function accountDisk(account: string, config: Config): Promise<AccountDisk> {
  let profile = 0, cache = 0;
  for (const folder of profileFolders) {
    profile += await folderSize(path.join(config.dataDir, folder));
    for (const cached of cacheFolders) cache += await folderSize(path.join(config.dataDir, folder, cached));
  }
  return { account, profile, cache, images: await folderSize(path.join(config.dataDir, 'images')), references: await folderSize(path.join(config.dataDir, 'references')) };
}

/** Space used by each account, without taking any locks. */
export async function diskUsage(registry: AccountRegistry): Promise<AccountDisk[]> {
  const accounts: AccountDisk[] = [];
  for (const name of await registry.names()) accounts.push(await accountDisk(name, await registry.require(name)));
  return accounts;
}

/** Image folders, oldest first, last changed before the cutoff. */
async function oldImageFolders(config: Config, cutoff: number): Promise<{ folder: string; bytes: number }[]> {
  const root = path.join(config.dataDir, 'images');
  let entries: string[];
  try { entries = await readdir(root); } catch { return []; }
  const old: { folder: string; bytes: number; changed: number }[] = [];
  for (const entry of entries) {
    const folder = path.join(root, entry);
    const info = await stat(folder).catch(() => undefined);
    if (info?.isDirectory() && info.mtimeMs < cutoff) old.push({ folder, bytes: await folderSize(folder), changed: info.mtimeMs });
  }
  return old.sort((a, b) => a.changed - b.changed);
}

export interface CleanupPlan { account: string; cache: number; references: number; images: { folder: string; bytes: number }[]; skipped?: string }
export interface CleanupOptions { imagesOlderThanDays?: number; now?: number }

/** Queued and running jobs, read without JobStore's startup recovery, so cleanup never changes job records. */
async function activeJobs(registry: AccountRegistry, account: string, dataDir: string) {
  const jobs = await registry.inspectDatabase(account, db => (db.prepare("SELECT body FROM jobs WHERE status IN ('queued', 'running')").all() as { body: string }[])
    .map(row => JSON.parse(row.body) as Job)) ?? [];
  return { dataDir, byStatus: (status: JobStatus) => jobs.filter(job => job.status === status) };
}

/** What cleanup would remove from one account. Reading needs no lock. */
async function planAccount(registry: AccountRegistry, account: string, config: Config, options: CleanupOptions): Promise<CleanupPlan> {
  const disk = await accountDisk(account, config);
  const images = options.imagesOlderThanDays === undefined ? []
    : await oldImageFolders(config, (options.now ?? Date.now()) - options.imagesOlderThanDays * 86_400_000);
  const unused = await pruneReferences(await activeJobs(registry, account, config.dataDir), 0, options.now, true);
  return { account, cache: disk.cache, references: unused.bytes, images };
}

export async function planCleanup(registry: AccountRegistry, options: CleanupOptions = {}): Promise<CleanupPlan[]> {
  const plans: CleanupPlan[] = [];
  for (const name of await registry.names()) plans.push(await planAccount(registry, name, await registry.require(name), options));
  return plans;
}

/**
 * Remove Chrome caches, unused reference copies and (only when asked) old images.
 * Each account is cleaned only while this command holds its lock; a running MCP server is asked to
 * free idle accounts first, and accounts that are busy or have Chrome open are skipped untouched.
 */
export async function runCleanup(registry: AccountRegistry, options: CleanupOptions = {}): Promise<CleanupPlan[]> {
  const results: CleanupPlan[] = [];
  for (const name of await registry.names()) {
    const config = await registry.require(name);
    const skip = (skipped: string) => results.push({ account: name, cache: 0, references: 0, images: [], skipped });
    if (await lockfile.check(config.dataDir, { stale: 30_000 }).catch(() => false)) {
      // The original 'default' account shares the server's own lock and cannot be released.
      const released = name === 'default' ? 'unsupported' : await requestAccountRelease(registry.baseConfig, name);
      if (released !== 'released') { skip(released === 'busy' ? 'the MCP server is generating images with it' : 'it is in use; close Claude Code and Codex, then run cleanup again'); continue; }
    }
    let release: () => Promise<void>;
    try { release = await acquireRuntime(config); } catch { skip('it is in use by another command'); continue; }
    try {
      if (await runningChrome(config)) { skip('its Chrome window is open'); continue; }
      const plan = await planAccount(registry, name, config, options);
      for (const folder of profileFolders) for (const cached of cacheFolders) await rm(path.join(config.dataDir, folder, cached), { recursive: true, force: true });
      // With the lock held, no request can be mid-admission, so the grace period is not needed.
      const pruned = await pruneReferences(await activeJobs(registry, name, config.dataDir), 0, options.now);
      for (const image of plan.images) await rm(image.folder, { recursive: true, force: true });
      results.push({ ...plan, references: pruned.bytes });
    } finally { await release(); }
  }
  return results;
}

