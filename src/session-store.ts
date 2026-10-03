import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { isAllowedCookieDomain, normalizeCookies, type BrowserCookie } from './cookies.js';

export async function readSavedCookies(dataDir: string): Promise<BrowserCookie[]> {
  let input: unknown;
  try { input = JSON.parse(await readFile(path.join(dataDir, 'session-cookies.json'), 'utf8')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new Error('Saved cookies could not be read. Restore them with import-cookies --file or remove session-cookies.json and run setup.');
  }
  if (!Array.isArray(input)) throw new Error('Saved cookie store has an invalid format. Restore it with import-cookies.');
  const current = input.filter(cookie => cookie && (cookie.expires === undefined || cookie.expires === -1 || cookie.expires > Date.now() / 1000));
  return current.length ? normalizeCookies(current) : [];
}

export async function saveCookies(dataDir: string, cookies: BrowserCookie[]): Promise<void> {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const temporary = path.join(dataDir, `.cookies-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(cookies.filter(cookie => cookie.domain && isAllowedCookieDomain(cookie.domain))), { mode: 0o600, flag: 'wx' });
    await rename(temporary, path.join(dataDir, 'session-cookies.json'));
  } finally { await rm(temporary, { force: true }); }
}
