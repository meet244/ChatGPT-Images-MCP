import './support/headless.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import sharp from 'sharp';
import { loadConfig } from '../src/config.js';
import { ChatGPTBrowser } from '../src/browser.js';
import { connectChrome, stopChrome } from '../src/chrome.js';
import { JobStore } from '../src/store.js';
import { JobQueue } from '../src/queue.js';

for (const scenario of ['accepted', 'background', 'ignored', 'usage_limit'] as const) test(`current reference cards and delayed send: ${scenario}`, { timeout: 25_000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'images-submission-'));
  const png = await sharp({ create: { width: 512, height: 512, channels: 3, background: '#176e4a' } }).png().toBuffer();
  const fixture = createServer((req, res) => {
    if (req.url?.startsWith('/image.png')) { res.setHeader('content-type', 'image/png'); res.end(png); return; }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(`<!DOCTYPE html><body>
      <form data-type="unified-composer" onsubmit="return false">
        <div contenteditable="true" role="textbox"></div>
        <div id="files"><div role="group" aria-label="stale.png"><img src="/image.png" alt=""><button type="button" aria-label="Remove file 1: stale.png" style="opacity:0;pointer-events:none">Remove</button></div></div>
        <input type="file" accept="image/*" multiple hidden>
        <button type="button" data-testid="send-button" style="display:none" disabled>Send</button>
      </form><main></main><script>
      const scenario=${JSON.stringify(scenario)};
      const send=document.querySelector('[data-testid="send-button"]');
      document.querySelector('[aria-label^="Remove file"]').onclick=e=>{e.target.closest('[role=group]').remove();sessionStorage.setItem('oldRemoved','yes');};
      document.querySelector('input').onchange=async event=>{
        send.style.display='block'; send.disabled=true;
        let uploads=0;
        for(const file of event.target.files){
          const card=document.createElement('div');card.setAttribute('role','group');card.setAttribute('aria-label',file.name);card.setAttribute('aria-busy','true');
          const img=document.createElement('img');img.alt='';img.src=URL.createObjectURL(file);card.append(img);
          const remove=document.createElement('button');remove.type='button';remove.setAttribute('aria-label','Remove file '+(++uploads)+': '+file.name);remove.onclick=()=>card.remove();card.append(remove);
          const progress=document.createElement('span');progress.setAttribute('role','progressbar');card.append(progress);document.querySelector('#files').append(card);
          setTimeout(()=>{progress.remove();card.setAttribute('aria-busy','false');},800);
        }
        sessionStorage.setItem('uploads',String(uploads));
        // Previews are loaded before the send button becomes usable.
        setTimeout(()=>{send.disabled=false;sessionStorage.setItem('ready','yes');},1400);
      };
      let clicks=0;
      send.onclick=()=>{
        sessionStorage.setItem('clicks',String(++clicks));
        if(sessionStorage.getItem('ready')!=='yes')throw new Error('Clicked before upload processing finished');
        const text=document.querySelector('[role=textbox]').innerText;
        const record=JSON.parse(sessionStorage.getItem('submissions')||'[]');record.push({text,attachments:document.querySelectorAll('#files [role=group]').length});sessionStorage.setItem('submissions',JSON.stringify(record));
        if(scenario==='ignored')return;
        setTimeout(()=>{
          document.querySelector('[role=textbox]').innerHTML='';document.querySelector('#files').innerHTML='';
          history.replaceState({},'', '/c/reference-cards');
          if(scenario==='usage_limit'){
            setTimeout(()=>document.querySelector('main').insertAdjacentHTML('beforeend',
              '<div class="agent-turn" data-conversation-screenshot-content data-dil-talvt-response-state="complete">You’re out of images<p>You’re out of image creations for now. Wait for more tomorrow at 10:53 AM.</p><p>You have hit the Free plan limit for image generations requests.</p></div>'),300);
            return;
          }
          const result=document.createElement('div');result.setAttribute('data-image-gen-result','');
          // Different source URLs identify each result in the same chat.
          result.innerHTML='<img alt="Generated image: Result '+clicks+'" src="/image.png?n='+clicks+'">';document.querySelector('main').append(result);
        },400);
      };</script>`);
  });
  await new Promise<void>(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(fixture.address() as { port: number }).port}/`;
  const config = loadConfig({ CHATGPT_DATA_DIR: dir, CHATGPT_POLL_MS: '100', CHATGPT_TIMEOUT_MS: '10000' });
  const browser = new ChatGPTBrowser(config, { baseUrl });
  const store = new JobStore(dir);
  const queue = new JobQueue(store, browser);
  type Recorded = { removed: string | null; uploads: string | null; clicks: string | null; submissions: any[] };
  let recorded: Recorded | undefined;
  let generationPage: Awaited<ReturnType<ChatGPTBrowser['open']>> | undefined;
  const inspect = async (page: Awaited<ReturnType<ChatGPTBrowser['open']>>): Promise<Recorded> => page.evaluate(() => ({
    removed: sessionStorage.getItem('oldRemoved'), uploads: sessionStorage.getItem('uploads'),
    clicks: sessionStorage.getItem('clicks'), submissions: JSON.parse(sessionStorage.getItem('submissions') || '[]'),
  }));
  const shutdown = browser.shutdown.bind(browser);
  browser.shutdown = async () => {
    generationPage = await browser.open();
    recorded = await inspect(generationPage);
    await shutdown();
  };
  let observer;
  try {
    const paths = [path.join(dir, 'face.png'), path.join(dir, 'style.png')];
    await Promise.all(paths.map(file => writeFile(file, png)));
    if (scenario === 'background') {
      await browser.open();
      observer = await connectChrome(config);
      // The worker reuses this chat while another tab owns Chrome's foreground.
      // A background tab can stop the animation frames used by click stability checks.
      const otherTab = await observer.contexts()[0]!.newPage();
      await otherTab.bringToFront();
    }
    if (scenario !== 'ignored') {
      const batch = await queue.enqueueBatch(['Front portrait', 'Back portrait'], 'same_chat', paths);
      const deadline = Date.now() + 15_000;
      while (['queued', 'running'].includes(store.getBatch(batch.id).status) && Date.now() < deadline) await delay(100);
      const completed = store.getBatch(batch.id);
      if (scenario === 'accepted' || scenario === 'background') {
        assert.equal(completed.status, 'completed', JSON.stringify(completed));
        assert.ok(completed.jobs.every(job => job.conversationUrl === `${baseUrl}c/reference-cards` && job.images?.length === 1));
      } else {
        assert.equal(completed.status, 'failed', JSON.stringify(completed));
        assert.match(completed.jobs[0]!.error!, /Free plan image allowance has been exhausted/);
        assert.equal(completed.jobs[0]!.errorCode, 'free_tier_exhausted');
        assert.equal(completed.jobs[0]!.limitReset, 'tomorrow at 10:53 AM.');
        assert.equal(completed.jobs[1]!.status, 'cancelled');
      }
    } else {
      let submitted = false;
      await assert.rejects(browser.generate(randomUUID(), 'Do not resend', () => { submitted = true; },
        paths.map(file => ({ path: file, mimeType: 'image/png', bytes: png.length }))), /did not confirm accepting the message.*no automatic resend/);
      assert.equal(submitted, false, 'Do not record a submitted conversation when the click was ignored');
    }
    if (scenario === 'ignored') {
      observer ??= await connectChrome(config);
      recorded = await inspect(observer.contexts()[0]!.pages()[0]!);
    } else {
      const closeDeadline = Date.now() + 5000;
      while (queue.isBusy() && Date.now() < closeDeadline) await delay(20);
      assert.equal(queue.isBusy(), false);
      assert.equal(generationPage?.isClosed(), true, 'The submission browser closes once all queued work finishes');
    }
    assert.ok(recorded);
    assert.equal(recorded.removed, 'yes');
    assert.equal(recorded.uploads, '2');
    assert.equal(recorded.clicks, scenario === 'accepted' || scenario === 'background' ? '2' : '1');
    assert.equal(recorded.submissions[0].attachments, 2, 'Old files are removed and both shared references reach the first prompt');
    if (scenario === 'accepted' || scenario === 'background') {
      assert.equal(recorded.submissions[1].attachments, 0);
      assert.match(recorded.submissions[1].text, /original reference images previously attached/);
    }
  } finally {
    await observer?.close();
    const stopped = queue.stop(); await browser.close(); await stopped; store.close(); await stopChrome(config);
    await new Promise<void>(resolve => fixture.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
