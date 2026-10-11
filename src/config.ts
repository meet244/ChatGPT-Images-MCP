import os from 'node:os';
import path from 'node:path';
import { accessSync, constants, readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

export const projectRoot = fileURLToPath(new URL('../', import.meta.url));
export const packageName = 'chatgpt-images-mcp';
/** The package version, from package.json, so releases need only one version bump. */
export const packageVersion: string = (() => {
  try { return (JSON.parse(readFileSync(path.join(projectRoot, 'package.json'), 'utf8')) as { version?: string }).version ?? '0.0.0'; }
  catch { return '0.0.0'; }
})();
// npm replaces packages under node_modules on update, so package installs keep
// .env and private data in the home directory. Source checkouts keep them here.
const packaged = projectRoot.split(path.sep).includes('node_modules');
export const settingsRoot = packaged ? path.join(os.homedir(), '.chatgpt-images-mcp') : projectRoot;
dotenv.config({ path: path.join(settingsRoot, '.env'), quiet: true });

/** How this copy was installed: run through npx, installed with npm -g, or a source checkout. */
export const installKind: 'npx' | 'global' | 'source' = !packaged ? 'source'
  : projectRoot.split(path.sep).includes('_npx') ? 'npx' : 'global';

/** A terminal command that works for this installation, e.g. cli('setup --account work'). */
export function cli(args = ''): string {
  const base = installKind === 'npx' ? `npx ${packageName}` : installKind === 'global' ? packageName : 'npm run cli --';
  return args ? `${base} ${args}` : base;
}

/** The command an MCP client should launch to reach this installation's server. */
export function launchCommand(): { command: string; args: string[] } {
  // The npx cache path changes between versions; the package name does not.
  if (installKind === 'npx') return { command: 'npx', args: ['-y', `${packageName}@latest`] };
  return { command: stableNode(), args: [path.join(projectRoot, 'dist', 'index.js'), 'serve'] };
}

/** Prefer the PATH entry for this Node (e.g. a Homebrew symlink) over a versioned path that breaks on upgrade. */
function stableNode(): string {
  let current: string;
  try { current = realpathSync(process.execPath); } catch { return process.execPath; }
  for (const directory of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, process.platform === 'win32' ? 'node.exe' : 'node');
    try {
      accessSync(candidate, constants.X_OK);
      if (realpathSync(candidate) === current) return candidate;
    } catch { /* Not this directory. */ }
  }
  return process.execPath;
}

export interface Config {
  dataDir: string;
  headless: boolean;
  browserMode: 'cdp' | 'playwright' | 'webkit';
  autoSwitchAccounts: boolean;
  /** 'background' (default) keeps the dedicated Chrome behind other windows; 'front' activates it before Send. */
  browserFocus: 'front' | 'background';
  manualCloseMs: number;
  chromeExecutable?: string;
  cookiesFile?: string;
  channel?: string;
  timeoutMs: number;
  pollMs: number;
  selectors: { composer: string; send: string; assistant: string; image: string; fileInput: string; attachmentPreview: string; uploadProgress: string };
}

function integer(env: NodeJS.ProcessEnv, key: string, fallback: number, min: number, max: number): number {
  const value = env[key] === undefined ? fallback : Number(env[key]);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${key} must be an integer between ${min} and ${max}.`);
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const headless = env.CHATGPT_HEADLESS ?? 'false';
  if (!['true', 'false'].includes(headless)) throw new Error('CHATGPT_HEADLESS must be true or false.');
  const browserMode = env.CHATGPT_BROWSER_MODE ?? 'cdp';
  const autoSwitchAccounts = env.CHATGPT_AUTO_SWITCH_ACCOUNTS ?? 'true';
  if (!['true', 'false'].includes(autoSwitchAccounts)) throw new Error('CHATGPT_AUTO_SWITCH_ACCOUNTS must be true or false.');
  const browserFocus = env.CHATGPT_BROWSER_FOCUS ?? 'background';
  if (browserFocus !== 'front' && browserFocus !== 'background') throw new Error('CHATGPT_BROWSER_FOCUS must be front or background.');
  if (browserMode !== 'cdp' && browserMode !== 'playwright' && browserMode !== 'webkit') throw new Error('CHATGPT_BROWSER_MODE must be cdp, playwright, or webkit.');
  if (browserMode === 'cdp' && headless === 'true') throw new Error('CDP mode uses visible Chrome. Set CHATGPT_HEADLESS=false or use CHATGPT_BROWSER_MODE=playwright.');
  return {
    dataDir: path.resolve(settingsRoot, env.CHATGPT_DATA_DIR ?? (packaged ? 'data' : '.chatgpt-images')),
    headless: headless === 'true',
    browserMode,
    autoSwitchAccounts: autoSwitchAccounts === 'true',
    browserFocus,
    manualCloseMs: integer(env, 'CHATGPT_MANUAL_CLOSE_MS', 10_000, 0, 600_000),
    chromeExecutable: env.CHATGPT_CHROME_EXECUTABLE ? path.resolve(settingsRoot, env.CHATGPT_CHROME_EXECUTABLE) : undefined,
    cookiesFile: env.CHATGPT_COOKIES_FILE ? path.resolve(settingsRoot, env.CHATGPT_COOKIES_FILE) : undefined,
    channel: env.CHATGPT_BROWSER_CHANNEL || undefined,
    timeoutMs: integer(env, 'CHATGPT_TIMEOUT_MS', 300_000, 10_000, 1_800_000),
    pollMs: integer(env, 'CHATGPT_POLL_MS', 2_000, 100, 30_000),
    selectors: {
      composer: env.CHATGPT_COMPOSER_SELECTOR ?? '#prompt-textarea, textarea[placeholder*="Message"], [contenteditable="true"][data-lexical-editor="true"], [contenteditable="true"][role="textbox"]',
      send: env.CHATGPT_SEND_SELECTOR ?? 'button[data-testid="send-button"], button[aria-label="Send prompt"], button[aria-label="Send message"], button[aria-label="Send"]',
      assistant: env.CHATGPT_ASSISTANT_SELECTOR ?? 'article[data-turn="assistant"], [data-message-author-role="assistant"]:not(article[data-turn="assistant"] *), .agent-turn[data-conversation-screenshot-content]:not(:has(article[data-turn="assistant"], [data-message-author-role="assistant"]))',
      image: env.CHATGPT_IMAGE_SELECTOR ?? 'img',
      fileInput: env.CHATGPT_FILE_INPUT_SELECTOR ?? 'input[type="file"][accept*="image"], input[type="file"][aria-label="Attach files"]',
      attachmentPreview: env.CHATGPT_ATTACHMENT_PREVIEW_SELECTOR ?? '.composer-attachment-surface img, [data-testid="attachment-preview"] img, form [role="group"][aria-label]:has(button[aria-label^="Remove file"]) img',
      uploadProgress: env.CHATGPT_UPLOAD_PROGRESS_SELECTOR ?? '[role="progressbar"][aria-label^="Uploading"], .composer-attachment-surface [role="progressbar"], [data-testid="attachment-preview"][aria-busy="true"], form [role="group"]:has(button[aria-label^="Remove file"]) [role="progressbar"], form [role="group"][aria-busy="true"]:has(button[aria-label^="Remove file"])',
    },
  };
}
