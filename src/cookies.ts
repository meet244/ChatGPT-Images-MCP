import { readFile } from 'node:fs/promises';
import type { BrowserContext } from 'playwright';

export type BrowserCookie = Parameters<BrowserContext['addCookies']>[0][number];
const sessionName = /^(?:__Secure-)?(?:next-auth|authjs)\.session-token(?:\.(\d+))?$/;

export function hasSessionCookies(cookies: BrowserCookie[]): boolean {
  return cookies.some(cookie => sessionName.test(cookie.name) && cookie.value.length > 0);
}

/** Parse local terminal input. Errors deliberately contain no pasted values. */
export function parseCookieInput(text: string): BrowserCookie[] {
  const input = text.trim();
  if (!input || input.length > 262_144) throw new Error('Paste cookies first (maximum 256 KiB).');
  if (input.startsWith('[') || input.startsWith('{')) {
    let parsed: unknown;
    try { parsed = JSON.parse(input); } catch { throw new Error('Cookie JSON is invalid. Paste a complete JSON export or comma-separated named session cookies.'); }
    const cookies = normalizeCookies(parsed);
    validateSessionParts(cookies);
    return cookies;
  }
  if (input.includes('\t')) {
    const cookies = parseChromeCookieTable(input);
    validateSessionParts(cookies);
    return cookies;
  }
  const cookies: BrowserCookie[] = [];
  const entries = input.replace(/^Cookie:\s*/i, '').split(/[\r\n;,]+/).map(line => line.trim()).filter(Boolean);
  for (const entry of entries) {
    const match = /^([^\s=]+)\s*=\s*(\S+)$/.exec(entry);
    if (!match || !sessionName.test(match[1]!)) throw new Error('Use comma-separated session-token-name=value cookies, or paste a single-line JSON cookie export.');
    const value = match[2]!.replace(/^"(.*)"$/, '$1');
    if (!/^[A-Za-z0-9_.-]+$/.test(value)) throw new Error('A session token contains unexpected characters. Copy the complete cookie value again.');
    cookies.push({ name: match[1]!, value, domain: '.chatgpt.com', path: '/', secure: true, httpOnly: true, sameSite: 'Lax', expires: -1 });
  }
  validateSessionParts(cookies);
  return cookies;
}

/** Chrome DevTools copied rows: Name, Value, Domain, Path, Expires, Size, HttpOnly, Secure, SameSite. */
function parseChromeCookieTable(input: string): BrowserCookie[] {
  const rows: Record<string, unknown>[] = [];
  for (const line of input.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const fields = line.split('\t');
    if (fields[0]?.trim().toLowerCase() === 'name' && fields[2]?.trim().toLowerCase() === 'domain') continue;
    if (fields.length < 5) throw new Error('Incomplete Chrome cookie table. Copy the complete rows, including domain, path, and expiry.');
    const [rawName, rawValue, rawDomain, rawPath, rawExpiry] = fields;
    const name = rawName!.trim();
    const domain = rawDomain!.trim();
    if (!isAllowedCookieDomain(domain)) continue;
    const expiry = rawExpiry!.trim();
    const expires = /^session$/i.test(expiry) ? -1 : Date.parse(expiry) / 1000;
    if (!Number.isFinite(expires)) throw new Error('Cookie expiry could not be read. Use a complete Chrome table or a JSON export.');
    const checked = (value?: string): boolean => /^(?:✓|✔|true)$/i.test(value?.trim() ?? '');
    // Preserve cookie values verbatim, including quotes in conversation cookies.
    rows.push({ name, value: rawValue!, domain, path: rawPath!.trim() || '/', expires,
      httpOnly: checked(fields[6]), secure: checked(fields[7]), sameSite: fields[8]?.trim() || 'Lax' });
  }
  return normalizeCookies(rows);
}

