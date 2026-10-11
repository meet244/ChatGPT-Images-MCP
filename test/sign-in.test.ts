import './support/headless.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { ChatGPTBrowser } from '../src/browser.js';

/** Signed out until the page's own script sets a session cookie, as a real sign-in would. */
function fixture(options: { signInAfterMs?: number; challengeFirst?: boolean } = {}) {
  let requests = 0;
  const server = createServer((request, response) => {
    const signedIn = /(?:^|;\s*)next-auth\.session-token=/.test(request.headers.cookie ?? '');
    if (request.url === '/api/auth/session') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(signedIn ? { user: { email: 'person@example.com' }, account: { planType: 'Plus' }, accessToken: 'must-not-leave-page' } : {}));
      return;
    }
    response.setHeader('content-type', 'text/html');
    if (options.challengeFirst && requests++ === 0) {
      response.end('<title>Just a moment...</title><p>Verify you are human</p><script>setTimeout(() => location.reload(), 300)</script>');
      return;
    }
    response.end(signedIn
      ? '<textarea id="prompt-textarea"></textarea>'
      : `<button>Log in</button>${options.signInAfterMs === undefined ? ''
        : `<script>setTimeout(() => { document.cookie = 'next-auth.session-token=fixture; path=/'; location.reload(); }, ${options.signInAfterMs})</script>`}`);
  });
  return new Promise<{ baseUrl: string; close(): Promise<void> }>(resolve => server.listen(0, '127.0.0.1', () => resolve({
    baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/`,
    close: () => new Promise(done => { server.closeAllConnections(); server.close(() => done()); }),
  })));
}

const browserFor = (dir: string, baseUrl: string) => new ChatGPTBrowser(loadConfig({ CHATGPT_DATA_DIR: dir, CHATGPT_BROWSER_MODE: 'playwright', CHATGPT_HEADLESS: 'true' }), { baseUrl });

test('browser sign-in continues by itself once signed in, reports verification, and reads only email and plan', { timeout: 30_000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'images-sign-in-'));
  const site = await fixture({ signInAfterMs: 600, challengeFirst: true });
  const browser = browserFor(dir, site.baseUrl);
  const statuses: string[] = [];
  try {
    const state = await browser.waitForSignIn({ pollMs: 100, timeoutMs: 20_000, onStatus: status => statuses.push(status) });
    assert.equal(state.status, 'ready');
    assert.deepEqual(statuses, ['challenge', 'login_required', 'ready']);
    assert.deepEqual(await browser.accountProfile(), { email: 'person@example.com', plan: 'plus' });
    await browser.shutdown();
  } finally { await browser.close().catch(() => {}); await site.close(); await rm(dir, { recursive: true, force: true }); }
});

test('browser sign-in can be cancelled or time out without reporting a signed-in session', { timeout: 30_000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'images-sign-in-cancel-'));
  const site = await fixture();
  const browser = browserFor(dir, site.baseUrl);
  try {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    const started = Date.now();
    const cancelled = await browser.waitForSignIn({ pollMs: 5000, signal: controller.signal });
    assert.equal(cancelled.status, 'login_required');
    assert.match(cancelled.message, /cancelled/);
    assert.ok(Date.now() - started < 4000, 'Cancelling interrupts the wait between checks');
    const timedOut = await browser.waitForSignIn({ pollMs: 50, timeoutMs: 400 });
    assert.match(timedOut.message, /Timed out/);
    assert.equal(await browser.accountProfile(), undefined);
  } finally { await browser.close().catch(() => {}); await site.close(); await rm(dir, { recursive: true, force: true }); }
});
