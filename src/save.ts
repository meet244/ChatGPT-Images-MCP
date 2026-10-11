import path from 'node:path';
import { copyFile, constants, mkdir, stat, writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import type { ImageArtifact } from './store.js';

const formats: Record<string, 'png' | 'jpeg' | 'webp'> = { '.png': 'png', '.jpg': 'jpeg', '.jpeg': 'jpeg', '.webp': 'webp' };
const extensionFor: Record<string, string> = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' };

/**
 * Copy a generated image to a path the caller chooses, such as a project's public folder.
 * A directory target gets `<job-id>-<n>.<ext>`. A file target's extension picks the format
 * (converting when it differs). Existing files are kept unless overwrite is set.
 */
export async function saveImageCopy(image: ImageArtifact, jobId: string, imageIndex: number, target: string, overwrite = false): Promise<{ path: string; bytes: number }> {
  if (!path.isAbsolute(target)) throw new Error('Use an absolute path for path.');
  let destination = path.resolve(target);
  const isDirectory = await stat(destination).then(info => info.isDirectory(), () => false);
  const sourceExtension = extensionFor[image.mimeType] ?? path.extname(image.path);
  if (isDirectory) destination = path.join(destination, `${jobId}-${imageIndex + 1}${sourceExtension}`);
  const extension = path.extname(destination).toLowerCase();
  const format = formats[extension];
  if (!format) throw new Error('Save as .png, .jpg, .jpeg or .webp, or pass an existing folder.');
  await mkdir(path.dirname(destination), { recursive: true });
  try {
    if (formats[sourceExtension] === format) {
      await copyFile(image.path, destination, overwrite ? 0 : constants.COPYFILE_EXCL);
    } else {
      let converted: Buffer;
      try { converted = await sharp(image.path).toFormat(format).toBuffer(); }
      catch { throw new Error('Saved image cannot be read. It may have been moved or deleted.'); }
      await writeFile(destination, converted, { flag: overwrite ? 'w' : 'wx' });
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') throw new Error(`${destination} already exists. Choose another path or set overwrite to true.`);
    if (code === 'ENOENT') throw new Error('Saved image cannot be read. It may have been moved or deleted.');
    if (code === 'EACCES' || code === 'EPERM') throw new Error(`No permission to write ${destination}.`);
    throw error;
  }
  return { path: destination, bytes: (await stat(destination)).size };
}
