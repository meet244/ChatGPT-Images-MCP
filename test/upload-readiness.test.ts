import './support/headless.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { ChatGPTBrowser } from '../src/browser.js';
import { loadConfig } from '../src/config.js';

for (const scenario of ['busy_cards', 'slow_upload', 'same_filename', 'foreground_upload', 'timestamp_names'] as const) {
  test(`wait for every reference before sending: ${scenario}`, { timeout: 15_000 }, async t => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'images-upload-ready-'));
    const png = await sharp({ create: { width: 300, height: 300, channels: 3, background: '#4488cc' } }).png().toBuffer();
    const fixture = createServer((req, res) => {
      if (req.url === '/image.png') { res.setHeader('content-type', 'image/png'); res.end(png); return; }
      res.setHeader('content-type', 'text/html');
      res.end(`<!DOCTYPE html><body>
        <div contenteditable="true" role="textbox"></div><input type="file" accept="image/*" multiple hidden>
        <div id="files"></div><button data-testid="send-button">Send</button><main></main><script>
        const scenario=${JSON.stringify(scenario)};
        window.ready=false;window.early=false;window.clicks=0;window.countAtSend=0;
        const card=file=>{
          const surface=document.createElement('div');surface.className='composer-attachment-surface';
          surface.setAttribute('aria-busy',scenario==='busy_cards'?'true':'false');
          const img=document.createElement('img');img.src=URL.createObjectURL(file);img.alt=file.name;surface.append(img);
          if(scenario==='timestamp_names'){
            img.alt=file.name.replace(/(\.[^.]+)$/, (document.querySelector('#files').children.length?'(9)':'(20261004-070631)')+'$1');
          }
          if(scenario==='slow_upload'){
            const progress=document.createElement('span');progress.setAttribute('role','progressbar');progress.textContent='Uploading';surface.append(progress);
          }
          document.querySelector('#files').append(surface);
        };
        document.querySelector('input').onchange=event=>{
          const files=[...event.target.files];
          card(files[0]);
          if(scenario==='same_filename'){
            const preview=document.querySelector('#files img');preview.parentElement.append(preview.cloneNode());
          }
          if(scenario!=='same_filename')card(files[1]);
          if(scenario==='foreground_upload'||scenario==='timestamp_names'){window.ready=true;return;}
          setTimeout(()=>{
            if(scenario==='same_filename')card(files[1]);
            document.querySelectorAll('#files [aria-busy]').forEach(el=>el.setAttribute('aria-busy','false'));
            document.querySelectorAll('[role=progressbar]').forEach(el=>el.remove());
            window.ready=true;
          },scenario==='slow_upload'?2500:1600);
        };
        document.querySelector('button').onclick=()=>{
          window.clicks++;window.countAtSend=document.querySelectorAll('#files > div').length;
          if(!window.ready){window.early=true;return;}
          document.querySelector('[role=textbox]').textContent='';
          history.replaceState({},'', '/c/upload-ready');
          document.querySelector('main').innerHTML='<div data-image-gen-result><img alt="Generated image: result" src="/image.png"></div>';
        };
        </script>`);
    });
    await new Promise<void>(resolve => fixture.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${(fixture.address() as { port: number }).port}/`;
    const config = loadConfig({ CHATGPT_DATA_DIR: dir, CHATGPT_BROWSER_MODE: 'playwright', CHATGPT_POLL_MS: '100', CHATGPT_TIMEOUT_MS: '300000' });
    const browser = new ChatGPTBrowser(config, { baseUrl });
    try {
      const paths = [path.join(dir, 'one', 'reference.png'), path.join(dir, 'two', scenario === 'same_filename' ? 'reference.png' : 'style.png')];
      for (const file of paths) { await mkdir(path.dirname(file)); await writeFile(file, png); }
      const page = await browser.open();
      if (scenario === 'foreground_upload') {
        const foreground = page.bringToFront.bind(page);
        page.bringToFront = async () => {
          await foreground();
          await page.evaluate(() => {
            const state = window as typeof window & { ready: boolean };
            state.ready = false;
            document.querySelectorAll('#files > div').forEach(el => el.setAttribute('aria-busy', 'true'));
            setTimeout(() => {
              document.querySelectorAll('#files > div').forEach(el => el.setAttribute('aria-busy', 'false'));
              state.ready = true;
            }, 1400);
          });
        };
      }
      // Exercise an upload exceeding the former 60-second cap without a long test.
      const now = Date.now.bind(Date), started = now();
      t.mock.method(Date, 'now', () => started + (now() - started) * (scenario === 'slow_upload' ? 80 : 1));
      let submitted = 0;
      const result = await browser.generate(randomUUID(), 'Use both references', () => { submitted++; },
        paths.map(file => ({ path: file, mimeType: 'image/png', bytes: png.length })));
      assert.equal(result.images.length, 1);
      assert.equal(submitted, 1);
      if (scenario === 'slow_upload') assert.ok(Date.now() - started > 60_000, 'Upload waited beyond the previous cap');
      const audit = await page.evaluate(() => {
        const state = window as typeof window & { early: boolean; clicks: number; countAtSend: number };
        return { early: state.early, clicks: state.clicks, countAtSend: state.countAtSend };
      });
      assert.deepEqual(audit, { early: false, clicks: 1, countAtSend: 2 });
    } finally {
      t.mock.restoreAll();
      await browser.shutdown();
      await new Promise<void>(resolve => fixture.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    }
  });
}
