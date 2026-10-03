import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

export const projectRoot = fileURLToPath(new URL('../', import.meta.url));
dotenv.config({ path: path.join(projectRoot, '.env'), quiet: true });

export interface Config {
  dataDir: string;
  headless: boolean;
  browserMode: 'cdp' | 'playwright' | 'webkit';
  autoSwitchAccounts: boolean;
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
  if (browserMode !== 'cdp' && browserMode !== 'playwright' && browserMode !== 'webkit') throw new Error('CHATGPT_BROWSER_MODE must be cdp, playwright, or webkit.');
  if (browserMode === 'cdp' && headless === 'true') throw new Error('CDP mode uses visible Chrome. Set CHATGPT_HEADLESS=false or use CHATGPT_BROWSER_MODE=playwright.');
  return {
    dataDir: path.resolve(projectRoot, env.CHATGPT_DATA_DIR ?? '.chatgpt-images'),
    headless: headless === 'true',
    browserMode,
    autoSwitchAccounts: autoSwitchAccounts === 'true',
    manualCloseMs: integer(env, 'CHATGPT_MANUAL_CLOSE_MS', 10_000, 0, 600_000),
    chromeExecutable: env.CHATGPT_CHROME_EXECUTABLE ? path.resolve(projectRoot, env.CHATGPT_CHROME_EXECUTABLE) : undefined,
    cookiesFile: env.CHATGPT_COOKIES_FILE ? path.resolve(projectRoot, env.CHATGPT_COOKIES_FILE) : undefined,
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
