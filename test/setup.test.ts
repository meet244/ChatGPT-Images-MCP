import './support/headless.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { PassThrough, Writable } from 'node:stream';
import { createServer } from 'node:http';
import type { ReadStream } from 'node:tty';
import os from 'node:os';
import path from 'node:path';
import { parseCookieInput, hasSessionCookies, type BrowserCookie } from '../src/cookies.js';
import { readSavedCookies, saveCookies } from '../src/session-store.js';
import { readCookieInput } from '../src/terminal.js';
import { setupSession, importCookiesWithVerification, type SetupBrowser, type SetupTerminal } from '../src/setup.js';
import { BrowserError, ChatGPTBrowser } from '../src/browser.js';
import { loadConfig } from '../src/config.js';

const paste = '__Secure-next-auth.session-token.0 = fake-part-0\n\n__Secure-next-auth.session-token.1 = fake-part-1';
const tableRow = (name: string, value: string, domain = '.chatgpt.com', expiry = 'Session', site = 'Lax') =>
  [name, value, domain, '/', expiry, '100', '✓', '✓', site, '', '', 'Medium'].join('\t');
const table = [
  'Name\tValue\tDomain\tPath\tExpires / Max-Age\tSize\tHttpOnly\tSecure\tSameSite',
  tableRow('__Secure-next-auth.session-token.0', 'fake-part-0'),
  tableRow('__Secure-next-auth.session-token.1', 'fake-part-1'),
  tableRow('oai-did', 'fixture-device', 'chatgpt.com', '2099-01-01T00:00:00.000Z', 'None'),
  tableRow('conv_key_fixture', '"preserve-the-quotes"'),
  tableRow('unrelated', 'exclude-me', 'example.org'),
  tableRow('expired', 'exclude-me', '.chatgpt.com', '2000-01-01T00:00:00.000Z'),
].join('\n');

test('complete Chrome tables preserve values and attributes, excluding unrelated and expired rows', () => {
  const cookies = parseCookieInput(table);
  assert.equal(cookies.length, 4);
  assert.equal(hasSessionCookies(cookies), true);
  assert.equal(cookies[0]?.expires, -1);
  assert.equal(cookies[0]?.httpOnly, true);
  assert.equal(cookies[2]?.domain, 'chatgpt.com');
  assert.equal(cookies[2]?.sameSite, 'None');
  assert.equal(cookies[2]?.expires, Date.parse('2099-01-01T00:00:00.000Z') / 1000);
  assert.equal(cookies[3]?.value, '"preserve-the-quotes"');
  // Indented JSON containing tabs must still take the JSON input path.
  assert.deepEqual(parseCookieInput(JSON.stringify(cookies, null, '\t')), cookies);
});

test('malformed Chrome tables fail without exposing copied values', () => {
  for (const text of [
    'cookie\tprivate-value\t.chatgpt.com',
    tableRow('cookie', 'private-value', '.chatgpt.com', 'invalid-date'),
    tableRow('__Secure-next-auth.session-token.1', 'private-value'),
  ]) assert.throws(() => parseCookieInput(text), error => error instanceof Error && !error.message.includes('private-value'));
});

test('terminal cookies accept named token parts without stripping or joining values', () => {
  const cookies = parseCookieInput(paste);
  assert.equal(cookies.length, 2);
  assert.equal(cookies[0]?.value, 'fake-part-0');
  assert.equal(cookies[1]?.value, 'fake-part-1');
  assert.equal(cookies[0]?.expires, -1);
  assert.equal(cookies[0]?.httpOnly, true);
  assert.equal(cookies[0]?.secure, true);
  assert.equal(cookies[0]?.domain, '.chatgpt.com');
  assert.equal(hasSessionCookies(cookies), true);
  assert.equal(parseCookieInput('Cookie: __Secure-next-auth.session-token.0=fake0; __Secure-next-auth.session-token.1=fake1').length, 2);
  assert.deepEqual(parseCookieInput(paste.replace(/\n+/g, ', ')), cookies);
  assert.equal(parseCookieInput(JSON.stringify(cookies)).length, 2);
});

