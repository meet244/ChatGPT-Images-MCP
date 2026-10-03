import './support/headless.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import { loadConfig } from '../src/config.js';
import { ChatGPTBrowser } from '../src/browser.js';
import { parseCookieInput } from '../src/cookies.js';
import { chromeProfile, parseActivePort, runningChrome, stopChrome } from '../src/chrome.js';
import { saveCookies, readSavedCookies } from '../src/session-store.js';
import { AccountRegistry, AccountManager } from '../src/accounts.js';
import { JobQueue } from '../src/queue.js';
import { JobStore } from '../src/store.js';
import { importCookiesWithVerification } from '../src/setup.js';

test('CDP endpoints accept only local ports and a browser ID', () => {
  assert.deepEqual(parseActivePort('9222\n/devtools/browser/abc-123\n'), { endpoint: 'http://127.0.0.1:9222', browserPath: '/devtools/browser/abc-123' });
  for (const input of ['0\n/devtools/browser/abc', '65536\n/devtools/browser/abc', '9222\nhttps://evil.example', 'NaN\n/devtools/browser/abc', '9222\n/devtools/page/abc']) assert.equal(parseActivePort(input), undefined);
  assert.equal(loadConfig({}).browserMode, 'cdp');
  assert.equal(loadConfig({}).headless, false);
  assert.equal(loadConfig({}).manualCloseMs, 10_000);
  assert.equal(loadConfig({ CHATGPT_BROWSER_MODE: 'webkit' }).browserMode, 'webkit');
  assert.throws(() => loadConfig({ CHATGPT_BROWSER_MODE: 'unknown' }));
  assert.throws(() => loadConfig({ CHATGPT_HEADLESS: 'true' }), /visible Chrome/);
});

