import '../test/support/headless.mjs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import sharp from 'sharp';
import lockfile from 'proper-lockfile';
import { loadConfig, projectRoot } from '../dist/config.js';
import { AccountRegistry } from '../dist/accounts.js';
import { acquireRuntime } from '../dist/runtime.js';
import { stopChrome } from '../dist/chrome.js';

class LiveTestError extends Error {}

const { values } = parseArgs({ options: { prompt: { type: 'string' }, reference: { type: 'string', multiple: true } } });
const prompt = values.prompt?.trim() || 'A small watercolor fox sitting under an oak tree, soft green background, square composition.';
if (prompt.length > 16_000) throw new LiveTestError('The prompt must be at most 16000 characters.');
const config = loadConfig();
const client = new Client({ name: 'chatgpt-images-live-test', version: '1' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(projectRoot, 'dist/index.js'), 'serve'],
  cwd: projectRoot,
  env: Object.fromEntries(Object.entries(process.env).filter(([key, value]) => key.startsWith('CHATGPT_') && typeof value === 'string')),
  stderr: 'inherit',
});

async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content?.filter(item => item.type === 'text').map(item => item.text).join('\n');
  if (result.isError) throw new LiveTestError(text || `${name} failed.`);
  try { return JSON.parse(text); }
  catch { throw new LiveTestError(`${name} returned an unexpected response.`); }
}

for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  console.error('Stopping the test. Check the printed job ID before submitting another image request.');
  void client.close().finally(() => process.exit(130));
});

try {
  const active = await lockfile.check(config.dataDir, { stale: 30_000 }).catch(error => {
    if (error.code === 'ENOENT') return false;
    throw new LiveTestError('Could not check the running server. Check the project data directory before testing.');
  });
  if (active) throw new LiveTestError('A server is already running. Disconnect MCP clients or stop npm start, then run npm run test:live again.');
  // An already-open visible profile would bypass the test-only headless launcher.
  // Close only our dedicated profiles before the test worker reopens them headlessly.
  const registry = new AccountRegistry(config);
  for (const account of await registry.names()) {
    const accountConfig = await registry.require(account);
    const release = await acquireRuntime(accountConfig);
    try { await stopChrome(accountConfig); }
    finally { await release(); }
  }
  console.error('Connecting to the MCP server for a headless live test.');
  await client.connect(transport);
  const session = await call('session_status');
  if (session.status !== 'ready') throw new LiveTestError(`Session is ${session.status}: ${session.message}`);
  console.log('ChatGPT session is ready. Requesting one test image.');
  const job = await call('generate_image', { prompt, ...(values.reference ? { reference_images: values.reference } : {}) });
  console.log(`Job ID: ${job.id}`);
  const deadline = Date.now() + config.timeoutMs + 90_000;
  let status = job;
  let lastStatus;
  while (['queued', 'running'].includes(status.status)) {
    if (status.status !== lastStatus) { console.log(`Status: ${status.status}`); lastStatus = status.status; }
    if (Date.now() > deadline) throw new LiveTestError(`Test timed out. Check job ${job.id} and its ChatGPT conversation before submitting again.`);
    status = await call('wait_for_job', { job_id: job.id });
  }
  if (status.status !== 'completed') throw new LiveTestError(`Job ${job.id} ${status.status}: ${status.error || 'Check its ChatGPT conversation.'}`);
  const image = await call('get_image', { job_id: job.id, include_preview: false });
  const metadata = await sharp(image.path).metadata();
  if (!metadata.width || !metadata.height) throw new LiveTestError('The saved result is not a readable image.');
  console.log(`Image saved: ${image.path}`);
  console.log(`Image size: ${metadata.width} × ${metadata.height}`);
  console.log('Live MCP image test passed.');
} catch (error) {
  console.error(error instanceof LiveTestError ? error.message : 'MCP test failed. Check the server diagnostics above; no automatic retry was made.');
  process.exitCode = 1;
} finally { await client.close(); }