test('incomplete or ambiguous pastes fail without echoing any secret', () => {
  const badInputs = [
    '__Secure-next-auth.session-token.1=secret',
    '__Secure-next-auth.session-token.0=secret\n__Secure-next-auth.session-token.2=secret',
    '__Secure-next-auth.session-token=secret\n__Secure-next-auth.session-token.0=secret',
    '__Secure-next-auth.session-token.0=secret\n__Secure-next-auth.session-token.0=secret',
    'random-cookie=secret', '{"secret":', 'secret', '',
  ];
  for (const value of badInputs) assert.throws(() => parseCookieInput(value), error => error instanceof Error && !error.message.includes('secret'));
});

test('session cookies without expiry are stored privately and survive reload', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'images-auth-'));
  try {
    assert.deepEqual(await readSavedCookies(directory), []);
    const cookies = parseCookieInput(paste);
    await saveCookies(directory, cookies);
    assert.deepEqual(await readSavedCookies(directory), cookies);
    assert.equal((await stat(path.join(directory, 'session-cookies.json'))).mode & 0o777, 0o600);
    await saveCookies(directory, [{ ...cookies[0]!, expires: 1 }]);
    assert.deepEqual(await readSavedCookies(directory), []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

function visibleTerminal() {
  const input = new PassThrough() as PassThrough & { isTTY: boolean; isRaw: boolean; setRawMode(value: boolean): void };
  input.isTTY = true;
  input.isRaw = false;
  input.setRawMode = value => { input.isRaw = value; };
  let output = '';
  return { input, output: new Writable({ write(chunk, _encoding, next) { output += chunk.toString(); next(); } }), transcript: () => output };
}

test('terminal asks for .0 then .1, displays values, and submits only after both Enters', async () => {
  const tty = visibleTerminal();
  const pending = readCookieInput(tty.input as unknown as ReadStream, tty.output);
  let submitted = false;
  void pending.then(() => { submitted = true; });
  assert.match(tty.transcript(), /__Secure-next-auth\.session-token\.0: /);
  assert.doesNotMatch(tty.transcript(), /__Secure-next-auth\.session-token\.1: /);
  tty.input.write('fake-part-0\r');
  await Promise.resolve();
  assert.equal(submitted, false);
  assert.match(tty.transcript(), /fake-part-0/);
  assert.match(tty.transcript(), /__Secure-next-auth\.session-token\.1: /);
  tty.input.write('fake-part-1\r');
  assert.deepEqual(parseCookieInput(await pending), parseCookieInput(paste));
  assert.match(tty.transcript(), /fake-part-1/);
  assert.equal(tty.input.isRaw, false);
  assert.match(tty.transcript(), /Input is visible/);
});

test('Ctrl+C cancels visible entry and restores terminal mode', async () => {
  const tty = visibleTerminal();
  const pending = readCookieInput(tty.input as unknown as ReadStream, tty.output);
  tty.input.write('fixture-value\x03');
  await assert.rejects(pending, /cancelled/);
  assert.equal(tty.input.isRaw, false);
  assert.match(tty.transcript(), /fixture-value/);
});

test('empty or named input repeats the current cookie prompt without losing the first value', async () => {
  const tty = visibleTerminal();
  const pending = readCookieInput(tty.input as unknown as ReadStream, tty.output);
  tty.input.write('\n');
  assert.match(tty.transcript(), /cannot be empty/);
  tty.input.write('first-fixture\n');
  tty.input.write('__Secure-next-auth.session-token.1=second-fixture\n');
  assert.match(tty.transcript(), /include the cookie name/);
  tty.input.write(' second-fixture \n');
  assert.deepEqual(parseCookieInput(await pending).map(cookie => cookie.value), ['first-fixture', 'second-fixture']);
});

test('cancelling or ending before the second value never submits a partial session', async () => {
  for (const cancel of [true, false]) {
    const tty = visibleTerminal();
    const pending = readCookieInput(tty.input as unknown as ReadStream, tty.output);
    tty.input.write('first-fixture\n');
    if (cancel) tty.input.write('\x03');
    else tty.input.end();
    await assert.rejects(pending, cancel ? /cancelled/ : /ended before/);
    assert.equal(tty.input.isRaw, false);
  }
});

function setupFixture(saved: boolean, answers: string[]) {
  let imported: BrowserCookie[] = [];
  const messages: string[] = [];
  const headless: boolean[] = [];
  let opened = false;
  const browser: SetupBrowser = {
    hasSavedSession: async () => saved,
    sessionStatus: async () => ({ status: 'ready', message: 'Ready' }),
    importCookieValues: async cookies => { imported = cookies; return cookies.length; },
    setHeadless: async value => { headless.push(value); },
    open: async () => { opened = true; return {} as any; },
    closeAfterSetup: async () => {},
  };
  const io: SetupTerminal = {
    question: async prompt => { messages.push(prompt); return answers.shift() ?? ''; },
    readCookies: async () => paste,
    print: message => { messages.push(message); },
  };
  return { browser, io, messages, headless, imported: () => imported, opened: () => opened };
}

test('startup offers login and cookies, accepts cookie choice, and verifies the session', async () => {
  const fixture = setupFixture(false, ['2']);
  assert.equal((await setupSession(fixture.browser, true, fixture.io)).status, 'ready');
  assert.equal(fixture.imported().length, 2);
  assert.equal(fixture.opened(), false);
  assert.match(fixture.messages.join('\n'), /1\) Log in.*\n2\) Paste cookies/);
  assert.ok(!fixture.messages.join('\n').includes('fake-part'));
});

