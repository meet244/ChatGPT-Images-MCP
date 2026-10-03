import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import os from 'node:os';
import { loadConfig } from '../src/config.js';
import { ChatGPTBrowser } from '../src/browser.js';
import { parseCookieInput } from '../src/cookies.js';
import { chromeProfile, parseActivePort, runningChrome, stopChrome } from '../src/chrome.js';
import { saveCookies, readSavedCookies } from '../src/session-store.js';
import { AccountRegistry } from '../src/accounts.js';

test('CDP endpoints accept only local ports and a browser ID', () => {
  assert.deepEqual(parseActivePort('9222\n/devtools/browser/abc-123\n'), { endpoint: 'http://127.0.0.1:9222', browserPath: '/devtools/browser/abc-123' });
  for (const input of ['0\n/devtools/browser/abc', '65536\n/devtools/browser/abc', '9222\nhttps://evil.example', 'NaN\n/devtools/browser/abc', '9222\n/devtools/page/abc']) assert.equal(parseActivePort(input), undefined);
  assert.equal(loadConfig({}).browserMode, 'cdp');
  assert.equal(loadConfig({}).headless, false);
  assert.equal(loadConfig({ CHATGPT_BROWSER_MODE: 'webkit' }).browserMode, 'webkit');
  assert.throws(() => loadConfig({ CHATGPT_BROWSER_MODE: 'unknown' }));
  assert.throws(() => loadConfig({ CHATGPT_HEADLESS: 'true' }), /visible Chrome/);
});

