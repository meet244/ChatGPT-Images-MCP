import './support/headless.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { loadConfig } from '../src/config.js';
import { ChatGPTBrowser } from '../src/browser.js';
import { chromeProfile, stopChrome } from '../src/chrome.js';
import { parseCookieInput } from '../src/cookies.js';

const backgroundFlags = ['--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'];

test('CHATGPT_BROWSER_FOCUS defaults to background and accepts only front or background', () => {
  assert.equal(loadConfig({}).browserFocus, 'background');
  assert.equal(loadConfig({ CHATGPT_BROWSER_FOCUS: 'front' }).browserFocus, 'front');
  assert.equal(loadConfig({ CHATGPT_BROWSER_FOCUS: 'background' }).browserFocus, 'background');
  assert.throws(() => loadConfig({ CHATGPT_BROWSER_FOCUS: 'hidden' }), /front or background/);
});

for (const focus of ['background', 'front'] as const) {
  test(`${focus} mode: launch options, one window, and ${focus === 'background' ? 'no' : 'a'} window activation before Send`, { timeout: 60_000 }, async t => {
    const dir = await mkdtemp(path.join(os.tmpdir(), `images-focus-${focus}-`));
    const config = loadConfig({ CHATGPT_DATA_DIR: dir, CHATGPT_POLL_MS: '100', CHATGPT_BROWSER_FOCUS: focus });
    const png = await sharp({ create: { width: 300, height: 300, channels: 3, background: '#26a269' } }).png().toBuffer();
    const launches: string[][] = [];
    const spawn = childProcess.spawn;
    t.mock.method(childProcess, 'spawn', (command: string, args: string[], options: object) => {
      if (Array.isArray(args) && args.includes(`--user-data-dir=${chromeProfile(config)}`)) launches.push([...args]);
      return spawn(command, args, options);
    });
    syncBuiltinESMExports();
    let submissions = 0;
    // Send only works after an animation frame, like ChatGPT's composer.
    const fixture = createServer((req, res) => {
      if (req.url === '/image.png') { res.setHeader('content-type', 'image/png'); res.end(png); return; }
      if (req.url === '/submitted') { submissions++; res.end('ok'); return; }
      res.setHeader('content-type', 'text/html');
      res.end(`<textarea id="prompt-textarea"></textarea><button data-testid="send-button">Send</button><main></main><script>
        document.querySelector('button').onclick = () => requestAnimationFrame(() => {
          fetch('/submitted'); document.querySelector('textarea').value = '';
          history.pushState({}, '', '/c/focus-fixture');
          document.querySelector('main').innerHTML = '<article data-turn="assistant"><img src="/image.png" alt="Generated image: fixture"></article>';
        });
      </script>`);
    });
    await new Promise<void>(resolve => fixture.listen(0, '127.0.0.1', resolve));
    const browser = new ChatGPTBrowser(config, { baseUrl: `http://127.0.0.1:${(fixture.address() as { port: number }).port}/` });
    try {
      await browser.importCookieValues(parseCookieInput('__Secure-next-auth.session-token=focus-fixture'));
      const page = await browser.open();
      let activations = 0;
      // Count real window activations; generation must succeed either way.
      const bringToFront = page.bringToFront.bind(page);
      page.bringToFront = async () => { activations++; await bringToFront(); };
      const result = await browser.generate('focus-job', 'A green square', () => {});
      assert.equal(result.images.length, 1);
      assert.equal(submissions, 1);
      assert.equal(activations, focus === 'background' ? 0 : 1);
      assert.equal(await page.evaluate(() => document.hasFocus()), true, 'The page treats itself as focused');
      assert.deepEqual(page.context().pages().length, 1);
      const flags = backgroundFlags.filter(flag => launches[0]!.includes(flag));
      assert.deepEqual(flags, focus === 'background' ? backgroundFlags : []);
    } finally {
      await browser.shutdown().catch(() => {});
      await stopChrome(config).catch(() => {});
      t.mock.restoreAll(); syncBuiltinESMExports();
      await new Promise<void>(resolve => fixture.close(() => resolve()));
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
}