test('login choice opens a visible browser then restores headless mode', async () => {
  const fixture = setupFixture(false, ['1', '']);
  await setupSession(fixture.browser, true, fixture.io);
  assert.equal(fixture.opened(), true);
  assert.deepEqual(fixture.headless, [false, true]);
});

test('a saved working session skips the setup menu', async () => {
  const fixture = setupFixture(true, []);
  await setupSession(fixture.browser, true, fixture.io);
  assert.equal(fixture.imported().length, 0);
  assert.ok(!fixture.messages.join('\n').includes('Choose 1 or 2'));
});

test('saved cookies with a browser connection error show its cause without requesting credentials', async () => {
  const fixture = setupFixture(true, []);
  fixture.browser.sessionStatus = async () => { throw new BrowserError('Dedicated Chrome has no debugging connection. Quit its manual instance.'); };
  fixture.io.question = async () => { assert.fail('Connection failure must not request credentials'); };
  const state = await setupSession(fixture.browser, false, fixture.io);
  assert.equal(state.status, 'unavailable');
  assert.match(fixture.messages.join('\n'), /Dedicated Chrome has no debugging connection/);
  assert.equal(fixture.imported().length, 0);
});

test('browser verification preserves saved cookies and returns without the login/cookie menu', async () => {
  const fixture = setupFixture(true, []);
  fixture.browser.sessionStatus = async () => ({ status: 'challenge', message: 'Complete verification in the browser.' });
  fixture.io.question = async () => { assert.fail('Verification must not request replacement cookies'); };
  assert.equal((await setupSession(fixture.browser, false, fixture.io)).status, 'challenge');
  assert.equal(fixture.imported().length, 0);
  assert.match(fixture.messages.join('\n'), /Existing cookies retained/);
});

test('unknown session-check errors never expose private browser details or prompt for cookies', async () => {
  const fixture = setupFixture(true, []);
  fixture.browser.sessionStatus = async () => { throw new Error('Raw exception containing private-value'); };
  fixture.io.question = async () => { assert.fail('Unknown browser failure must not request credentials'); };
  assert.equal((await setupSession(fixture.browser, false, fixture.io)).status, 'unavailable');
  assert.ok(!fixture.messages.join('\n').includes('private-value'));
});

test('confirmed signed-out sessions still offer the two authorized setup choices', async () => {
  const fixture = setupFixture(true, ['2']);
  let checks = 0;
  fixture.browser.sessionStatus = async () => ++checks === 1
    ? { status: 'login_required', message: 'Session is signed out.' }
    : { status: 'ready', message: 'Ready' };
  assert.equal((await setupSession(fixture.browser, false, fixture.io)).status, 'ready');
  assert.equal(fixture.imported().length, 2);
  assert.match(fixture.messages.join('\n'), /1\) Log in.*\n2\) Paste cookies/);
});


