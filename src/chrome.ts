import path from 'node:path';
import os from 'node:os';
import { access, mkdir, readFile, rm } from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, type Browser, type BrowserContext } from 'playwright';
import type { Config } from './config.js';
import { saveCookies } from './session-store.js';
import { normalizeCookies, hasSessionCookies, type BrowserCookie } from './cookies.js';
export class ChromeError extends Error {}

export const chromeProfile = (config: Config): string => path.join(config.dataDir, 'chrome-profile');

export async function findChrome(config: Config): Promise<string> {
  const candidates = config.chromeExecutable ? [config.chromeExecutable] : process.platform === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', path.join(os.homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome')]
    : process.platform === 'win32'
      ? [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter((root): root is string => !!root).map(root => path.join(root, 'Google/Chrome/Application/chrome.exe'))
      : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome'];
  for (const file of candidates) {
    try { await access(file); return file; } catch { /* Try the next installation. */ }
  }
  throw new ChromeError('Google Chrome was not found. Install Chrome or set CHATGPT_CHROME_EXECUTABLE to its executable path.');
}

export function parseActivePort(text: string): { endpoint: string; browserPath: string } | undefined {
  const [portText, browserPath] = text.trim().split(/\r?\n/);
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !browserPath || !/^\/devtools\/browser\/[a-zA-Z0-9-]+$/.test(browserPath)) return;
  return { endpoint: `http://127.0.0.1:${port}`, browserPath };
}

/** Validate the browser ID as well as the port, so a stale file cannot attach to another process. */
export async function runningChrome(config: Config): Promise<string | undefined> {
  try {
    const active = parseActivePort(await readFile(path.join(chromeProfile(config), 'DevToolsActivePort'), 'utf8'));
    if (!active) return;
    const response = await fetch(`${active.endpoint}/json/version`, { signal: AbortSignal.timeout(1000), redirect: 'error' });
    if (!response.ok) return;
    const version = await response.json() as { webSocketDebuggerUrl?: string };
    if (!version.webSocketDebuggerUrl) return;
    const websocket = new URL(version.webSocketDebuggerUrl);
    if (websocket.protocol !== 'ws:' || !['127.0.0.1', 'localhost'].includes(websocket.hostname) || websocket.pathname !== active.browserPath || websocket.port !== new URL(active.endpoint).port) return;
    return `ws://127.0.0.1:${websocket.port}${active.browserPath}`;
  } catch { return undefined; }
}

export async function ensureChrome(config: Config): Promise<string> {
  if (config.headless) throw new ChromeError('CDP mode uses visible Chrome. Set CHATGPT_HEADLESS=false, or use CHATGPT_BROWSER_MODE=playwright for headless operation.');
  const profile = chromeProfile(config);
  await mkdir(profile, { recursive: true, mode: 0o700 });
  const existing = await runningChrome(config);
  if (existing) return existing;
  const executable = await findChrome(config);
  await rm(path.join(profile, 'DevToolsActivePort'), { force: true });
  const child = spawn(executable, [
    `--user-data-dir=${profile}`,
    '--remote-debugging-port=0',
    '--remote-debugging-address=127.0.0.1',
    '--no-first-run',
    '--no-default-browser-check',
    // Restore session cookies without opening restored windows or an extra blank tab.
    '--restore-last-session',
    '--no-startup-window',
  ], { detached: true, stdio: 'ignore' });
  let failed = false;
  let exited = false;
  child.once('error', () => { failed = true; });
  child.once('exit', () => { exited = true; });
  child.unref();
  const deadline = Date.now() + 20_000;
  do {
    if (failed) throw new ChromeError('Could not launch Google Chrome. Check CHATGPT_CHROME_EXECUTABLE.');
    const endpoint = await runningChrome(config);
    if (endpoint) return endpoint;
    if (exited) break;
    await delay(200);
  } while (Date.now() < deadline);
  throw new ChromeError('Dedicated Chrome did not expose its debugging connection. If it was opened with browser:manual, quit that dedicated Chrome instance, then try again. Closing a window may leave Chrome running on macOS. Your everyday Chrome can stay open.');
}

export async function connectChrome(config: Config): Promise<Browser> {
  const endpoint = await ensureChrome(config);
  try { return await chromium.connectOverCDP(endpoint, { noDefaults: true, timeout: 15_000 }); }
  catch { throw new ChromeError('Could not connect to dedicated Chrome. Run browser-close, then browser to reopen it.'); }
}

export interface ManualChromeHandle { pid: number; waitForExit(): Promise<void>; close(): Promise<void>; }

/** Use the same ordinary-to-controlled handoff for setup and later browser starts. */
export async function finishManualChrome(
  manual: { waitForExit(): Promise<void>; close?(): Promise<void> },
  autoCloseMs: number,
  onClosing?: () => void,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const exited = manual.waitForExit();
    if (autoCloseMs > 0 && manual.close) {
      await Promise.race([exited, new Promise<void>((resolve, reject) => {
        timer = setTimeout(() => {
          onClosing?.();
          manual.close!().then(resolve, reject);
        }, autoCloseMs);
      })]);
    }
    // Do not attach controlled Chrome until the ordinary process has fully exited.
    await exited;
  } finally { clearTimeout(timer); }
}

