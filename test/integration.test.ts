import './support/headless.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer as createHttpServer } from 'node:http';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import lockfile from 'proper-lockfile';
import { chromium, webkit } from 'playwright';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { loadConfig, projectRoot } from '../src/config.js';
import { ChatGPTBrowser, TextOnlyResponseError } from '../src/browser.js';
import { JobStore, imageCooldownMs } from '../src/store.js';
import { JobQueue } from '../src/queue.js';
import { createServer } from '../src/server.js';
import { saveCookies } from '../src/session-store.js';
import { connectChrome, runningChrome, stopChrome } from '../src/chrome.js';

function parseResult(result: any): any {
  assert.equal(result.isError, undefined, JSON.stringify(result.content));
  return JSON.parse(result.content.find((item: any) => item.type === 'text').text);
}

test('MCP accepts more requests during generation and runs them in submission order', { timeout: 10_000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'images-mcp-queue-'));
  const store = new JobStore(dir);
  const browser = new ChatGPTBrowser(loadConfig({ CHATGPT_DATA_DIR: dir }));
  const calls: string[] = [];
  const referencePath = path.join(dir, 'reference.png');
  const referenceBytes = await sharp({ create: { width: 300, height: 200, channels: 3, background: '#ef5500' } }).png().toBuffer();
  await writeFile(referencePath, referenceBytes);
  let receivedReferences: import('../src/store.js').ImageArtifact[] = [];
  let releaseFirst!: () => void;
  let releaseSecond!: () => void;
  const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
  const secondGate = new Promise<void>(resolve => { releaseSecond = resolve; });
  let concurrent = 0;
  let maxConcurrent = 0;
  browser.generate = async (id, prompt, submitted, references = []) => {
    calls.push(prompt);
    maxConcurrent = Math.max(maxConcurrent, ++concurrent);
    submitted(`https://chatgpt.com/c/${id}`);
    try {
      if (prompt === 'first') { receivedReferences = references; await firstGate; }
      if (prompt === 'second') await secondGate;
      return { conversationUrl: `https://chatgpt.com/c/${id}`, images: [] };
    } finally { concurrent--; }
  };
  const queue = new JobQueue(store, browser);
  const server = createServer(store, queue, browser);
  const client = new Client({ name: 'multiple-images-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const status = async (id: string) => parseResult(await client.callTool({ name: 'get_job_status', arguments: { job_id: id } }));
  try {
    await server.connect(serverTransport); await client.connect(clientTransport);
    const [first, second, third] = await Promise.all(['first', 'second', 'third'].map(async prompt =>
      parseResult(await client.callTool({ name: 'generate_image', arguments: { prompt,
        ...(prompt === 'first' ? { reference_images: [referencePath] } : {}) } }))));
    assert.equal(new Set([first.id, second.id, third.id]).size, 3);
    assert.equal((await status(first.id)).status, 'running');
    assert.equal((await status(second.id)).status, 'queued');
    assert.equal((await status(third.id)).status, 'queued');
    assert.deepEqual(calls, ['first'], 'Queued prompts must not reach the browser yet');
    assert.equal(receivedReferences.length, 1);
    assert.notEqual(receivedReferences[0]!.path, referencePath);
    await rm(referencePath);
    assert.deepEqual(await readFile(receivedReferences[0]!.path), referenceBytes);
    assert.equal(parseResult(await client.callTool({ name: 'session_status', arguments: {} })).status, 'busy');
    releaseFirst();
    let deadline = Date.now() + 3000;
    while ((await status(second.id)).status === 'queued' && Date.now() < deadline) await delay(10);
    assert.equal((await status(first.id)).status, 'completed');
    assert.equal((await status(second.id)).status, 'running');
    assert.equal((await status(third.id)).status, 'queued');
    assert.deepEqual(calls, ['first', 'second']);
    releaseSecond();
    deadline = Date.now() + 3000;
    while ((await status(third.id)).status !== 'completed' && Date.now() < deadline) await delay(10);
    assert.equal((await status(second.id)).status, 'completed');
    assert.equal((await status(third.id)).status, 'completed');
    assert.deepEqual(calls, ['first', 'second', 'third']);
    assert.equal(maxConcurrent, 1);
    const invalid = await client.callTool({ name: 'generate_image', arguments: { prompt: 'Invalid reference', reference_images: [referencePath] } });
    assert.equal(invalid.isError, true);
    assert.equal(store.list().length, 3, 'Invalid files must not create a job or reach the browser');
    assert.deepEqual(calls, ['first', 'second', 'third']);
  } finally {
    releaseFirst(); releaseSecond(); await queue.stop();
    await client.close(); await server.close(); store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('real stdio client initializes, lists tools, validates input, and shuts down', { timeout: 20_000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'images-stdio-'));
  const client = new Client({ name: 'test-client', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(projectRoot, 'dist/index.js'), 'serve'],
    cwd: os.tmpdir(), env: { CHATGPT_DATA_DIR: dir }, stderr: 'pipe' });
  let stderr = '';
  transport.stderr?.on('data', data => { stderr += data.toString(); });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map(tool => tool.name).sort(), ['add_account', 'cancel_job', 'generate_image', 'generate_images', 'get_batch_status', 'get_image', 'get_job_status', 'list_accounts', 'list_jobs', 'session_status', 'wait_for_job']);
    const batchSchema = tools.tools.find(tool => tool.name === 'generate_images')!.inputSchema;
    assert.equal(batchSchema.properties!.different_chat, undefined);
    assert.equal((batchSchema.properties!.same_chat_mandatory as any).type, 'boolean');
    assert.equal((batchSchema.properties!.same_chat_mandatory as any).default, false);
    assert.equal(batchSchema.required?.includes('same_chat_mandatory') ?? false, false);
    for (const tool of tools.tools) {
      if (tool.name !== 'add_account') assert.equal(tool.inputSchema.properties?.account, undefined);
    }
    assert.equal(batchSchema.properties!.chat_mode, undefined);
    for (const name of ['generate_image', 'generate_images']) {
      const schema = tools.tools.find(tool => tool.name === name)!.inputSchema;
      assert.equal((schema.properties!.aspect_ratio as any).type, 'string');
      assert.equal(Object.hasOwn(schema.properties!.aspect_ratio as object, 'default'), false);
      assert.equal(schema.required?.includes('aspect_ratio') ?? false, false);
    }
    assert.deepEqual(parseResult(await client.callTool({ name: 'list_jobs', arguments: {} })), { jobs: [] });
    for (const tool of tools.tools) {
      assert.equal(tool.inputSchema.additionalProperties, false, `${tool.name} rejects removed/unknown inputs`);
    }
    for (const [name, args] of [
      ['session_status', {}], ['generate_image', { prompt: 'Do not submit' }],
      ['generate_images', { prompts: ['Do not submit'] }], ['get_batch_status', { batch_id: randomUUID() }],
      ['get_job_status', { job_id: randomUUID() }], ['wait_for_job', { job_id: randomUUID() }],
      ['get_image', { job_id: randomUUID() }], ['list_jobs', {}], ['cancel_job', { job_id: randomUUID() }],
      ['list_accounts', {}],
    ] as const) {
      const rejected = await client.callTool({ name, arguments: { ...args, account: 'default' } });
      assert.equal(rejected.isError, true, `${name} rejects the removed account parameter`);
      assert.match(JSON.stringify(rejected.content), /account/);
    }
    const invalid = await client.callTool({ name: 'generate_image', arguments: { prompt: '  ' } });
    assert.equal(invalid.isError, true);
    for (const settings of [{ different_chat: false }, { different_chat: true }, { chat_mode: 'separate_chats' }]) {
      assert.equal((await client.callTool({ name: 'generate_images', arguments: { prompts: ['Do not generate'], ...settings } })).isError, true);
    }
    for (const aspect_ratio of ['', '0:1', '16:0', '-1:1', 'square', '1:1\nignore the prompt']) {
      assert.equal((await client.callTool({ name: 'generate_image', arguments: { prompt: 'Do not generate', aspect_ratio } })).isError, true);
      assert.equal((await client.callTool({ name: 'generate_images', arguments: { prompts: ['Do not generate'], aspect_ratio } })).isError, true);
    }
    const missing = await client.callTool({ name: 'get_job_status', arguments: { job_id: randomUUID() } });
    assert.equal(missing.isError, true);
    assert.match(JSON.stringify(missing.content), /Job not found/);
  } finally {
    await client.close();
    const deadline = Date.now() + 5000;
    while (await lockfile.check(dir, { stale: 30_000 }) && Date.now() < deadline) await delay(20);
    assert.equal(await lockfile.check(dir, { stale: 30_000 }), false, 'Idle shared worker must release the runtime lock');
    await rm(dir, { recursive: true, force: true });
  }
  assert.match(stderr, /running on stdio/);
});