test('cookie verification closes automatically before controlled session checks', async () => {
  const fixture = setupFixture(false, ['2']);
  const events: string[] = [];
  let release!: () => void;
  const exited = new Promise<void>(resolve => { release = resolve; });
  fixture.browser.prepareManualCookieSession = async cookies => ({
    count: cookies.length, autoCloseMs: 15,
    close: async () => { events.push('close'); release(); },
    waitForExit: async () => { await exited; events.push('exit'); },
  });
  fixture.browser.sessionStatus = async () => { events.push('check'); return { status: 'ready', message: 'Ready' }; };
  fixture.browser.closeAfterSetup = async () => { events.push('controlled-close'); };
  assert.equal((await setupSession(fixture.browser, false, fixture.io)).status, 'ready');
  assert.deepEqual(events, ['close', 'exit', 'check', 'controlled-close']);
  assert.match(fixture.messages.join('\n'), /close automatically/);
});

test('the reopened setup window gets its full interval even when manual Chrome exits immediately', async () => {
  for (const autoCloseMs of [undefined, 0, 10_000, 120_000]) {
    const fixture = setupFixture(false, []);
    const events: string[] = [];
    fixture.browser.prepareManualCookieSession = async cookies => ({
      count: cookies.length, autoCloseMs,
      close: async () => { assert.fail('Manual Chrome already exited'); },
      waitForExit: async () => { events.push('manual-exited'); },
    });
    fixture.browser.sessionStatus = async (navigate, settleMs) => {
      assert.equal(navigate, true);
      assert.equal(settleMs, autoCloseMs || 10_000);
      events.push('controlled-check');
      return { status: 'ready', message: 'Ready' };
    };
    fixture.browser.closeAfterSetup = async () => { events.push('controlled-close'); };
    await importCookiesWithVerification(fixture.browser, parseCookieInput(paste), fixture.io);
    assert.deepEqual(events, ['manual-exited', 'controlled-check', 'controlled-close']);
    assert.match(fixture.messages.join('\n'), /Controlled Chrome will stay open for at least/);
  }
});

