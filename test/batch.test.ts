import './support/headless.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer as createHttpServer } from 'node:http';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import sharp from 'sharp';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { loadConfig } from '../src/config.js';
import { JobStore } from '../src/store.js';
import { JobQueue } from '../src/queue.js';
import { ChatGPTBrowser } from '../src/browser.js';
import { createServer } from '../src/server.js';
import { stopChrome } from '../src/chrome.js';
import { classifyGenerationLimit, generationLimitNotice } from '../src/limits.js';

function parsed(result: any): any {
  assert.equal(result.isError, undefined, JSON.stringify(result.content));
  return JSON.parse(result.content.find((item: any) => item.type === 'text').text);
}

test('only explicit conversation-length notices qualify for rollover', () => {
  assert.equal(classifyGenerationLimit("You've reached the maximum length for this conversation, but you can keep talking by starting a new chat."), 'conversation_full');
  assert.equal(classifyGenerationLimit('This conversation is too long. Please start a new chat.'), 'conversation_full');
  assert.equal(classifyGenerationLimit('Conversation limit reached. Start a new chat.'), 'conversation_full');
  assert.equal(classifyGenerationLimit("You've reached your image creation limit. Try again tomorrow."), 'usage_limit');
  assert.equal(classifyGenerationLimit('You’re out of images\nYou’re out of image creations for now. Wait for more tomorrow.'), 'usage_limit');
  assert.equal(classifyGenerationLimit("You've hit the Free plan limit for image generations requests."), 'usage_limit');
  assert.deepEqual(generationLimitNotice('You’re out of images. Wait for more tomorrow at 10:53 AM. You have hit the Free plan limit for image generations requests.'),
    { kind: 'usage_limit', freeTier: true, resetText: 'tomorrow at 10:53 AM.' });
  assert.equal(generationLimitNotice('You’re out of images.')!.freeTier, undefined, 'Do not guess the plan from a generic limit notice');
  for (const text of ['Chat limit reached', 'Network error', 'Timed out', 'Create an image with the text: This conversation is too long']) assert.equal(classifyGenerationLimit(text), undefined);
});

test('batch admission is atomic and failed validation does not block later batches', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'images-batch-admission-'));
  const store = new JobStore(dir);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const queue = new JobQueue(store, { async generate(id) { await gate; return { conversationUrl: `https://chatgpt.com/c/${id}`, images: [] }; } });
  try {
    queue.enqueue('running');
    for (let i = 0; i < 24; i++) queue.enqueue(`pending ${i}`);
    await assert.rejects(queue.enqueueBatch(['one', 'two'], 'same_chat'), /no part of this batch was queued/);
    assert.equal(store.list(100).length, 25);
    await assert.rejects(queue.enqueueBatch(['invalid'], 'same_chat', [path.join(dir, 'missing.png')]), /could not be read/);
    const accepted = await queue.enqueueBatch(['fits'], 'same_chat');
    assert.equal(accepted.total, 1);
    assert.equal(accepted.status, 'queued');
    assert.equal(store.list(100).length, 26);
  } finally { release(); await queue.stop(); store.close(); await rm(dir, { recursive: true, force: true }); }
});

test('restart preserves batch context and stops the rest of an interrupted batch', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'images-batch-restart-'));
  let store = new JobStore(dir);
  try {
    const resumable = store.createBatch(['done', 'pending'], 'same_chat', [], '9:16');
    store.update(resumable.jobs[0]!.id, { status: 'completed', conversationUrl: 'https://chatgpt.com/c/preserved' });
    const interrupted = store.createBatch(['running', 'never submit'], 'same_chat');
    store.update(interrupted.jobs[0]!.id, { status: 'running' });
    store.close(); store = new JobStore(dir);
    const interruptedAfter = store.getBatch(interrupted.id);
    assert.equal(interruptedAfter.status, 'failed');
    assert.deepEqual(interruptedAfter.jobs.map(job => job.status), ['failed', 'cancelled']);
    const options: unknown[] = [];
    const queue = new JobQueue(store, { async generate(id, _prompt, _submitted, _references, context) {
      options.push(context); return { conversationUrl: `https://chatgpt.com/c/${id}`, images: [] };
    } });
    try {
      queue.kick();
      const deadline = Date.now() + 3000;
      while (store.getBatch(resumable.id).status !== 'completed' && Date.now() < deadline) await delay(10);
      assert.equal(store.getBatch(resumable.id).status, 'completed');
      assert.equal(store.getBatch(resumable.id).aspectRatio, '9:16');
      assert.deepEqual(options, [{ conversationUrl: 'https://chatgpt.com/c/preserved', reuseReferences: true, allowConversationRollover: true, aspectRatio: '9:16' }]);
    } finally { await queue.stop(); }
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});

