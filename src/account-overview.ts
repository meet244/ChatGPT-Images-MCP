import lockfile from 'proper-lockfile';
import type { AccountRegistry } from './accounts.js';
import { inspectSavedSession, savedSessionExpiry } from './saved-session.js';

export interface AccountOverview {
  account: string;
  /** Display name, falling back to the detected email and then the profile ID. */
  name: string;
  email?: string;
  plan?: string;
  session: 'ready' | 'missing' | 'expired' | 'unreadable';
  /** Earliest session-token expiry, in milliseconds. */
  expiresAt?: number;
  cooldownUntil?: string;
  images: number;
  lastUsed?: string;
  /** Another process (usually the MCP server) holds this profile. */
  inUse: boolean;
}

/** Read-only summary for the terminal menu. Never opens a browser or takes a lock. */
export async function accountOverview(registry: AccountRegistry, now = Date.now()): Promise<{ mode: 'priority' | 'manual'; manual?: string; accounts: AccountOverview[] }> {
  const listing = await registry.list();
  // Failover saves images under the profile that generated them, which can differ from the job's owner.
  const usage = new Map<string, { images: number; lastUsed?: string }>();
  for (const { account: owner } of listing.accounts) {
    const rows = await registry.inspectDatabase(owner, db => db.prepare(`SELECT status, json_extract(body, '$.executionAccount') AS executed,
      json_extract(body, '$.updatedAt') AS updated, COALESCE(json_array_length(body, '$.images'), 0) AS images
      FROM jobs WHERE status IN ('completed', 'failed')`).all() as { status: string; executed: string | null; updated: string | null; images: number }[]).catch(() => undefined);
    for (const row of rows ?? []) {
      const account = row.executed ?? owner;
      const entry = usage.get(account) ?? { images: 0 };
      if (row.status === 'completed') entry.images += row.images;
      if (row.updated && (!entry.lastUsed || row.updated > entry.lastUsed)) entry.lastUsed = row.updated;
      usage.set(account, entry);
    }
  }
  const accounts = await Promise.all(listing.accounts.map(async item => {
    const config = await registry.require(item.account);
    const [profile, saved, expiresAt, inUse, cooldown] = await Promise.all([
      registry.profile(item.account),
      inspectSavedSession(config),
      savedSessionExpiry(config),
      lockfile.check(config.dataDir, { stale: 30_000 }).catch(() => false),
      registry.inspectDatabase(item.account, db => {
        const row = db.prepare("SELECT body FROM settings WHERE key = 'image_cooldown'").get() as { body: string } | undefined;
        const retryAfter = row ? (JSON.parse(row.body) as { retryAfter?: unknown }).retryAfter : undefined;
        return typeof retryAfter === 'string' && Date.parse(retryAfter) > now ? retryAfter : undefined;
      }).catch(() => undefined),
    ]);
    const session: AccountOverview['session'] = saved.status === 'ready' ? 'ready'
      : saved.reason === 'expired' ? 'expired' : saved.status === 'unavailable' ? 'unreadable' : 'missing';
    const label = item.display_name !== item.account ? item.display_name : undefined;
    return {
      account: item.account,
      name: label ?? profile.email ?? item.account,
      ...profile,
      session,
      ...(expiresAt !== undefined ? { expiresAt } : {}),
      ...(cooldown ? { cooldownUntil: cooldown } : {}),
      images: usage.get(item.account)?.images ?? 0,
      ...(usage.get(item.account)?.lastUsed ? { lastUsed: usage.get(item.account)!.lastUsed } : {}),
      inUse,
    } satisfies AccountOverview;
  }));
  return { mode: listing.selection_mode, ...(listing.manual_account ? { manual: listing.manual_account } : {}), accounts };
}

const minute = 60_000, hour = 60 * minute, day = 24 * hour;
export function relativeTime(target: number, now = Date.now()): string {
  const difference = target - now, distance = Math.abs(difference);
  const text = distance < minute ? 'moments' : distance < hour ? `${Math.round(distance / minute)} min`
    : distance < day ? `${Math.round(distance / hour)}h` : `${Math.round(distance / day)} days`;
  return text === 'moments' ? (difference <= 0 ? 'just now' : 'in a moment') : difference < 0 ? `${text} ago` : `in ${text}`;
}

/** One-line status, e.g. "ready · expires in 12 days · 42 images · used 2h ago". */
export function describeStatus(account: AccountOverview, now = Date.now()): { text: string; tone: 'good' | 'warn' | 'bad' } {
  const usage = [account.images ? `${account.images} image${account.images === 1 ? '' : 's'}` : '',
    account.lastUsed ? `used ${relativeTime(Math.min(Date.parse(account.lastUsed), now), now)}` : ''].filter(Boolean);
  if (account.session === 'missing') return { text: 'needs sign-in', tone: 'bad' };
  if (account.session === 'expired') return { text: 'session expired · sign in again', tone: 'bad' };
  if (account.session === 'unreadable') return { text: 'saved session unreadable · sign in again', tone: 'bad' };
  if (account.cooldownUntil) {
    const until = new Date(account.cooldownUntil).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' });
    return { text: [`image limit · available ${until}`, ...usage].join(' · '), tone: 'warn' };
  }
  const expiring = account.expiresAt !== undefined && account.expiresAt - now < 3 * day;
  const expiry = account.expiresAt !== undefined ? `expires ${relativeTime(account.expiresAt, now)}` : '';
  return { text: ['ready', expiry, ...usage].filter(Boolean).join(' · '), tone: expiring ? 'warn' : 'good' };
}