test('setup checks readiness after the reopened browser verification interval', { timeout: 10_000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'images-setup-wait-'));
  const server = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(`<body>Verify you are human<script>
      setTimeout(() => { document.body.innerHTML = '<div contenteditable="true" role="textbox"></div>'; }, 100);
    </script>`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  const browser = new ChatGPTBrowser(loadConfig({ CHATGPT_DATA_DIR: directory, CHATGPT_BROWSER_MODE: 'playwright', CHATGPT_HEADLESS: 'true' }), { baseUrl });
  try {
    await browser.open();
    const started = Date.now();
    const state = await browser.sessionStatus(false, 200);
    assert.ok(Date.now() - started >= 190, 'The verification interval must finish before readiness is checked');
    assert.equal(state.status, 'ready');
  } finally {
    await browser.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test('manual exit cancels automatic closing, and closure errors retain cookies without a controlled reconnect', async () => {
  const fixture = setupFixture(false, ['2']);
  let closes = 0;
  fixture.browser.prepareManualCookieSession = async cookies => ({
    count: cookies.length, autoCloseMs: 15,
    close: async () => { closes++; }, waitForExit: async () => {},
  });
  await setupSession(fixture.browser, false, fixture.io);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(closes, 0);
  const failed = setupFixture(false, ['2']);
  failed.browser.prepareManualCookieSession = async cookies => ({
    count: cookies.length, autoCloseMs: 1,
    close: async () => { throw new Error('Could not close verification Chrome'); },
    waitForExit: async () => new Promise<void>(() => {}),
  });
  failed.browser.sessionStatus = async () => { assert.fail('Must not reconnect before Chrome exits'); };
  await assert.rejects(setupSession(failed.browser, false, failed.io), /Could not close/);
});

test('cookie setup opens manual Chrome and waits for its exit before controlled session checks', async () => {
  const fixture = setupFixture(false, ['2']);
  const events: string[] = [];
  let release!: () => void;
  const manual = new Promise<void>(resolve => { release = resolve; });
  fixture.browser.prepareManualCookieSession = async cookies => {
    events.push('cookies-loaded-and-manual-opened');
    assert.deepEqual(cookies, parseCookieInput(paste));
    return { count: cookies.length, waitForExit: async () => { events.push('waiting-for-manual-exit'); await manual; events.push('manual-exited'); } };
  };
  fixture.browser.importCookieValues = async () => { assert.fail('Manual setup must not re-import stale cookies during handoff'); };
  fixture.browser.sessionStatus = async () => { events.push('controlled-session-check'); return { status: 'ready', message: 'Ready' }; };
  const pending = setupSession(fixture.browser, false, fixture.io);
  try {
    // Let the asynchronous menu and cookie entry reach the manual wait.
    for (let i = 0; i < 10 && !events.includes('waiting-for-manual-exit'); i++) await Promise.resolve();
    assert.deepEqual(events, ['cookies-loaded-and-manual-opened', 'waiting-for-manual-exit']);
    assert.match(fixture.messages.join('\n'), /fully quit/);
    release();
    assert.equal((await pending).status, 'ready');
    assert.deepEqual(events, ['cookies-loaded-and-manual-opened', 'waiting-for-manual-exit', 'manual-exited', 'controlled-session-check']);
  } finally { release(); await pending; }
});

test('an interrupted manual setup never checks the controlled browser or replays an import', async () => {
  const fixture = setupFixture(false, []);
  fixture.browser.prepareManualCookieSession = async cookies => ({ count: cookies.length, waitForExit: async () => { throw new Error('Manual Chrome exited unexpectedly.'); } });
  fixture.browser.sessionStatus = async () => { assert.fail('Do not reconnect after a failed manual stage'); };
  fixture.browser.importCookieValues = async () => { assert.fail('Do not fall back to an automated import'); };
  await assert.rejects(importCookiesWithVerification(fixture.browser, parseCookieInput(paste), fixture.io), /exited unexpectedly/);
});

test('alternative browser engines retain their direct import and session check', async () => {
  const fixture = setupFixture(false, []);
  fixture.browser.prepareManualCookieSession = async () => undefined;
  const result = await importCookiesWithVerification(fixture.browser, parseCookieInput(paste), fixture.io);
  assert.equal(result.count, 2);
  assert.equal(result.state.status, 'ready');
  assert.equal(fixture.imported().length, 2);
});

test('the session browser closes after unsuccessful or throwing readiness checks too', async () => {
  for (const throws of [false, true]) {
    const fixture = setupFixture(false, []);
    const events: string[] = [];
    fixture.browser.sessionStatus = async () => {
      events.push('check');
      if (throws) throw new BrowserError('Fixture session unavailable');
      return { status: 'challenge', message: 'Fixture verification required' };
    };
    fixture.browser.closeAfterSetup = async () => { events.push('closed'); };
    const pending = importCookiesWithVerification(fixture.browser, parseCookieInput(paste), fixture.io);
    if (throws) await assert.rejects(pending, /Fixture session unavailable/);
    else assert.equal((await pending).state.status, 'challenge');
    assert.deepEqual(events, ['check', 'closed']);
    assert.equal(fixture.imported().length, 2);
  }
});

test('cookie import reads the account email and plan before closing, only when the session is ready', async () => {
  const fixture = setupFixture(false, []);
  const events: string[] = [];
  fixture.browser.accountProfile = async () => { events.push('profile'); return { email: 'person@example.com', plan: 'plus' }; };
  fixture.browser.closeAfterSetup = async () => { events.push('close'); };
  const ready = await importCookiesWithVerification(fixture.browser, parseCookieInput(paste), fixture.io);
  assert.deepEqual(ready.profile, { email: 'person@example.com', plan: 'plus' });
  assert.deepEqual(events, ['profile', 'close']);
  fixture.browser.sessionStatus = async () => ({ status: 'challenge', message: 'Verify' });
  const unready = await importCookiesWithVerification(fixture.browser, parseCookieInput(paste), fixture.io);
  assert.equal(unready.profile, undefined);
  assert.deepEqual(events, ['profile', 'close', 'close']);
});
