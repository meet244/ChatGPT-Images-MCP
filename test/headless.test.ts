import './support/headless.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { loadConfig, projectRoot } from '../src/config.js';

test('test setup preserves visible application defaults', () => {
  const config = loadConfig({});
  assert.equal(config.browserMode, 'cdp');
  assert.equal(config.headless, false);
});

test('child clients inherit headless tests even with a replacement environment and visible launch options', { timeout: 15_000 }, async () => {
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { chromium } from 'playwright';
    const browser = await chromium.launch({ headless: false });
    try {
      const page = await browser.newPage();
      console.log(await page.evaluate(() => navigator.userAgent));
    } finally { await browser.close(); }
  `], { cwd: projectRoot, env: { PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', errors = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { errors += chunk; });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  assert.equal(code, 0, errors);
  assert.match(output, /HeadlessChrome/);
});
