import { chmod, mkdir } from 'node:fs/promises';
import lockfile from 'proper-lockfile';
import type { Config } from './config.js';

export async function acquireRuntime(config: Config): Promise<() => Promise<void>> {
  await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  await chmod(config.dataDir, 0o700);
  try {
    return await lockfile.lock(config.dataDir, { stale: 30_000, update: 10_000, retries: 0 });
  } catch {
    throw new Error('This data directory is in use by another server or login command. Stop that process first, or set a different CHATGPT_DATA_DIR.');
  }
}