test('cookie import seeds a named profile, opens ordinary Chrome first, and preserves its state for controlled Chrome', { timeout: 35_000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'images-manual-handoff-'));
  const rootConfig = loadConfig({ CHATGPT_DATA_DIR: dir });
  const config = await new AccountRegistry(rootConfig).add('second');
  await saveCookies(dir, parseCookieInput('__Secure-next-auth.session-token=original-account-fixture'));
  const original = await readFile(path.join(dir, 'session-cookies.json'));
  let visited = false;
  let manualStage = true;
  const fixture = createServer((req, res) => {
    if (req.url === '/manual-ready') { visited = true; res.end('ok'); return; }
    res.setHeader('content-type', 'text/html');
    if (!manualStage) { res.end('<div contenteditable="true" role="textbox"></div>'); return; }
    res.end(`<div contenteditable="true" role="textbox"></div><script>
      localStorage.setItem('manual-verification-fixture', 'saved-in-ordinary-chrome');
      fetch('/manual-ready');
    </script>`);
  });
  await new Promise<void>(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(fixture.address() as { port: number }).port}/`;
  const browser = new ChatGPTBrowser(config, { baseUrl });
  let manual: Awaited<ReturnType<ChatGPTBrowser['prepareManualCookieSession']>>;
  try {
    manual = await browser.prepareManualCookieSession(parseCookieInput('__Secure-next-auth.session-token.0=first-fixture, __Secure-next-auth.session-token.1=second-fixture'));
    assert.ok(manual);
    assert.equal(manual.count, 2);
    assert.equal(await runningChrome(config), undefined, 'Ordinary Chrome has no debugging endpoint');
    const deadline = Date.now() + 8000;
    while (!visited && Date.now() < deadline) await delay(50);
    assert.equal(visited, true, 'The ordinary browser loads the verification page');
    assert.ok(manual.pid);
    process.kill(manual.pid, 'SIGTERM'); // Only this test's newly launched Chrome process.
    await manual.waitForExit();
    manualStage = false;
    // A stale snapshot must not override the cookies verified in ordinary Chrome.
    await saveCookies(config.dataDir, parseCookieInput('__Secure-next-auth.session-token=stale-fixture'));
    const page = await browser.open();
    assert.ok(await runningChrome(config), 'Controlled Chrome starts after the manual browser exits');
    assert.equal(await page.evaluate(() => localStorage.getItem('manual-verification-fixture')), 'saved-in-ordinary-chrome');
    const current = await page.context().cookies('https://chatgpt.com');
    assert.deepEqual(current.map(cookie => cookie.value).sort(), ['first-fixture', 'second-fixture']);
    assert.deepEqual((await readSavedCookies(config.dataDir)).map(cookie => cookie.value).sort(), ['first-fixture', 'second-fixture']);
    assert.deepEqual(await readFile(path.join(dir, 'session-cookies.json')), original, 'The original account is unchanged');
  } finally {
    if (manual?.pid) { try { process.kill(manual.pid, 'SIGTERM'); } catch { /* Already exited. */ } }
    await browser.close(); await stopChrome(config);
    await new Promise<void>(resolve => fixture.close(() => resolve()));
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('stale CDP metadata cannot attach to an unrelated localhost service', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'images-cdp-stale-'));
  const server = createServer((_req, res) => {
    const address = server.address() as { port: number };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${address.port}/devtools/browser/some-other-browser` }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const config = loadConfig({ CHATGPT_DATA_DIR: dir });
  try {
    await mkdir(chromeProfile(config));
    await writeFile(path.join(chromeProfile(config), 'DevToolsActivePort'), `${(server.address() as {port:number}).port}\n/devtools/browser/expected-browser\n`);
    assert.equal(await runningChrome(config), undefined);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

test('CDP reconnect preserves live cookies and browser state, and explicit close targets dedicated Chrome', { timeout: 30_000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'images-cdp-state-'));
  const fixture = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end('<textarea id="prompt-textarea"></textarea>');
  });
  await new Promise<void>(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(fixture.address() as { port: number }).port}/`;
  const config = loadConfig({ CHATGPT_DATA_DIR: dir });
  const first = new ChatGPTBrowser(config, { baseUrl });
  const second = new ChatGPTBrowser(config, { baseUrl });
  const third = new ChatGPTBrowser(config, { baseUrl });
  try {
    const cookies = parseCookieInput('__Secure-next-auth.session-token.0=fixture0\n__Secure-next-auth.session-token.1=fixture1');
    await first.importCookieValues(cookies);
    const page = await first.open();
    await page.evaluate(() => localStorage.setItem('fixture', 'preserved'));
    // Simulate a token refreshed by the live website after our last saved snapshot.
    await page.context().addCookies([{ ...cookies[0]!, value: 'refreshed-by-site' }]);
    const endpoint = await runningChrome(config);
    assert.ok(endpoint);
    await first.close();
    assert.equal(await runningChrome(config), endpoint);
    // A stale disk snapshot must not overwrite tokens already refreshed in live Chrome.
    await saveCookies(config.dataDir, cookies);
    const reopened = await second.open();
    assert.equal(await reopened.evaluate(() => localStorage.getItem('fixture')), 'preserved');
    assert.equal((await reopened.context().cookies('https://chatgpt.com')).find(cookie => cookie.name.endsWith('session-token.0'))?.value, 'refreshed-by-site');
    await second.close();
    const whole = parseCookieInput('__Secure-next-auth.session-token=new-whole-fixture');
    const live = await third.open();
    await live.context().clearCookies({ name: /session-token/ });
    await live.context().addCookies(whole);
    await third.close();
    await saveCookies(config.dataDir, cookies);
    const newShape = await third.open();
    assert.deepEqual((await newShape.context().cookies('https://chatgpt.com')).map(cookie => cookie.name), ['__Secure-next-auth.session-token'], 'Do not resurrect old split parts after the website replaces them with a whole token');
    await third.close();
    assert.equal(await stopChrome(config), true);
    assert.equal(await runningChrome(config), undefined);
    assert.equal(await stopChrome(config), false);
  } finally {
    await first.close();
    await second.close();
    await third.close();
    await stopChrome(config);
    await new Promise<void>(resolve => fixture.close(() => resolve()));
    // Chrome may still flush its profile after its debugging endpoint closes.
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
