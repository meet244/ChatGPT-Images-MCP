import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, readFile, stat, readdir, rm, truncate } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { stageReferences } from '../src/references.js';
import { JobStore } from '../src/store.js';

test('reference snapshots preserve validated bytes, private permissions, and queued jobs across restart', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'images-references-'));
  let store = new JobStore(dir);
  try {
    const png = await sharp({ create: { width: 300, height: 200, channels: 3, background: '#aa5500' } }).png().toBuffer();
    const jpeg = await sharp(png).jpeg().toBuffer();
    const sources = [path.join(dir, 'input.png'), path.join(dir, 'input.jpg')];
    await writeFile(sources[0]!, png); await writeFile(sources[1]!, jpeg);
    const references = await stageReferences(dir, sources);
    assert.equal(references.length, 2);
    for (const [index, expected] of [png, jpeg].entries()) {
      assert.deepEqual(await readFile(references[index]!.path), expected);
      assert.equal((await stat(references[index]!.path)).mode & 0o777, 0o600);
      assert.equal((await stat(path.dirname(references[index]!.path))).mode & 0o777, 0o700);
      await rm(sources[index]!);
    }
    const job = store.create('Use both references', references);
    store.close(); store = new JobStore(dir);
    assert.equal(store.get(job.id).status, 'queued');
    assert.deepEqual(store.get(job.id).referenceImages, references);
    assert.deepEqual(await readFile(store.get(job.id).referenceImages![0]!.path), png);
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});

test('invalid references are rejected before upload and partial snapshots are removed', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'images-invalid-references-'));
  try {
    const valid = path.join(dir, 'valid.png');
    const invalid = path.join(dir, 'not-an-image.png');
    const large = path.join(dir, 'large.png');
    await writeFile(valid, await sharp({ create: { width: 300, height: 200, channels: 3, background: '#fff' } }).png().toBuffer());
    await writeFile(invalid, 'This file is not an image.');
    await writeFile(large, ''); await truncate(large, 20 * 1024 * 1024 + 1);
    await assert.rejects(stageReferences(dir, ['relative.png']), /absolute local/);
    await assert.rejects(stageReferences(dir, [large]), /at most 20 MB/);
    await assert.rejects(stageReferences(dir, [dir]), /could not be read/);
    await assert.rejects(stageReferences(dir, [valid, valid, valid, valid, valid]), /at most 4/);
    await assert.rejects(stageReferences(dir, [valid, invalid]), /readable, static PNG/);
    assert.deepEqual(await readdir(path.join(dir, 'references')), []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
