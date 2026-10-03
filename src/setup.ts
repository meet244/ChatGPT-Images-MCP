import { BrowserError, type ChatGPTBrowser, type SessionStatus } from './browser.js';
import { parseCookieInput, type BrowserCookie } from './cookies.js';
import { question, readCookieInput } from './terminal.js';

export interface SetupBrowser {
  hasSavedSession(): Promise<boolean>;
  sessionStatus(navigate?: boolean): Promise<SessionStatus>;
  importCookieValues: ChatGPTBrowser['importCookieValues'];
  setHeadless(headless: boolean): Promise<void>;
  open: ChatGPTBrowser['open'];
  prepareManualCookieSession?: ChatGPTBrowser['prepareManualCookieSession'];
}
export interface SetupTerminal {
  question(prompt: string): Promise<string>;
  readCookies(): Promise<string>;
  print(message: string): void;
}
const terminal: SetupTerminal = { question, readCookies: readCookieInput, print: message => { process.stderr.write(`${message}\n`); } };

export async function importCookiesWithVerification(browser: SetupBrowser, cookies: BrowserCookie[], io: SetupTerminal = terminal): Promise<{ count: number; state: SessionStatus }> {
  const manual = await browser.prepareManualCookieSession?.(cookies);
  let count: number;
  if (manual) {
    count = manual.count;
    io.print(`Saved ${count} cookies. Ordinary Chrome is open for this account.`);
    io.print('Let ChatGPT load and complete any verification. When ChatGPT works, fully quit this account’s dedicated Chrome instance. Controlled Chrome will reconnect automatically after it exits. On macOS, closing a window may leave Chrome running.');
    await manual.waitForExit();
    io.print('Manual Chrome closed. Reconnecting controlled Chrome using the same account profile…');
  } else {
    count = await browser.importCookieValues(cookies);
    io.print(`Saved ${count} cookies locally. Checking the session…`);
  }
  return { count, state: await browser.sessionStatus() };
}

export async function checkSavedSession(browser: SetupBrowser): Promise<SessionStatus> {
  if (!await browser.hasSavedSession()) return { status: 'login_required', message: 'No saved session token was found. Run npm run setup and choose Log in or Paste cookies.' };
  return browser.sessionStatus();
}

export async function setupSession(browser: SetupBrowser, headless: boolean, io: SetupTerminal = terminal, initial?: SessionStatus): Promise<SessionStatus> {
  io.print('Checking saved ChatGPT session…');
  let state: SessionStatus;
  try { state = initial ?? await checkSavedSession(browser); }
  catch (error) {
    state = { status: 'unavailable', message: error instanceof BrowserError
      ? error.message
      : 'The saved session could not be checked. Run npm run status for diagnostics, or npm run paste-cookies to explicitly replace saved cookies.' };
  }
  if (state.status === 'ready') { io.print('ChatGPT session is ready.'); return state; }
  io.print(state.message);
  // A failed connection or a verification challenge is not evidence of missing credentials.
  if (state.status === 'unavailable' || state.status === 'challenge') {
    io.print('Existing cookies retained. Resolve the browser/session check, then use session_status to check again.');
    return state;
  }
  let choice: string;
  do {
    choice = (await io.question('\n1) Log in / open browser\n2) Paste cookies\nChoose 1 or 2: ')).trim();
  } while (!['1', '2'].includes(choice));
  if (choice === '1') {
    await browser.setHeadless(false);
    await browser.open();
    await io.question('Sign in or complete verification in the browser, then press Enter here.\n');
    state = await browser.sessionStatus(false);
    await browser.setHeadless(headless);
    if (state.status === 'ready' && headless) state = await browser.sessionStatus();
  } else {
    let cookies;
    while (!cookies) {
      try { cookies = parseCookieInput(await io.readCookies()); }
      catch (error) {
        if (error instanceof Error && /cancelled|ended before|interactive terminal|Unable to read/.test(error.message)) throw error;
        io.print(error instanceof Error ? error.message : 'Cookie input is invalid. Try again.');
      }
    }
    ({ state } = await importCookiesWithVerification(browser, cookies, io));
  }
  io.print(state.status === 'ready' ? 'ChatGPT session is ready.' : `Cookies/session saved, but readiness is not confirmed: ${state.message}`);
  return state;
}
