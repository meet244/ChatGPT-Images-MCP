import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { open, mkdir, writeFile, chmod, rm, readdir, stat } from 'node:fs/promises';
import sharp from 'sharp';
import type { ImageArtifact, JobStore } from './store.js';

export const maxReferenceImages = 4;
const maxBytes = 20 * 1024 * 1024;
const formats: Record<string, [string, string]> = {
  png: ['png', 'image/png'], jpeg: ['jpg', 'image/jpeg'], webp: ['webp', 'image/webp'],
};

/** Snapshot references before queue admission so later edits cannot change the request. */
export async function stageReferences(dataDir: string, paths: string[]): Promise<ImageArtifact[]> {
  if (!paths.length) return [];
  if (paths.length > maxReferenceImages) throw new Error(`Pass at most ${maxReferenceImages} reference images.`);
  const directory = path.join(dataDir, 'references', randomUUID());
  const images: ImageArtifact[] = [];
  try {
    for (const [index, source] of paths.entries()) {
      if (!path.isAbsolute(source)) throw new Error(`Reference image ${index + 1} requires an absolute local file path.`);
      let bytes: Buffer;
      try {
        const file = await open(source, 'r');
        try {
          const stat = await file.stat();
          if (!stat.isFile() || !stat.size || stat.size > maxBytes) throw new Error('Invalid reference size');
          // Bound the read even if the source grows after stat().
          const buffer = Buffer.alloc(Math.min(stat.size + 1, maxBytes + 1));
          let length = 0;
          while (length < buffer.length) {
            const read = await file.read(buffer, length, buffer.length - length, null);
            if (!read.bytesRead) break;
            length += read.bytesRead;
          }
          if (!length || length > stat.size || length > maxBytes) throw new Error('Reference changed or exceeded size limit');
          bytes = buffer.subarray(0, length);
        } finally { await file.close(); }
      } catch { throw new Error(`Reference image ${index + 1} could not be read. Use an existing local image file of at most 20 MB.`); }
      let format: [string, string];
      try {
        const image = sharp(bytes, { limitInputPixels: 40_000_000 });
        const metadata = await image.metadata();
        const supported = formats[metadata.format ?? ''];
        if (!supported || !metadata.width || !metadata.height || (metadata.pages ?? 1) > 1) throw new Error('Unsupported reference');
        await image.stats(); // Decode the image; a header alone is insufficient validation.
        format = supported;
      } catch { throw new Error(`Reference image ${index + 1} must be a readable, static PNG, JPEG, or WebP image of at most 40 megapixels.`); }
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const destination = path.join(directory, `${index + 1}.${format[0]}`);
      await writeFile(destination, bytes, { mode: 0o600 });
      await chmod(destination, 0o600);
      images.push({ path: destination, mimeType: format[1], bytes: bytes.length });
    }
    return images;
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export async function discardReferences(images: ImageArtifact[]): Promise<void> {
  if (images[0]) await rm(path.dirname(images[0].path), { recursive: true, force: true });
}

/** Reference copies are kept while a queued or running job may still upload them (retries, failover, batch restarts). */
export const referenceGraceMs = 10 * 60 * 1000;

/**
 * Delete reference copies that no queued or running job uses. Copies younger than the grace period
 * are kept, so a request that is still being admitted can never lose its files.
 */
export async function pruneReferences(store: Pick<JobStore, 'dataDir' | 'byStatus'>, graceMs = referenceGraceMs, now = Date.now(), dryRun = false): Promise<{ removed: number; bytes: number }> {
  const root = path.join(store.dataDir, 'references');
  let entries: string[];
  try { entries = await readdir(root); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { removed: 0, bytes: 0 }; throw error; }
  const inUse = new Set([...store.byStatus('queued'), ...store.byStatus('running')]
    .flatMap(job => (job.referenceImages ?? []).map(image => path.resolve(path.dirname(image.path)))));
  let removed = 0, bytes = 0;
  for (const name of entries) {
    const directory = path.resolve(root, name);
    if (inUse.has(directory)) continue;
    try {
      const info = await stat(directory);
      if (!info.isDirectory() || now - info.mtimeMs < graceMs) continue;
      for (const file of await readdir(directory)) bytes += (await stat(path.join(directory, file))).size;
      if (!dryRun) await rm(directory, { recursive: true, force: true });
      removed++;
    } catch { /* Skip entries that disappear or cannot be read. */ }
  }
  return { removed, bytes };
}