test('cookie setup closes manual Chrome after ten seconds and controlled Chrome after checking, retaining the verified profile', { timeout: 40_000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'images-setup-autoclose-'));
  const config = loadConfig({ CHATGPT_DATA_DIR: dir });
  const messages: string[] = [];
  const fixture = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end('<textarea id="prompt-textarea"></textarea><script>localStorage.setItem("setup-fixture", "verified-profile")</script>');
  });
  await new Promise<void>(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(fixture.address() as { port: number }).port}/`;
  const browser = new ChatGPTBrowser(config, { baseUrl });
  const cookies = parseCookieInput('__Secure-next-auth.session-token=setup-fixture-original');
  const originalStatus = browser.sessionStatus.bind(browser);
  let checked = false;
  browser.sessionStatus = async () => {
    const state = await originalStatus();
    assert.ok(await runningChrome(config), 'Controlled Chrome must be open for the session check');
    const page = await browser.open();
    assert.equal(await page.evaluate(() => localStorage.getItem('setup-fixture')), 'verified-profile');
    // Persist a fresher token from the checked browser, rather than restoring the pasted snapshot.
    await page.context().addCookies([{ ...cookies[0]!, value: 'setup-fixture-refreshed' }]);
    checked = true;
    return state;
  };
  try {
    const result = await importCookiesWithVerification(browser, cookies, {
      question: async () => { throw new Error('No extra question expected'); },
      readCookies: async () => { throw new Error('Cookies already provided'); },
      print: message => messages.push(message),
    });
    assert.equal(result.state.status, 'ready');
    assert.equal(checked, true);
    assert.match(messages.join('\n'), /close automatically in 10 seconds/);
    assert.match(messages.join('\n'), /Session browser closed/);
    assert.equal(await runningChrome(config), undefined, 'Controlled Chrome also fully closes');
    assert.equal((await readSavedCookies(dir))[0]?.value, 'setup-fixture-refreshed');
    const reopened = await browser.open();
    assert.equal(await reopened.evaluate(() => localStorage.getItem('setup-fixture')), 'verified-profile');
    assert.equal((await reopened.context().cookies('https://chatgpt.com'))[0]?.value, 'setup-fixture-refreshed');
  } finally {
    await browser.closeAfterSetup();
    await new Promise<void>(resolve => fixture.close(() => resolve()));
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
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
    await manual.close!(); // Gracefully close only this test's dedicated verification Chrome.
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

test('cold generation loads ordinary Chrome before controlled Chrome, preserving its cookies without another setup', { timeout: 35_000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'images-generation-handoff-'));
  const config = loadConfig({ CHATGPT_DATA_DIR: dir, CHATGPT_MANUAL_CLOSE_MS: '3000', CHATGPT_POLL_MS: '100' });
  const png = await sharp({ create: { width: 300, height: 300, channels: 3, background: '#26a269' } }).png().toBuffer();
  let ordinaryVisits = 0;
  let submissions = 0;
  const controlledVisits: string[] = [];
  const ordinaryCookies: string[] = [];
  const fixture = createServer((req, res) => {
    void (async () => {
      if (req.url === '/image.png') { res.setHeader('content-type', 'image/png'); res.end(png); return; }
      if (req.url === '/submitted') { submissions++; res.end('ok'); return; }
      if (req.url === '/ordinary-cookie') { ordinaryCookies.push(req.headers.cookie ?? ''); res.end('ok'); return; }
      if (req.url !== '/') { res.end('ok'); return; }
      const controlled = Boolean(await runningChrome(config));
      if (!controlled) {
        ordinaryVisits++;
        res.setHeader('set-cookie', `fixture-clearance=ordinary-${ordinaryVisits}; Path=/; Max-Age=3600`);
      } else controlledVisits.push(req.headers.cookie ?? '');
      res.setHeader('content-type', 'text/html');
      res.end(`<textarea id="prompt-textarea"></textarea><button data-testid="send-button">Send</button><main></main><script>
        ${controlled ? '' : `localStorage.setItem('ordinary-stage', '${ordinaryVisits}'); fetch('/ordinary-cookie');`}
        document.querySelector('button').onclick = () => {
          fetch('/submitted');
          history.pushState({}, '', '/c/handoff-fixture');
          document.querySelector('main').innerHTML = '<article data-turn="assistant"><img src="/image.png" alt="Generated image: fixture"></article>';
        };
      </script>`);
    })().catch(() => { res.statusCode = 500; res.end('Fixture failed'); });
  });
  await new Promise<void>(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(fixture.address() as { port: number }).port}/`;
  const browser = new ChatGPTBrowser(config, { baseUrl });
  try {
    // Seed an existing signed-in profile without going through interactive setup.
    const fresh = parseCookieInput('__Secure-next-auth.session-token=fresh-profile-fixture');
    await browser.importCookieValues(fresh);
    await browser.shutdown();
    for (let attempt = 1; attempt <= 2; attempt++) {
      // An older snapshot must not restore obsolete split tokens or clearance.
      await saveCookies(dir, parseCookieInput('__Secure-next-auth.session-token.0=stale0, __Secure-next-auth.session-token.1=stale1'));
      const result = await browser.generate(`handoff-${attempt}`, 'A green square', () => {});
      assert.equal(result.images.length, 1);
      assert.equal(ordinaryVisits, attempt, 'Exactly one ordinary load per cold generation start');
      assert.equal(ordinaryCookies.at(-1), `fixture-clearance=ordinary-${attempt}`, 'Ordinary Chrome receives its new verification cookie before closing');
      assert.match(controlledVisits.at(-1)!, new RegExp(`fixture-clearance=ordinary-${attempt}`), 'The controlled request uses the ordinary browser cookie');
      const page = await browser.open();
      assert.equal(await page.evaluate(() => localStorage.getItem('ordinary-stage')), String(attempt));
      assert.match(await page.evaluate(() => navigator.userAgent), /HeadlessChrome/);
      assert.deepEqual(page.context().pages().map(p => p.url()), [baseUrl]);
      assert.deepEqual((await page.context().cookies('https://chatgpt.com')).map(c => c.value), ['fresh-profile-fixture']);
      assert.deepEqual((await readSavedCookies(dir)).map(c => c.value), ['fresh-profile-fixture']);
      await Promise.all([browser.sessionStatus(), browser.sessionStatus()]);
      assert.equal(ordinaryVisits, attempt, 'Live session checks do not restart ordinary Chrome');
      await browser.shutdown();
      assert.equal(await runningChrome(config), undefined);
    }
    assert.equal(submissions, 2, 'Each request submits its prompt only once');
  } finally {
    await browser.shutdown();
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
    assert.match(await page.evaluate(() => navigator.userAgent), /HeadlessChrome/, 'CDP tests must never open visible Chrome');
    await page.context().newPage();
    await page.context().newPage();
    assert.equal(page.context().pages().length, 3);
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
    assert.equal(reopened.context().pages().length, 1, 'Reconnecting removes surplus tabs in the dedicated profile');
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
    const restarted = await third.open();
    assert.equal(restarted.context().pages().length, 1, 'Restarting does not accumulate restored and blank tabs');
    assert.equal(await restarted.evaluate(() => localStorage.getItem('fixture')), 'preserved');
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

test('account status checks close real dedicated Chrome and subsequent work reuses one ChatGPT tab', { timeout: 30_000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'images-single-chrome-'));
  const fixture = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end('<textarea id="prompt-textarea"></textarea>');
  });
  await new Promise<void>(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(fixture.address() as { port: number }).port}/`;
  const config = loadConfig({ CHATGPT_DATA_DIR: dir });
  const registry = new AccountRegistry(config);
  await registry.add('default');
  const secondConfig = await registry.add('second');
  const browser = new ChatGPTBrowser(config, { baseUrl });
  const store = new JobStore(dir), queue = new JobQueue(store, browser);
  const manager = new AccountManager(registry, { account: 'default', browser, store, queue }, config => new ChatGPTBrowser(config, { baseUrl }));
  try {
    for (const name of ['default', 'second', 'default', 'second']) {
      const runtime = await manager.resolve(name);
      assert.equal((await manager.inspectSession(runtime)).status, 'ready');
      const current = name === 'default' ? config : secondConfig;
      const previous = name === 'default' ? secondConfig : config;
      assert.equal(await runningChrome(current), undefined, 'Status checks fully close dedicated Chrome');
      assert.equal(await runningChrome(previous), undefined);
      const page = await runtime.browser.open();
      assert.equal(page.url(), baseUrl);
      assert.deepEqual(page.context().pages().map(tab => tab.url()), [baseUrl]);
      await runtime.browser.shutdown();
    }
  } finally {
    await manager.close();
    await new Promise<void>(resolve => fixture.close(() => resolve()));
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