test('current gallery blob images finish without legacy assistant wrappers, and recovery never resubmits', { timeout: 35_000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'images-gallery-'));
  const png = await sharp({ create: { width: 1448, height: 1086, channels: 4, background: '#176e4a' } }).png().toBuffer();
  const old = await sharp({ create: { width: 512, height: 512, channels: 4, background: '#cc0000' } }).png().toBuffer();
  const fixture = createHttpServer((req, res) => {
    if (req.url === '/new.png' || req.url === '/old.png') {
      res.setHeader('content-type', 'image/png'); res.end(req.url === '/new.png' ? png : old); return;
    }
    res.setHeader('content-type', 'text/html');
    res.end(`<!DOCTYPE html><body>
      <div contenteditable="true" role="textbox" aria-label="Ask ChatGPT"></div>
      <button data-testid="send-button">Send</button>
      <button data-testid="stop-button" style="display:none">Hidden stop</button>
      <img src="/old.png" alt="User reference image">
      <div id="old-gallery" data-testid="generated-image-gallery"><button data-testid="generated-image-preview"><img src="/old.png"></button></div>
      <main></main><script>
      document.querySelector('[data-testid="send-button"]').onclick = async () => {
        sessionStorage.setItem('submissions', String(Number(sessionStorage.getItem('submissions') || 0) + 1));
        history.pushState({}, '', '/c/gallery-conversation');
        document.querySelector('main').innerHTML = '<div data-chatgpt-search-message-ids="fixture-message"><div data-testid="generated-image-gallery"><button data-testid="generated-image-preview" aria-label="Generated image 1"><img alt="Generated image 1"></button></div></div><button id="active-stop" data-testid="stop-button">Stop generating</button>';
        const blob = await (await fetch('/new.png')).blob();
        const url = URL.createObjectURL(blob);
        document.querySelector('main img').src = url;
        // A duplicate hidden responsive preview must not duplicate the saved image.
        const hidden = document.createElement('img'); hidden.src = url; hidden.style.display = 'none';
        document.querySelector('main [data-testid="generated-image-preview"]').append(hidden);
        setTimeout(() => {document.querySelector('#active-stop').remove(); sessionStorage.setItem('streamFinished', 'yes');}, 2800);
      };</script></body>`);
  });
  await new Promise<void>(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(fixture.address() as { port: number }).port}/`;
  const config = loadConfig({ CHATGPT_DATA_DIR: dir, CHATGPT_POLL_MS: '100', CHATGPT_TIMEOUT_MS: '10000' });
  const browser = new ChatGPTBrowser(config, { baseUrl });
  const store = new JobStore(dir);
  const queue = new JobQueue(store, browser);
  const server = createServer(store, queue, browser);
  const client = new Client({ name: 'gallery-test', version: '1' });
  await saveCookies(dir, [{ name: '__Secure-next-auth.session-token', value: 'fixture-session', domain: '.chatgpt.com', path: '/', expires: -1, secure: true, httpOnly: true }]);
  // This adapter test recovers an ephemeral blob URL from the still-live fixture page.
  // Automatic shutdown and reopening are covered by the complete generation flow below.
  queue.setIdleHandler(async () => {});
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  let observer;
  try {
    await server.connect(serverTransport); await client.connect(clientTransport);
    // Initialize this live adapter fixture explicitly; MCP status now stays offline.
    assert.equal((await browser.sessionStatus()).status, 'ready');
    assert.equal(parseResult(await client.callTool({ name: 'session_status', arguments: {} })).status, 'ready');
    const job = parseResult(await client.callTool({ name: 'generate_image', arguments: { prompt: 'A green landscape' } }));
    let status = job;
    const deadline = Date.now() + 12_000;
    while (['queued', 'running'].includes(status.status) && Date.now() < deadline) {
      await delay(100); status = parseResult(await client.callTool({ name: 'get_job_status', arguments: { job_id: job.id } }));
    }
    assert.equal(status.status, 'completed', JSON.stringify(status));
    assert.equal(store.get(status.id).images!.length, 1, 'Previous galleries and reference uploads are excluded');
    assert.deepEqual(await readFile(store.get(status.id).images![0]!.path), png);
    observer = await connectChrome(config);
    const page = observer.contexts()[0]!.pages()[0]!;
    assert.equal(await page.locator(config.selectors.assistant).count(), 0);
    assert.equal(await page.evaluate(() => sessionStorage.getItem('streamFinished')), 'yes', 'Hidden stop controls must not mask active streaming');
    await page.locator('#old-gallery').evaluate(el => el.remove());
    const recovered = await browser.recover(randomUUID(), store.get(status.id).conversationUrl!);
    assert.equal(recovered.images.length, 1);
    assert.deepEqual(await readFile(recovered.images[0]!.path), png);
    assert.equal(await page.evaluate(() => sessionStorage.getItem('submissions')), '1', 'Recovery must not send another prompt');
  } finally {
    await observer?.close();
    const stopped = queue.stop(); await browser.close(); await stopped;
    await client.close(); store.close(); await stopChrome(config);
    await new Promise<void>(resolve => fixture.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

test('new image result cards complete shared-chat jobs and exclude older cards and decorative copies', { timeout: 35_000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'images-result-cards-'));
  const originals = await Promise.all(['#176e4a', '#184ab2'].map(background =>
    sharp({ create: { width: 1086, height: 1448, channels: 3, background } }).png().toBuffer()));
  const old = await sharp({ create: { width: 512, height: 512, channels: 3, background: '#cc0000' } }).png().toBuffer();
  const fixture = createHttpServer((req, res) => {
    if (req.url?.startsWith('/content')) {
      res.setHeader('content-type', 'image/png');
      res.end(originals[Number(new URL(req.url, 'http://localhost').searchParams.get('n')) - 1] ?? old); return;
    }
    res.setHeader('content-type', 'text/html');
    res.end(`<!DOCTYPE html><body>
      <div contenteditable="true" role="textbox"></div><button data-testid="send-button">Send</button>
      <img src="/content?n=0" alt="User reference">
      <div data-image-gen-result id="old-card"><img src="/content?n=0" alt="Generated image: Previous"></div>
      <main></main><script>
      let submissions = 0;
      document.querySelector('[data-testid="send-button"]').onclick = () => {
        const n = ++submissions;
        history.pushState({}, '', '/c/result-cards');
        // The second card tests the descriptive-alt fallback without a result wrapper.
        document.querySelector('main').insertAdjacentHTML('beforeend',
          '<div id="card-'+n+'" '+(n===1?'data-image-gen-result':'')+'><img src="/content?n='+n+'" alt="Generated image: New '+n+'">'+
          '<img src="/content?n=blur" alt="" aria-hidden="true"><div data-testid="image-gen-overlay-actions">Edit</div></div>'+
          '<button id="active-stop" data-testid="stop-button">Stop generating</button>');
        setTimeout(() => document.querySelector('#active-stop').remove(), 2800);
      };</script></body>`);
  });
  await new Promise<void>(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(fixture.address() as { port: number }).port}/`;
  const config = loadConfig({ CHATGPT_DATA_DIR: dir, CHATGPT_POLL_MS: '100', CHATGPT_TIMEOUT_MS: '10000' });
  const browser = new ChatGPTBrowser(config, { baseUrl });
  const store = new JobStore(dir);
  const queue = new JobQueue(store, browser);
  // Preserve this fixture's DOM while exercising recovery of its existing image cards.
  queue.setIdleHandler(async () => {});
  let observer;
  try {
    await browser.open();
    const batch = await queue.enqueueBatch(['First portrait', 'Second portrait'], 'same_chat');
    const deadline = Date.now() + 18_000;
    while (['queued', 'running'].includes(store.getBatch(batch.id).status) && Date.now() < deadline) await delay(100);
    const finished = store.getBatch(batch.id);
    assert.equal(finished.status, 'completed', JSON.stringify(finished));
    for (const [index, job] of finished.jobs.entries()) {
      assert.equal(job.images!.length, 1, 'Ignore references, old results, and aria-hidden decorative layers');
      assert.deepEqual(await readFile(job.images![0]!.path), originals[index]);
    }
    observer = await connectChrome(config);
    const page = observer.contexts()[0]!.pages()[0]!;
    assert.equal(await page.locator('#active-stop').count(), 0, 'Do not finish while streaming');
    await page.locator('#old-card, #card-1').evaluateAll(elements => elements.forEach(element => element.remove()));
    const recovered = await browser.recover(randomUUID(), finished.jobs[1]!.conversationUrl!);
    assert.equal(recovered.images.length, 1);
    assert.deepEqual(await readFile(recovered.images[0]!.path), originals[1]);
  } finally {
    await observer?.close();
    const stopped = queue.stop(); await browser.close(); await stopped; store.close();
    await stopChrome(config);
    await new Promise<void>(resolve => fixture.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

for (const mode of ['playwright', 'cdp', 'webkit'] as const) test(`MCP → queue → ${mode} browser UI → downloaded image → MCP preview`, { timeout: 45_000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'images-browser-'));
  const png = await sharp({ create: { width: 512, height: 512, channels: 4, background: '#635bff' } }).png().toBuffer();
  const reference = await sharp({ create: { width: 300, height: 200, channels: 3, background: '#ff5500' } }).png().toBuffer();
  const secondReference = await sharp(reference).jpeg().toBuffer();
  const referencePaths = [path.join(dir, 'reference.png'), path.join(dir, 'second.jpg')];
  await writeFile(referencePaths[0]!, reference); await writeFile(referencePaths[1]!, secondReference);
  const requests: string[] = [];
  const fixture = createHttpServer((req, res) => {
    requests.push(req.url!);
    if (req.url === '/image.png') { res.writeHead(200, { 'content-type': 'image/png' }); res.end(png); return; }
    if (req.url === '/reference.png') { res.writeHead(200, { 'content-type': 'image/png' }); res.end(reference); return; }
    res.setHeader('content-type', 'text/html');
    if (req.url === '/login') { res.end('<button>Log in</button><textarea id="prompt-textarea"></textarea>'); return; }
    if (req.url === '/challenge') { res.end('<h1>Verify you are human</h1>'); return; }
    if (req.url === '/challenge-title') { res.end('<title>Just a moment...</title><body></body>'); return; }
    if (req.url === '/upload-failure') {
      res.end(`<div contenteditable="true" role="textbox"></div><input type="file" accept="image/*" multiple hidden><button aria-label="Send">Send</button><div role="alert"></div><script>
        document.querySelector('input').onchange = () => {document.querySelector('[role="alert"]').textContent = 'File upload failed';};
        document.querySelector('button').onclick = () => {sessionStorage.setItem('unexpectedReferenceSubmission', 'yes');};
      </script>`); return;
    }
    res.end(`<!DOCTYPE html><body><div contenteditable="true" role="textbox" style="display:none"></div><div contenteditable="true" role="textbox" aria-label="Ask ChatGPT" data-composer-markdown></div><button data-testid="send-button" style="display:none">Hidden send</button><button data-testid="send-button">Send</button><button aria-busy="true">Loading unrelated profile</button><input type="file" accept="application/pdf" hidden><input type="file" accept="image/*" multiple hidden><div id="attachments"><span class="composer-attachment-surface" id="old-draft"><img src="/reference.png" alt="old-draft.png"><button aria-label="Remove old-draft.png" style="opacity:0;pointer-events:none">Remove</button></span></div><main></main>
      <script>document.querySelector('button').onclick = () => {
        throw new Error('Hidden send must not be clicked');
      };
      document.querySelector('#old-draft button').onclick = () => {document.querySelector('#old-draft').remove(); sessionStorage.setItem('oldDraftRemoved', 'yes');};
      document.querySelector('input[accept="image/*"]').onchange = async event => {
        const files = [...event.target.files];
        const uploaded = [];
        for (const file of files) {
          const bytes = await new Promise(resolve => { const reader = new FileReader(); reader.onload = () => resolve(reader.result.split(',')[1]); reader.readAsDataURL(file); });
          uploaded.push({name:file.name,bytes});
          const surface = document.createElement('span'); surface.className = 'composer-attachment-surface';
          const preview = document.createElement('img'); preview.alt = file.name.replace(/(\.[^.]+)$/, '(2)$1'); preview.src = URL.createObjectURL(file); surface.append(preview);
          const progress = document.createElement('span'); progress.setAttribute('role', 'progressbar'); progress.setAttribute('aria-label', 'Uploading ' + file.name); progress.setAttribute('aria-valuenow','100'); progress.textContent='Finishing upload'; surface.append(progress);
          document.querySelector('#attachments').append(surface);
        }
        sessionStorage.setItem('uploadedFiles', JSON.stringify(uploaded));
        setTimeout(() => {
          document.querySelectorAll('[role="progressbar"]').forEach(el => el.remove());
          sessionStorage.setItem('uploadFinished', 'yes');
        }, 1100);
      };
      document.querySelectorAll('button')[1].onclick = () => {
        if (sessionStorage.getItem('uploadFinished') !== 'yes') throw new Error('Prompt sent before references finished uploading');
        sessionStorage.setItem('submitted', document.querySelector('[aria-label="Ask ChatGPT"]').innerText);
        history.pushState({}, '', '/c/fixture-conversation');
        document.querySelector('main').innerHTML = '<div data-message-author-role="user"><img src="/reference.png"></div><article data-turn="assistant"><div data-message-author-role="assistant">Creating image<img src="/image.png"></div></article><button data-testid="stop-button">Stop generating</button>';
        setTimeout(() => document.querySelector('[data-testid="stop-button"]').remove(), 300);
      };</script></body>`);
  });
  await new Promise<void>(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const address = fixture.address() as { port: number };
  const baseUrl = `http://127.0.0.1:${address.port}/`;
  const config = loadConfig({ CHATGPT_BROWSER_MODE: mode, CHATGPT_DATA_DIR: dir, CHATGPT_POLL_MS: '100', CHATGPT_TIMEOUT_MS: '10000' });
  const browser = new ChatGPTBrowser(config, { baseUrl });
  const store = new JobStore(dir);
  const queue = new JobQueue(store, browser);
  const server = createServer(store, queue, browser);
  const client = new Client({ name: 'test-client', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const cookieFile = path.join(dir, 'cookies.json');
    await writeFile(cookieFile, JSON.stringify([{ name: 'fixture-session', value: 'fixture-secret', domain: '.chatgpt.com', path: '/', secure: true, httpOnly: true, expires: Date.now() / 1000 + 3600 }]));
    assert.equal(await browser.importCookies(cookieFile), 1);
    await saveCookies(dir, [{ name: '__Secure-next-auth.session-token', value: 'fixture-session', domain: '.chatgpt.com', path: '/', expires: -1, secure: true, httpOnly: true }]);
    if (mode !== 'webkit') {
      assert.match(await (await browser.open()).evaluate(() => navigator.userAgent), /HeadlessChrome/, 'Chromium integration fixtures always run headlessly');
    }
    assert.equal(parseResult(await client.callTool({ name: 'session_status', arguments: {} })).status, 'ready');
    let audit: { submitted: string | null; uploadedFiles: string | null; uploadFinished: string | null; oldDraftRemoved: string | null } | undefined;
    let generationPage: Awaited<ReturnType<ChatGPTBrowser['open']>> | undefined;
    const shutdown = browser.shutdown.bind(browser);
    browser.shutdown = async () => {
      generationPage = await browser.open();
      audit = await generationPage.evaluate(() => ({
        submitted: sessionStorage.getItem('submitted'), uploadedFiles: sessionStorage.getItem('uploadedFiles'),
        uploadFinished: sessionStorage.getItem('uploadFinished'), oldDraftRemoved: sessionStorage.getItem('oldDraftRemoved'),
      }));
      await shutdown();
    };
    const aspectRatio = mode === 'playwright' ? '1:1' : mode === 'cdp' ? '16:9' : undefined;
    const job = parseResult(await client.callTool({ name: 'generate_image', arguments: { prompt: 'A purple square', reference_images: referencePaths,
      ...(aspectRatio !== undefined ? { aspect_ratio: ` ${aspectRatio.replace(':', ' : ')} ` } : {}) } }));
    assert.equal(store.get(job.id).aspectRatio, aspectRatio);
    assert.equal(store.get(job.id).referenceImages!.length, 2);
    for (const source of referencePaths) await rm(source);
    let status = job;
    const deadline = Date.now() + 12_000;
    while (['queued', 'running'].includes(status.status) && Date.now() < deadline) {
      await delay(100);
      status = parseResult(await client.callTool({ name: 'get_job_status', arguments: { job_id: job.id } }));
    }
    assert.equal(status.status, 'completed', JSON.stringify(status));
    const closeDeadline = Date.now() + 5000;
    while (queue.isBusy() && Date.now() < closeDeadline) await delay(20);
    assert.equal(queue.isBusy(), false, 'Idle browser cleanup finishes');
    assert.equal(generationPage?.isClosed(), true, 'The completed generation closes its browser');
    assert.ok(audit);
    const submitted = audit.submitted;
    assert.ok(submitted);
    // Browser engines represent contenteditable line breaks differently; preserve the prompt's text.
    assert.equal(submitted.replace(/\s+/g, ' ').trim(), "Create a new image using the attached reference images and this description. Generate the image itself using ChatGPT's image creation feature. A purple square"
      + (aspectRatio !== undefined ? ` Output aspect ratio = ${aspectRatio}` : ''));
    if (aspectRatio !== undefined) assert.ok(submitted.trimEnd().endsWith(`Output aspect ratio = ${aspectRatio}`));
    else assert.doesNotMatch(submitted, /aspect ratio/i);
    assert.deepEqual(JSON.parse(audit.uploadedFiles!), [
      { name: '1.png', bytes: reference.toString('base64') }, { name: '2.jpg', bytes: secondReference.toString('base64') },
    ]);
    assert.equal(audit.uploadFinished, 'yes');
    assert.equal(audit.oldDraftRemoved, 'yes');
    assert.equal(store.get(status.id).images!.length, 1, 'Nested assistant containers should not duplicate images');
    assert.equal(store.get(status.id).conversationUrl!, `${baseUrl}c/fixture-conversation`);
    assert.deepEqual(await readFile(store.get(status.id).images![0]!.path), png);
    const image = await client.callTool({ name: 'get_image', arguments: { job_id: job.id } });
    assert.equal(image.isError, undefined);
    const preview = (image.content as any[]).find(item => item.type === 'image');
    assert.equal(preview.mimeType, 'image/png');
    assert.equal((await sharp(Buffer.from(preview.data, 'base64')).metadata()).width, 512);
    assert.ok(requests.includes('/image.png'));
    await browser.close();
    if (mode === 'cdp') {
      assert.equal(await runningChrome(config), undefined, 'Completed image work fully closes dedicated Chrome');
      const connection = await connectChrome(config);
      try { assert.equal((await connection.contexts()[0]!.cookies('https://chatgpt.com')).find(cookie => cookie.name === 'fixture-session')?.value, 'fixture-secret'); }
      finally { await connection.close(); }
    } else {
      const engine = mode === 'webkit' ? webkit : chromium;
      const profile = await engine.launchPersistentContext(path.join(dir, mode === 'webkit' ? 'webkit-profile' : 'browser-profile'), { headless: config.headless });
      try { assert.equal((await profile.cookies('https://chatgpt.com')).find(cookie => cookie.name === 'fixture-session')?.value, 'fixture-secret'); }
      finally { await profile.close(); }
    }
    const uploadFailure = new ChatGPTBrowser(config, { baseUrl: `${baseUrl}upload-failure` });
    try {
      await assert.rejects(uploadFailure.generate(randomUUID(), 'Do not submit', () => {}, store.get(job.id).referenceImages!), /rejected a reference image upload.*No prompt was submitted/);
      assert.equal(await (await uploadFailure.open()).evaluate(() => sessionStorage.getItem('unexpectedReferenceSubmission')), null);
    } finally { await uploadFailure.close(); }
    for (const [route, expected] of [['login', 'login_required'], ['challenge', 'challenge'], ['challenge-title', 'challenge']]) {
      const alternate = new ChatGPTBrowser(config, { baseUrl: `${baseUrl}${route}` });
      try {
        assert.equal((await alternate.sessionStatus()).status, expected);
        await assert.rejects(alternate.generate(randomUUID(), 'Do not submit', () => {}), /signed in|verification/);
      } finally { await alternate.close(); }
    }
  } finally {
    const stopped = queue.stop();
    await browser.close();
    await stopped;
    await client.close();
    await server.close();
    store.close();
    if (mode === 'cdp') await stopChrome(config);
    await new Promise<void>((resolve, reject) => fixture.close(error => error ? reject(error) : resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

test('browser reports a completed text-only reply as a distinct generation failure', { timeout: 30_000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'images-text-only-browser-'));
  const fixture = createHttpServer((_req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(`<!DOCTYPE html><body><div contenteditable="true" role="textbox"></div><button data-testid="send-button">Send</button><main></main>
      <script>document.querySelector('button').onclick=()=>{
        document.querySelector('[role=textbox]').textContent='';
        history.pushState({},'', '/c/text-only');
        document.querySelector('main').innerHTML='<article data-turn="assistant">Here is a description instead of a picture.</article>';
      };</script>`);
  });
  await new Promise<void>(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(fixture.address() as { port: number }).port}/`;
  const browser = new ChatGPTBrowser(loadConfig({ CHATGPT_DATA_DIR: dir, CHATGPT_BROWSER_MODE: 'playwright',
    CHATGPT_HEADLESS: 'true', CHATGPT_POLL_MS: '100', CHATGPT_TIMEOUT_MS: '20000' }), { baseUrl });
  let submitted = false;
  try {
    await assert.rejects(browser.generate(randomUUID(), 'Make a cafe portrait', () => { submitted = true; }),
      error => error instanceof TextOnlyResponseError && error.code === undefined);
    assert.equal(submitted, true);
  } finally {
    await browser.close();
    await new Promise<void>(resolve => fixture.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

test('two assistant rate-limit replies mentioning image generation exhaust the same profile for 24 hours', { timeout: 40_000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'images-text-limit-replies-'));
  const reply = 'I’m unable to generate the image right now because image generation is temporarily rate-limited. Please try again in about an hour.';
  const fixture = createHttpServer((_req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(`<!DOCTYPE html><body><div contenteditable="true" role="textbox"></div><button data-testid="send-button">Send</button><main></main>
      <script>document.querySelector('button').onclick=()=>{
        document.querySelector('[role=textbox]').textContent='';
        history.pushState({},'', '/c/rate-limit-text');
        const message = document.createElement('article'); message.dataset.turn = 'assistant';
        message.textContent = ${JSON.stringify(reply)}; document.querySelector('main').append(message);
      };</script>`);
  });
  await new Promise<void>(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(fixture.address() as { port: number }).port}/`;
  const browser = new ChatGPTBrowser(loadConfig({ CHATGPT_DATA_DIR: dir, CHATGPT_BROWSER_MODE: 'playwright',
    CHATGPT_HEADLESS: 'true', CHATGPT_POLL_MS: '100', CHATGPT_TIMEOUT_MS: '15000' }), { baseUrl });
  const store = new JobStore(dir);
  let queue = new JobQueue(store, browser);
  try {
    for (const attempt of [1, 2]) {
      if (attempt === 2) queue = new JobQueue(store, browser);
      const job = queue.enqueue(`Portrait attempt ${attempt}`);
      await queue.stop();
      const result = store.get(job.id);
      assert.equal(result.status, 'failed');
      assert.doesNotMatch(result.error!, /Timed out/);
      if (attempt === 1) {
        assert.equal(result.errorCode, undefined);
        assert.equal(store.imageCooldown(), undefined);
      } else {
        const cooldown = store.imageCooldown()!;
        assert.equal(result.errorCode, 'image_usage_limit');
        assert.equal(Date.parse(cooldown.retryAfter) - Date.parse(cooldown.detectedAt), imageCooldownMs);
        assert.match(cooldown.error, /two consecutive.*text-only/);
      }
    }
    queue = new JobQueue(store, browser);
    assert.throws(() => queue.enqueue('skip exhausted profile'), /24-hour cooldown/);
    assert.equal(store.list().length, 2);
  } finally {
    await queue.stop(); await browser.close(); store.close();
    await new Promise<void>(resolve => fixture.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
