import './support/headless.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { loadConfig } from '../src/config.js';
import { ChatGPTBrowser } from '../src/browser.js';
import { runningChrome } from '../src/chrome.js';

const challengePage = '<title>Just a moment...</title><p>Verify you are human</p>';

/**
 * Fake ChatGPT behind a verification check. `clears` decides when controlled Chrome gets through:
 * 'ordinary' after this profile visits in ordinary Chrome (which sets a clearance cookie),
 * 'self' after the challenge page reloads itself, 'never' not at all, 'after-send' only after Send.
 */
async function fixture(clears: 'ordinary' | 'self' | 'never' | 'after-send') {
  const png = await sharp({ create: { width: 300, height: 300, channels: 3, background: '#1c71d8' } }).png().toBuffer();
  const counts = { ordinary: 0, challenges: 0, submissions: 0 };
  let config!: ReturnType<typeof loadConfig>;
  const ready = `<textarea id="prompt-textarea"></textarea><button data-testid="send-button">Send</button><main></main><script>
    document.querySelector('button').onclick = () => {
      fetch('/submitted');
      history.pushState({}, '', '/c/verification-fixture');
      ${clears === 'after-send' ? `document.body.innerHTML = '${challengePage}';`
        : `document.querySelector('main').innerHTML = '<article data-turn="assistant"><img src="/image.png" alt="Generated image: fixture"></article>';`}
    };
  </script>`;
  const server = createServer((request, response) => {
    void (async () => {
      if (request.url === '/image.png') { response.setHeader('content-type', 'image/png'); response.end(png); return; }
      if (request.url === '/submitted') { counts.submissions++; response.end('ok'); return; }
      if (request.url !== '/') { response.end('ok'); return; }
      response.setHeader('content-type', 'text/html');
      if (!await runningChrome(config)) {
        counts.ordinary++;
        if (clears === 'ordinary') response.setHeader('set-cookie', 'fixture-clearance=1; Path=/; Max-Age=3600');
        response.end(challengePage);
        return;
      }
      const cleared = /fixture-clearance=1/.test(request.headers.cookie ?? '');
      if (clears === 'after-send' || cleared) { response.end(ready); return; }
      counts.challenges++;
      response.end(clears === 'self'
        ? `${challengePage}<script>setTimeout(() => { document.cookie = 'fixture-clearance=1; path=/'; location.reload(); }, 700)</script>`
        : challengePage);
    })().catch(() => { response.statusCode = 500; response.end('Fixture failed'); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const dir = await mkdtemp(path.join(os.tmpdir(), 'images-verification-'));
  config = loadConfig({ CHATGPT_DATA_DIR: dir, CHATGPT_POLL_MS: '100', CHATGPT_MANUAL_CLOSE_MS: '3000' });
  const browser = new ChatGPTBrowser(config, { baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/`, verificationWaitMs: 1500 });
  return { browser, counts, async close() {
    await browser.shutdown().catch(() => {});
    await new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); });
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } };
}

test('verification before Send opens ordinary Chrome briefly, then generates once in controlled Chrome', { timeout: 60_000 }, async () => {
  const site = await fixture('ordinary');
  try {
    const result = await site.browser.generate('verification-pass', 'A blue square', () => {});
    assert.equal(result.images.length, 1);
    assert.equal(site.counts.ordinary, 1, 'The profile is opened in ordinary Chrome once');
    assert.equal(site.counts.submissions, 1, 'The prompt is sent exactly once');
  } finally { await site.close(); }
});

test('a verification page that clears by itself does not open ordinary Chrome', { timeout: 60_000 }, async () => {
  const site = await fixture('self');
  try {
    const result = await site.browser.generate('verification-self', 'A blue square', () => {});
    assert.equal(result.images.length, 1);
    assert.equal(site.counts.challenges, 1);
    assert.equal(site.counts.ordinary, 0);
    assert.equal(site.counts.submissions, 1);
  } finally { await site.close(); }
});

test('verification that persists after the ordinary Chrome handoff stops without sending, after one try', { timeout: 60_000 }, async () => {
  const site = await fixture('never');
  try {
    await assert.rejects(site.browser.generate('verification-stuck', 'A blue square', () => {}),
      /still asks for verification after this account was opened in normal Chrome\. No prompt was submitted\./);
    assert.equal(site.counts.ordinary, 1, 'Ordinary Chrome is tried once, not in a loop');
    assert.equal(site.counts.submissions, 0);
  } finally { await site.close(); }
});

test('verification after Send never retries, so a prompt cannot be sent twice', { timeout: 60_000 }, async () => {
  const site = await fixture('after-send');
  try {
    await assert.rejects(site.browser.generate('verification-after-send', 'A blue square', () => {}), /requires browser verification/);
    assert.equal(site.counts.submissions, 1);
    assert.equal(site.counts.ordinary, 0, 'No handoff once the prompt may have been sent');
  } finally { await site.close(); }
});