function validateSessionParts(cookies: BrowserCookie[]): void {
  const families = new Map<string, { full: boolean; parts: number[] }>();
  const names = new Set<string>();
  for (const cookie of cookies.filter(cookie => sessionName.test(cookie.name))) {
    if (names.has(cookie.name)) throw new Error('Duplicate session cookie. Paste each token part once.');
    names.add(cookie.name);
    const match = sessionName.exec(cookie.name)!;
    const base = cookie.name.replace(/\.\d+$/, '');
    const family = families.get(base) ?? { full: false, parts: [] };
    if (match[1] === undefined) family.full = true;
    else family.parts.push(Number(match[1]));
    families.set(base, family);
  }
  for (const family of families.values()) {
    family.parts.sort((a, b) => a - b);
    if (family.full && family.parts.length) throw new Error('Paste either the whole session token or its numbered parts, not both.');
    if (family.parts.some((part, index) => part !== index)) throw new Error('Session token parts must start at .0 with no missing numbers. Include every part from your browser.');
  }
}
export const isAllowedCookieDomain = (domain: string): boolean => {
  const host = domain.replace(/^\./, '').toLowerCase();
  return ['chatgpt.com', 'openai.com'].some(root => host === root || host.endsWith(`.${root}`));
};

/** Accept Playwright cookies/storage state and common browser extension JSON exports. */
export function normalizeCookies(input: unknown): BrowserCookie[] {
  const items = Array.isArray(input) ? input : input && typeof input === 'object' && 'cookies' in input ? (input as { cookies: unknown }).cookies : undefined;
  if (!Array.isArray(items)) throw new Error('Cookie file must be a JSON array or an object containing a cookies array.');
  const result: BrowserCookie[] = [];
  for (const [index, item] of items.entries()) {
    if (!item || typeof item !== 'object') throw new Error(`Invalid cookie at index ${index}.`);
    const cookie = item as Record<string, unknown>;
    let domain = typeof cookie.domain === 'string' ? cookie.domain : undefined;
    if (!domain && typeof cookie.url === 'string') {
      try { domain = new URL(cookie.url).hostname; } catch { throw new Error(`Invalid cookie URL at index ${index}.`); }
    }
    if (!domain || !isAllowedCookieDomain(domain)) continue;
    if (typeof cookie.name !== 'string' || !cookie.name || typeof cookie.value !== 'string') throw new Error(`Cookie at index ${index} requires a name and value.`);
    const rawExpiry = cookie.expires ?? cookie.expirationDate;
    const expires = cookie.session === true || rawExpiry === undefined || rawExpiry === -1 ? -1 : Number(rawExpiry);
    if (!Number.isFinite(expires) || expires < -1) throw new Error(`Invalid cookie expiry at index ${index}.`);
    if (expires !== -1 && expires <= Date.now() / 1000) continue;
    const sameSite = String(cookie.sameSite ?? 'Lax').toLowerCase();
    if (!['strict', 'lax', 'none', 'no_restriction', 'unspecified'].includes(sameSite)) throw new Error(`Invalid cookie sameSite at index ${index}.`);
    const normalizedSite = sameSite === 'strict' ? 'Strict' : ['none', 'no_restriction'].includes(sameSite) ? 'None' : 'Lax';
    result.push({ name: cookie.name, value: cookie.value, domain, path: typeof cookie.path === 'string' ? cookie.path : '/', expires,
      httpOnly: cookie.httpOnly === true, secure: normalizedSite === 'None' || cookie.secure === true, sameSite: normalizedSite });
  }
  if (!result.length) throw new Error('No unexpired ChatGPT/OpenAI cookies were found. Export cookies while signed in to chatgpt.com.');
  return result;
}

export async function readCookies(file: string): Promise<BrowserCookie[]> {
  let content: string;
  try { content = await readFile(file, 'utf8'); } catch { throw new Error('Cannot read cookie file. Check CHATGPT_COOKIES_FILE or the --file argument.'); }
  let parsed: unknown;
  try { parsed = JSON.parse(content); } catch { throw new Error('Cookie file is not valid JSON.'); }
  return normalizeCookies(parsed);
}