for (const scenario of ['same_chat', 'rollover', 'preflight_rollover', 'usage_limit'] as const) test(`MCP batch: ${scenario}, shared references, and individual image results`, { timeout: 35_000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'images-batch-browser-'));
  const reference = await sharp({ create: { width: 300, height: 200, channels: 3, background: '#ff8800' } }).png().toBuffer();
  const colors = ['#ff0000', '#00ff00', '#0000ff'];
  const output = await Promise.all(colors.map(background => sharp({ create: { width: 512, height: 512, channels: 3, background } }).png().toBuffer()));
  const fixture = createHttpServer((req, res) => {
    const match = req.url?.match(/^\/output\/(one|two|three)\.png$/);
    if (match) { res.setHeader('content-type', 'image/png'); res.end(output[['one', 'two', 'three'].indexOf(match[1]!)]); return; }
    res.setHeader('content-type', 'text/html');
    res.end(`<!DOCTYPE html><body><div contenteditable="true" role="textbox"></div><button aria-label="Send">Send</button><input type="file" accept="image/*" multiple hidden><div id="attachments"></div><main></main><script>
      const scenario = ${JSON.stringify(scenario)};
      const names = ['one', 'two', 'three'];
      const chatId = location.pathname.startsWith('/c/') ? location.pathname.split('/').pop() : 'chat-' + (Number(sessionStorage.getItem('nextChat') || 0) + 1);
      if (!location.pathname.startsWith('/c/')) sessionStorage.setItem('nextChat', chatId.split('-')[1]);
      const record = (key, value) => {const list=JSON.parse(sessionStorage.getItem(key) || '[]'); list.push(value); sessionStorage.setItem(key, JSON.stringify(list));};
      let successes = 0;
      document.querySelector('input').onchange = async event => {
        for (const file of event.target.files) {
          const bytes = await new Promise(resolve => {const reader=new FileReader(); reader.onload=()=>resolve(reader.result.split(',')[1]); reader.readAsDataURL(file);});
          record('uploads', {chatId,bytes,name:file.name});
          const surface=document.createElement('span'); surface.className='composer-attachment-surface';
          const img=document.createElement('img'); img.alt=file.name; img.src=URL.createObjectURL(file); surface.append(img);
          const progress=document.createElement('span'); progress.setAttribute('role','progressbar'); progress.setAttribute('aria-label','Uploading '+file.name); progress.textContent='Uploading'; surface.append(progress);
          document.querySelector('#attachments').append(surface); setTimeout(()=>progress.remove(), 100);
        }
      };
      document.querySelector('button').onclick = () => {
        const text=document.querySelector('[role=textbox]').innerText;
        const prompt=names.find(name=>text.replace(/Output aspect ratio = [^\\n]+$/, '').trim().endsWith(name));
        record('submissions', {chatId,prompt,text});
        history.replaceState({}, '', '/c/'+chatId);
        document.querySelector('#attachments').innerHTML='';
        document.querySelector('[role=textbox]').innerHTML='';
        if (successes===1 && ((scenario==='rollover' && chatId==='chat-1') || scenario==='usage_limit')) {
          const alert=document.createElement('div'); alert.setAttribute('role','alert');
          alert.textContent=scenario==='rollover' ? "You've reached the maximum length for this conversation, but you can keep talking by starting a new chat." : "You've reached your image creation limit. Try again tomorrow.";
          document.querySelector('main').append(alert); return;
        }
        successes++;
        const gallery=document.createElement('div'); gallery.setAttribute('data-testid','generated-image-gallery');
        const preview=document.createElement('button'); preview.setAttribute('data-testid','generated-image-preview');
        const image=document.createElement('img'); image.src='/output/'+prompt+'.png'; preview.append(image); gallery.append(preview); document.querySelector('main').append(gallery);
        const stop=document.createElement('button'); stop.setAttribute('data-testid','stop-button'); stop.textContent='Stop generating'; document.querySelector('main').append(stop); setTimeout(()=>{
          stop.remove();
          if (scenario==='preflight_rollover' && chatId==='chat-1') {
            document.querySelector('[role=textbox]').remove();
            const alert=document.createElement('div'); alert.setAttribute('role','alert'); alert.textContent='This conversation is too long. Please start a new chat.'; document.querySelector('main').append(alert);
          }
        }, 100);
      };
    </script>`);
  });
  await new Promise<void>(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(fixture.address() as { port: number }).port}/`;
  const config = loadConfig({ CHATGPT_DATA_DIR: dir, CHATGPT_POLL_MS: '100', CHATGPT_TIMEOUT_MS: '10000' });
  const browser = new ChatGPTBrowser(config, { baseUrl });
  let recorded: { uploads: any[]; submissions: any[] } | undefined;
  let generationPage: Awaited<ReturnType<ChatGPTBrowser['open']>> | undefined;
  const shutdown = browser.shutdown.bind(browser);
  browser.shutdown = async () => {
    generationPage = await browser.open();
    recorded = await generationPage.evaluate(() => ({ uploads: JSON.parse(sessionStorage.getItem('uploads') || '[]'), submissions: JSON.parse(sessionStorage.getItem('submissions') || '[]') }));
    await shutdown();
  };
  const store = new JobStore(dir);
  const queue = new JobQueue(store, browser);
  const server = createServer(store, queue, browser);
  const client = new Client({ name: 'batch-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport); await client.connect(clientTransport);
    const referencePath = path.join(dir, 'reference.png'); await writeFile(referencePath, reference);
    const aspectRatio = scenario === 'same_chat' ? undefined : '16:9';
    const initial = parsed(await client.callTool({ name: 'generate_images', arguments: { prompts: ['one', 'two', 'three'], reference_images: [referencePath],
      ...(aspectRatio !== undefined ? { aspect_ratio: aspectRatio } : {}) } }));
    assert.equal(initial.total, 3);
    assert.equal(new Set(initial.jobs.map((job: any) => job.referenceImages[0].path)).size, 1, 'References are copied once for the whole batch');
    await rm(referencePath);
    let batch = initial;
    const deadline = Date.now() + 25_000;
    while (['queued', 'running'].includes(batch.status) && Date.now() < deadline) {
      await delay(100); batch = parsed(await client.callTool({ name: 'get_batch_status', arguments: { batch_id: initial.id } }));
    }
    assert.equal(batch.status, scenario === 'usage_limit' ? 'failed' : 'completed', JSON.stringify(batch));
    const completed = batch.jobs.filter((job: any) => job.status === 'completed');
    assert.equal(completed.length, scenario === 'usage_limit' ? 1 : 3);
    for (const [index, job] of completed.entries()) {
      assert.equal(job.images.length, 1, 'Earlier images in the same chat must not be reused as the next result');
      assert.deepEqual(await readFile(job.images[0].path), output[index]);
      const image = parsed(await client.callTool({ name: 'get_image', arguments: { job_id: job.id, include_preview: false } }));
      assert.equal(image.path, job.images[0].path);
    }
    const closeDeadline = Date.now() + 5000;
    while (queue.isBusy() && Date.now() < closeDeadline) await delay(20);
    assert.equal(queue.isBusy(), false, 'Batch browser cleanup finishes');
    assert.ok(recorded);
    assert.equal(generationPage?.isClosed(), true, 'The batch browser closes after its final image');
    for (const submission of recorded.submissions) {
      if (aspectRatio !== undefined) assert.ok(submission.text.trimEnd().endsWith(`Output aspect ratio = ${aspectRatio}`));
      else assert.doesNotMatch(submission.text, /aspect ratio/i);
    }
    for (const job of batch.jobs) assert.equal(job.aspectRatio, aspectRatio);
    for (const upload of recorded.uploads) assert.equal(upload.bytes, reference.toString('base64'));
    if (scenario === 'same_chat') {
      assert.equal(new Set(batch.jobs.map((job: any) => job.conversationUrl)).size, 1);
      assert.equal(recorded.uploads.length, 1);
      assert.deepEqual(recorded.submissions.map((item: any) => item.prompt), ['one', 'two', 'three']);
      assert.match(recorded.submissions[1].text, /original reference images previously attached/);
    } else if (scenario === 'rollover' || scenario === 'preflight_rollover') {
      assert.equal(recorded.uploads.length, 2);
      assert.notEqual(batch.jobs[0].conversationUrl, batch.jobs[1].conversationUrl);
      assert.equal(batch.jobs[1].conversationUrl, batch.jobs[2].conversationUrl);
      assert.deepEqual(recorded.submissions.map((item: any) => item.prompt), scenario === 'rollover' ? ['one', 'two', 'two', 'three'] : ['one', 'two', 'three']);
      assert.match(recorded.submissions[scenario === 'rollover' ? 2 : 1].text, /attached reference images/);
    } else {
      assert.deepEqual(batch.jobs.map((job: any) => job.status), ['completed', 'failed', 'cancelled']);
      assert.match(batch.jobs[1].error, /usage limit/);
      assert.equal(recorded.uploads.length, 1);
      assert.deepEqual(recorded.submissions.map((item: any) => item.prompt), ['one', 'two']);
    }
  } finally {
    const stopped = queue.stop(); await browser.close(); await stopped;
    await client.close(); await server.close(); store.close(); await stopChrome(config);
    await new Promise<void>(resolve => fixture.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
