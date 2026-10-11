import path from 'node:path';
import { rename, stat } from 'node:fs/promises';

/**
 * One line per event on stderr, which the shared worker writes to worker.log.
 * Events carry job IDs, account names, timings and errors only: never prompts or cookie values.
 */
export function logEvent(message: string): void {
  try { process.stderr.write(`${new Date().toISOString()} ${message.replace(/\s+/g, ' ').trim()}\n`); }
  catch { /* Logging must never affect image generation. */ }
}

export const seconds = (since: number): string => `${Math.round((Date.now() - since) / 1000)}s`;

/** Keep worker.log bounded: past the limit, the current log becomes worker.log.1 and a new one starts. */
export async function rotateLog(file: string, maxBytes = 5 * 1024 * 1024): Promise<void> {
  try {
    if ((await stat(file)).size > maxBytes) await rename(file, path.join(path.dirname(file), `${path.basename(file)}.1`));
  } catch { /* A missing or unreadable log starts fresh. */ }
}
