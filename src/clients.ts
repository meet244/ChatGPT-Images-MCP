import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { constants, realpathSync } from 'node:fs';
import { installKind, launchCommand, packageName, projectRoot } from './config.js';

export const serverName = 'chatgpt-images';
export type ClientName = 'claude' | 'codex';
export const clientLabels: Record<ClientName, string> = { claude: 'Claude Code', codex: 'Codex' };
export interface Registration { command: string; args: string[] }
export interface ClientState {
  client: ClientName;
  installed: boolean;
  registration?: Registration;
  /** The registration launches this installation, so it shares its accounts and server. */
  matches: boolean;
  /** The registration could not be read. */
  error?: string;
}

/** Process and file access, injectable for tests. */
export interface ClientEnvironment {
  run(command: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }>;
  which(command: string): Promise<string | undefined>;
  claudeConfigFile: string;
}

export const systemEnvironment: ClientEnvironment = {
  run: (command, args) => new Promise(resolve => {
    execFile(command, args, { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  }),
  which: async command => {
    for (const directory of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
      for (const extension of process.platform === 'win32' ? ['.cmd', '.exe', ''] : ['']) {
        const candidate = path.join(directory, command + extension);
        try { await access(candidate, constants.X_OK); return candidate; } catch { /* Keep looking. */ }
      }
    }
    return undefined;
  },
  claudeConfigFile: path.join(process.env.CLAUDE_CONFIG_DIR ?? os.homedir(), '.claude.json'),
};

const real = (file: string): string => { try { return realpathSync(file); } catch { return file; } };

/** Whether a registration starts this installation rather than another copy. */
export async function pointsHere(registration: Registration, environment: ClientEnvironment = systemEnvironment): Promise<boolean> {
  const { command, args } = registration;
  if (installKind === 'npx') {
    return path.basename(command) === 'npx' && args.some(arg => arg === packageName || arg.startsWith(`${packageName}@`));
  }
  const entry = real(path.join(projectRoot, 'dist', 'index.js'));
  if (args.some(arg => real(arg) === entry)) return true;
  // A linked or globally installed `chatgpt-images-mcp` command that resolves to this copy.
  if (path.basename(command) === packageName) {
    const resolved = path.isAbsolute(command) ? command : await environment.which(command);
    return !!resolved && real(resolved) === entry;
  }
  return false;
}

/** Short description of what a registration launches, for messages. */
export function describeRegistration(registration: Registration): string {
  const joined = [registration.command, ...registration.args].join(' ');
  if (registration.args.some(arg => arg.startsWith('github:'))) return `the GitHub copy (${joined})`;
  if (path.basename(registration.command) === 'npx') return `the npm package (${joined})`;
  return joined;
}

async function readClaude(environment: ClientEnvironment): Promise<Registration | undefined> {
  let config: { mcpServers?: Record<string, { command?: unknown; args?: unknown }> };
  try { config = JSON.parse(await readFile(environment.claudeConfigFile, 'utf8')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error(`Could not read ${environment.claudeConfigFile}.`);
  }
  const entry = config.mcpServers?.[serverName];
  if (!entry) return undefined;
  if (typeof entry.command !== 'string') throw new Error(`The ${serverName} entry in ${environment.claudeConfigFile} is not a local command.`);
  return { command: entry.command, args: Array.isArray(entry.args) ? entry.args.map(String) : [] };
}

async function readCodex(environment: ClientEnvironment): Promise<Registration | undefined> {
  const result = await environment.run('codex', ['mcp', 'get', serverName, '--json']);
  if (result.code !== 0) {
    if (/No MCP server named/i.test(result.stderr + result.stdout)) return undefined;
    throw new Error('Could not read the Codex MCP configuration.');
  }
  const parsed = JSON.parse(result.stdout) as { transport?: { command?: unknown; args?: unknown } };
  if (typeof parsed.transport?.command !== 'string') throw new Error(`The Codex ${serverName} entry is not a local command.`);
  return { command: parsed.transport.command, args: Array.isArray(parsed.transport.args) ? parsed.transport.args.map(String) : [] };
}

export async function inspectClient(client: ClientName, environment: ClientEnvironment = systemEnvironment): Promise<ClientState> {
  const installed = !!await environment.which(client);
  try {
    // Claude Code's user config can be read even if its CLI is missing from PATH.
    const registration = client === 'claude' ? await readClaude(environment) : installed ? await readCodex(environment) : undefined;
    return { client, installed, ...(registration ? { registration } : {}), matches: registration ? await pointsHere(registration, environment) : false };
  } catch (error) {
    return { client, installed, matches: false, error: error instanceof Error ? error.message : 'Registration could not be read.' };
  }
}

/** Register this installation in a client, replacing any existing entry of the same name. */
export async function registerClient(client: ClientName, existing: boolean, environment: ClientEnvironment = systemEnvironment): Promise<void> {
  const { command, args } = launchCommand();
  if (client === 'claude') {
    // Claude Code refuses to overwrite an existing server; remove the user-scope entry first.
    if (existing) {
      const removed = await environment.run('claude', ['mcp', 'remove', serverName, '-s', 'user']);
      if (removed.code !== 0) throw new Error(`Could not remove the old Claude Code registration: ${(removed.stderr || removed.stdout).trim()}`);
    }
    const added = await environment.run('claude', ['mcp', 'add', '--scope', 'user', serverName, '--', command, ...args]);
    if (added.code !== 0) throw new Error(`Could not register with Claude Code: ${(added.stderr || added.stdout).trim()}`);
  } else {
    // Codex replaces an existing entry in place, including its per-server settings.
    const added = await environment.run('codex', ['mcp', 'add', serverName, '--', command, ...args]);
    if (added.code !== 0) throw new Error(`Could not register with Codex: ${(added.stderr || added.stdout).trim()}`);
  }
}
