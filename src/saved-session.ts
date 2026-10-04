import path from 'node:path';
import { readFile } from 'node:fs/promises';
import type { Config } from './config.js';
import { hasSessionCookies, parseCookieInput } from './cookies.js';

export interface SavedSessionStatus {
  status: 'ready' | 'login_required' | 'unavailable' | 'usage_limit' | 'busy';
  message?: string;
  retryAfter?: string;
  /** Internal selection detail; the MCP response omits it. */
  reason?: 'missing' | 'expired';
}

/** Local expiry is an estimate of readiness, not a check of remote revocation. */
export async function inspectSavedSession(config: Config): Promise<SavedSessionStatus> {
  const missing = { status: 'login_required' as const, reason: 'missing' as const, message: 'No saved session. Run setup for this account.' };
  const expiredSession = { status: 'login_required' as const, reason: 'expired' as const, message: 'Saved session has expired. Run setup for this account.' };
  try {
    const input: unknown = JSON.parse(await readFile(config.cookiesFile ?? path.join(config.dataDir, 'session-cookies.json'), 'utf8'));
    const items = Array.isArray(input) ? input
      : config.cookiesFile && input && typeof input === 'object' && 'cookies' in input ? input.cookies : undefined;
    if (!Array.isArray(items)) throw new Error();
    // If any numbered part expires, the remaining parts cannot authenticate.
    const expired = new Set<string>();
    const family = (cookie: Record<string, unknown>) => `${cookie.domain ?? cookie.url}|${cookie.path ?? '/'}|${String(cookie.name).replace(/\.\d+$/, '')}`;
    const expires = (cookie: Record<string, unknown>) => cookie.session === true ? -1 : Number(cookie.expires ?? cookie.expirationDate ?? -1);
    const sessionName = /^(?:__Secure-)?(?:next-auth|authjs)\.session-token(?:\.\d+)?$/;
    for (const cookie of items) {
      if (!cookie || typeof cookie !== 'object') throw new Error();
      if (!Number.isFinite(expires(cookie)) || expires(cookie) < -1) throw new Error();
      if (sessionName.test(cookie.name) && expires(cookie) !== -1 && expires(cookie) <= Date.now() / 1000) expired.add(family(cookie));
    }
    const current = items.filter(cookie => !expired.has(family(cookie)) && (expires(cookie) === -1 || expires(cookie) > Date.now() / 1000));
    if (!current.length) return expired.size ? expiredSession : missing;
    const cookies = parseCookieInput(JSON.stringify(current));
    return hasSessionCookies(cookies) ? { status: 'ready' } : expired.size ? expiredSession : missing;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return missing;
    return { status: 'unavailable', message: 'Saved session could not be read. Run setup for this account.' };
  }
}