/** Ordinary browser; deliberately exposes no automation endpoint. */
export async function openManualChrome(config: Config, options: { urls?: string[] } = {}): Promise<ManualChromeHandle> {
  const executable = await findChrome(config);
  const profile = chromeProfile(config);
  await mkdir(profile, { recursive: true, mode: 0o700 });
  const stopped = await stopChrome(config);
  // Allow Chrome to finish releasing its profile after its debugging server closes.
  if (stopped) await delay(500);
  await rm(path.join(profile, 'DevToolsActivePort'), { force: true });
  const child = spawn(executable, [
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--restore-last-session',
    ...(options.urls ?? ['https://chatgpt.com/', 'https://debug.challenges.cloudflare.com/']),
  ], { detached: true, stdio: 'ignore' });
  const exited = new Promise<number | null>(resolve => child.once('exit', code => resolve(code)));
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', () => reject(new ChromeError('Could not launch ordinary Chrome for manual troubleshooting.')));
  });
  child.unref();
  return { pid: child.pid!, async close() {
    if (child.exitCode !== null || child.signalCode !== null) return;
    // Ask this profile's running Chrome to exit through its normal browser shutdown,
    // so pending cookie writes are flushed before the controlled handoff.
    if (process.platform === 'darwin') {
      try {
        const { stdout } = await promisify(execFile)('/usr/bin/osascript', ['-l', 'JavaScript', '-e',
          `ObjC.import('AppKit'); $.NSRunningApplication.runningApplicationWithProcessIdentifier(${child.pid}).terminate;`], { timeout: 5000 });
        if (stdout.trim() !== 'true') throw new Error('Termination was not accepted');
      } catch { throw new ChromeError('Could not close verification Chrome. Fully quit this dedicated Chrome instance manually.'); }
    } else if (!child.kill('SIGTERM')) throw new ChromeError('Could not close verification Chrome. Fully quit this dedicated Chrome instance manually.');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([exited, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ChromeError('Verification Chrome did not exit. Fully quit this dedicated Chrome instance, then retry setup. Cookies are retained.')), 15_000);
      })]);
    } finally { clearTimeout(timer); }
  }, async waitForExit() {
    // Keep terminal setup alive until ordinary Chrome fully exits.
    child.ref();
    try {
      const code = await exited;
      if (code !== null && code !== 0) throw new ChromeError('Manual Chrome exited unexpectedly. Cookies are retained; run browser:manual for this account to finish verification.');
    } finally { child.unref(); }
  } };
}

/** Load cookies locally before the first website visit in ordinary Chrome. */
export async function seedManualChromeCookies(config: Config, input: BrowserCookie[]): Promise<number> {
  if (config.browserMode !== 'cdp') throw new ChromeError('Manual cookie setup requires CHATGPT_BROWSER_MODE=cdp.');
  const cookies = normalizeCookies(input);
  await stopChrome(config);
  const profile = chromeProfile(config);
  await mkdir(profile, { recursive: true, mode: 0o700 });
  // Preserve a private recovery copy even if Chrome cannot open its profile.
  await saveCookies(config.dataDir, cookies);
  let context: BrowserContext | undefined;
  try {
    context = await chromium.launchPersistentContext(profile, {
      executablePath: await findChrome(config), headless: true,
      // Use installed Chrome's ordinary cookie encryption, including the macOS keychain.
      ignoreDefaultArgs: ['--password-store=basic', '--use-mock-keychain'],
      // Playwright opens about:blank; there is no website navigation during seeding.
      timeout: 15_000,
    });
    if (hasSessionCookies(cookies)) await context.clearCookies({ name: /^(?:__Secure-)?(?:next-auth|authjs)\.session-token(?:\.\d+)?$/ });
    await context.addCookies(cookies);
    await saveCookies(config.dataDir, await context.cookies());
  } catch {
    throw new ChromeError('Could not load cookies into the account’s Chrome profile. Fully quit that account’s manual Chrome instance, then run setup or paste-cookies again. Saved cookies are retained.');
  } finally {
    try { await context?.close(); }
    catch { throw new ChromeError('Cookie preparation could not close Chrome. Fully quit this account’s dedicated Chrome instance before trying again.'); }
  }
  return cookies.length;
}

/** Explicitly closes only the dedicated Chrome identified by this app's private profile. */
export async function stopChrome(config: Config, options: { saveCookies?: boolean } = {}): Promise<boolean> {
  const endpoint = await runningChrome(config);
  if (!endpoint) return false;
  const browser = await chromium.connectOverCDP(endpoint, { noDefaults: true, timeout: 10_000 });
  try {
    if (options.saveCookies !== false) {
      const context = browser.contexts()[0];
      if (context) await saveCookies(config.dataDir, await context.cookies());
    }
    const session = await browser.newBrowserCDPSession();
    await session.send('Browser.close');
  } finally { await browser.close().catch(() => {}); }
  const deadline = Date.now() + 5000;
  while (await runningChrome(config)) {
    if (Date.now() > deadline) throw new Error('Dedicated Chrome is still shutting down. Close its window manually before restarting.');
    await delay(100);
  }
  return true;
}
