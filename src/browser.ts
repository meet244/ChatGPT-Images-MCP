import path from 'node:path';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, webkit, type Browser, type BrowserContext, type Page, type Locator } from 'playwright';
import sharp from 'sharp';
import type { Config } from './config.js';
import { cli } from './config.js';
import { readCookies, normalizeCookies, hasSessionCookies, type BrowserCookie } from './cookies.js';
import { readSavedCookies, saveCookies } from './session-store.js';
import { inspectSavedSession } from './saved-session.js';
import type { ImageArtifact } from './store.js';
import { connectChrome, ChromeError, seedManualChromeCookies, openManualChrome, finishManualChrome, stopChrome } from './chrome.js';
import { generationLimitNotice, type GenerationLimitNotice } from './limits.js';
import { logEvent } from './events.js';

export type SessionStatus = { status: 'ready' | 'login_required' | 'challenge' | 'unavailable'; message: string };
type Candidate = { src: string; width: number; height: number };
const generatedGallery = '[data-testid="generated-image-gallery"]';
// ChatGPT's newer image cards have no gallery or assistant-message wrapper.
const generatedResultImages = '[data-image-gen-result] img, img[alt^="Generated image:"]';
const stopButtons = 'button[data-testid="stop-button"], button[aria-label="Stop streaming"], button[aria-label="Stop generating"]';
const userMessages = '[data-message-author-role="user"], [data-turn="user"]';
export interface GenerationResult { conversationUrl: string; images: ImageArtifact[]; }
export interface GenerationOptions { conversationUrl?: string; reuseReferences?: boolean; allowConversationRollover?: boolean; aspectRatio?: string; }
export interface ManualCookieSetup { count: number; pid?: number; autoCloseMs?: number; close?(): Promise<void>; waitForExit(): Promise<void>; }
/** Messages are safe to show publicly; raw browser exceptions stay inside the adapter. */
export class BrowserError extends Error {
  constructor(message: string, readonly code?: 'free_tier_exhausted' | 'image_usage_limit', readonly resetText?: string) { super(message); }
}
/** A completed response with no image, rather than an uncertain submission or timeout. */
export class TextOnlyResponseError extends BrowserError {
  constructor() { super('ChatGPT finished with a text response but no generated image. Check the conversation for a refusal, usage limit, or unavailable image tool.'); }
}
/** Verification shown before the prompt was sent, so trying again cannot submit it twice. */
class VerificationBeforeSubmitError extends BrowserError {}
class ConversationFullError extends BrowserError {
  constructor() { super('ChatGPT explicitly reported that this conversation is full.'); }
}

export class ChatGPTBrowser {
  private context?: BrowserContext;
  private connection?: Browser;
  private page?: Page;
  private starting?: Promise<Page>;
  private manualHandoff = false;
  private readonly baseUrl: string;
  /** How long a verification page may take to clear by itself before ordinary Chrome is opened. */
  private readonly verificationWaitMs: number;
  constructor(private config: Config, options: { baseUrl?: string; verificationWaitMs?: number } = {}) {
    this.baseUrl = options.baseUrl ?? 'https://chatgpt.com/';
    this.verificationWaitMs = options.verificationWaitMs ?? 10_000;
  }

  private async start(): Promise<Page> {
    if (this.page && !this.page.isClosed()) return this.page;
    if (this.starting) return this.starting;
    this.starting = this.launch();
    try { return await this.starting; } finally { this.starting = undefined; }
  }

  private async launch(): Promise<Page> {
    await this.closeConnection();
    const profile = path.join(this.config.dataDir, this.config.browserMode === 'webkit' ? 'webkit-profile' : 'browser-profile');
    await mkdir(profile, { recursive: true, mode: 0o700 });
    try {
      if (this.config.browserMode === 'cdp') {
        this.connection = await connectChrome(this.config);
        this.context = this.connection.contexts()[0];
        if (!this.context) throw new Error('Dedicated Chrome has no default browser context.');
      } else {
        const engine = this.config.browserMode === 'webkit' ? webkit : chromium;
        this.context = await engine.launchPersistentContext(profile, {
          headless: this.config.headless,
          ...(this.config.browserMode === 'playwright' ? { channel: this.config.channel } : {}),
          acceptDownloads: true,
          viewport: { width: 1440, height: 1000 },
        });
      }
      this.context.setDefaultTimeout(15_000);
      const saved = this.manualHandoff ? [] : this.config.cookiesFile ? await readCookies(this.config.cookiesFile) : await readSavedCookies(this.config.dataDir);
      // Preserve fresher live Chrome cookies when reconnecting; seed missing cookies on first use.
      const current = await this.context.cookies();
      if (this.manualHandoff) {
        // The ordinary browser's refreshed cookies are now the source of truth.
        await saveCookies(this.config.dataDir, current);
        this.manualHandoff = false;
      }
      const liveSession = hasSessionCookies(current);
      const missing = this.config.cookiesFile ? saved : saved.filter(cookie =>
        !(liveSession && hasSessionCookies([cookie])) && !current.some(existing => existing.name === cookie.name && existing.domain === cookie.domain && existing.path === cookie.path));
      if (missing.length) await this.context.addCookies(missing);
      const origin = new URL(this.baseUrl).origin;
      this.page = this.context.pages().find(page => { try { return new URL(page.url()).origin === origin; } catch { return false; } })
        ?? this.context.pages().find(page => page.url() === 'about:blank') ?? this.context.pages()[0] ?? await this.context.newPage();
      if (this.config.browserMode === 'cdp') {
        // This is our dedicated profile: keep one tab even if Chrome restored old windows.
        for (const extra of this.context.pages()) if (extra !== this.page) await extra.close();
      }
      return this.page;
    } catch (error) {
      await this.closeConnection().catch(() => {});
      this.context = undefined;
      if (this.config.cookiesFile) {
        // Return normalized import errors, never Playwright exceptions containing cookie values.
        await readCookies(this.config.cookiesFile);
      }
      throw new BrowserError(this.config.browserMode === 'cdp'
        ? (error instanceof ChromeError ? error.message : 'Could not initialize dedicated Chrome. Check the saved cookies and run browser-close before trying again.')
        : this.config.browserMode === 'webkit'
          ? 'Cannot start WebKit. Run npx playwright install webkit and ensure its dedicated profile is not already open.'
          : 'Cannot start the browser. Run npx playwright install chromium, check CHATGPT_BROWSER_CHANNEL, and ensure the profile is not already open.');
    }
  }

  async importCookies(file: string): Promise<number> {
    return this.importCookieValues(await readCookies(file));
  }

  async hasSavedSession(): Promise<boolean> {
    const cookies = this.config.cookiesFile ? await readCookies(this.config.cookiesFile) : await readSavedCookies(this.config.dataDir);
    return hasSessionCookies(cookies);
  }

  savedSessionStatus() { return inspectSavedSession(this.config); }

  async prepareManualCookieSession(input: BrowserCookie[]): Promise<ManualCookieSetup | undefined> {
    if (this.config.browserMode !== 'cdp') return undefined;
    const cookies = normalizeCookies(input);
    await this.close();
    const count = await seedManualChromeCookies(this.config, cookies);
    // An explicit import supersedes any configured source for this setup command.
    this.config.cookiesFile = undefined;
    const manual = await openManualChrome(this.config, { urls: [this.baseUrl] });
    return { count, pid: manual.pid, autoCloseMs: this.config.manualCloseMs, close: () => manual.close(), waitForExit: async () => {
      await manual.waitForExit();
      this.manualHandoff = true;
    } };
  }

  async importCookieValues(input: BrowserCookie[]): Promise<number> {
    const cookies = normalizeCookies(input);
    // Saving before launch also allows a fresh import to repair an unreadable cookie store.
    await saveCookies(this.config.dataDir, cookies);
    // Explicit imports replace cookies in the controlled context below; cookie
    // setup supplies its own ordinary stage through prepareManualCookieSession.
    await this.start();
    try {
      // Remove old parts of a split token when replacing it with a different-sized token.
      if (hasSessionCookies(cookies)) await this.context!.clearCookies({ name: /^(?:__Secure-)?(?:next-auth|authjs)\.session-token(?:\.\d+)?$/ });
      await this.context!.addCookies(cookies);
      await saveCookies(this.config.dataDir, await this.context!.cookies());
    }
    catch { throw new Error('Browser rejected the cookies. Check the cookie export format.'); }
    return cookies.length;
  }

  async setHeadless(headless: boolean): Promise<void> {
    if (this.config.headless === headless) return;
    await this.close();
    this.config.headless = headless;
  }

  async open(): Promise<Page> {
    const page = await this.start();
    // Chrome can restore an old tab after launch; keep this dedicated profile at one tab.
    if (this.config.browserMode === 'cdp') for (const extra of page.context().pages()) if (extra !== page) await extra.close().catch(() => {});
    if (page.url() === this.baseUrl || page.url() === this.baseUrl.replace(/\/$/, '')) return page;
    try { await page.goto(this.baseUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 }); }
    catch { throw new BrowserError('Cannot open ChatGPT. Check your network and browser session.'); }
    return page;
  }

  private async inspect(page: Page): Promise<SessionStatus> {
    const text = await page.locator('body').innerText({ timeout: 5_000 }).catch(() => '');
    const title = await page.title().catch(() => '');
    const challengeTitle = /^(?:just a moment(?:\.{3}|…)?|access denied|attention required!?)(?:\s*[-|].*)?$/i.test(title.trim());
    if (challengeTitle || /verify you are human|checking your browser|performing security verification|access denied/i.test(text)) {
      return { status: 'challenge', message: this.config.browserMode === 'cdp'
        ? `ChatGPT requires browser verification. Run ${cli('manage-accounts')}, select this account, choose "Sign in again with Chrome" and complete the check. Then check session_status again.`
        : `ChatGPT requires browser verification. Run ${cli('manage-accounts')}, select this account and choose "Sign in again with Chrome" to complete it in a visible browser.` };
    }
    const login = page.getByRole('button', { name: /^(log in|sign in)$/i }).or(page.getByRole('link', { name: /^(log in|sign in)$/i }));
    if (/\/auth\//.test(page.url()) || await login.first().isVisible().catch(() => false)) {
      return { status: 'login_required', message: `Session is not signed in. Run ${cli('manage-accounts')}, select this account and sign in again.` };
    }
    if (await page.locator(this.config.selectors.composer).filter({ visible: true }).first().isVisible().catch(() => false)) {
      return { status: 'ready', message: 'ChatGPT is ready to receive image requests. Account access and image usage limits still apply.' };
    }
    return { status: 'unavailable', message: 'ChatGPT opened, but its message box was not found. Image generation is unavailable until the page finishes loading or the browser adapter is updated.' };
  }

  /**
   * Wait while the user signs in through the visible browser. Never navigates
   * away from their sign-in pages; returns once ChatGPT shows a signed-in composer.
   */
  async waitForSignIn(options: { timeoutMs?: number; pollMs?: number; signal?: AbortSignal; onStatus?: (status: SessionStatus['status']) => void } = {}): Promise<SessionStatus> {
    const page = await this.open();
    const origin = new URL(this.baseUrl).origin;
    const deadline = Date.now() + (options.timeoutMs ?? 15 * 60_000);
    let last: SessionStatus['status'] | undefined;
    let readySince = 0;
    while (Date.now() < deadline) {
      if (options.signal?.aborted) return { status: 'login_required', message: 'Sign-in cancelled. Nothing was changed.' };
      if (page.isClosed()) throw new BrowserError('The Chrome window was closed before sign-in finished.');
      let state: SessionStatus['status'] = 'login_required';
      let onChatGPT = false;
      try { onChatGPT = new URL(page.url()).origin === origin; } catch { /* Navigation in progress. */ }
      if (onChatGPT) {
        state = (await this.inspect(page)).status;
        if (state === 'ready' && !hasSessionCookies(await this.context!.cookies())) state = 'login_required';
      }
      if (state !== last) { last = state; options.onStatus?.(state); }
      // Require two consecutive signed-in checks so a redirect cannot end sign-in early.
      if (state === 'ready') {
        if (readySince) return { status: 'ready', message: 'ChatGPT is ready to receive image requests. Account access and image usage limits still apply.' };
        readySince = Date.now();
      } else readySince = 0;
      await delay(options.pollMs ?? 1500, undefined, { signal: options.signal }).catch(() => {});
    }
    return { status: 'login_required', message: 'Timed out waiting for sign-in. Nothing was changed.' };
  }

  /** Email and plan of the signed-in account; the session token never leaves the page. */
  async accountProfile(): Promise<{ email?: string; plan?: string } | undefined> {
    const page = this.page;
    if (!page || page.isClosed()) return undefined;
    try {
      const profile = await page.evaluate(async () => {
        const response = await fetch('/api/auth/session', { credentials: 'include' });
        if (!response.ok) return undefined;
        const session = await response.json() as { user?: { email?: unknown }; account?: { planType?: unknown } };
        return { email: session.user?.email, plan: session.account?.planType };
      });
      const email = typeof profile?.email === 'string' && /^[^\s@\x00-\x1f]{1,64}@[^\s@\x00-\x1f]{1,190}$/.test(profile.email) ? profile.email : undefined;
      const plan = typeof profile?.plan === 'string' && /^[a-z0-9_-]{1,32}$/i.test(profile.plan) ? profile.plan.toLowerCase() : undefined;
      return email || plan ? { ...(email ? { email } : {}), ...(plan ? { plan } : {}) } : undefined;
    } catch { return undefined; }
  }

  async sessionStatus(navigate = true, settleMs = 0): Promise<SessionStatus> {
    const page = navigate ? await this.open() : await this.start();
    // Cookie setup gives the reopened window its own verification interval.
    if (settleMs > 0) await delay(settleMs);
    const deadline = Date.now() + 15_000;
    let state: SessionStatus;
    do {
      state = await this.inspect(page);
      if (state.status !== 'unavailable') return state;
      await delay(500);
    } while (Date.now() < deadline);
    return state;
  }

  async generate(jobId: string, prompt: string, onSubmitted: (url: string) => void, referenceImages: ImageArtifact[] = [], options: GenerationOptions = {}): Promise<GenerationResult> {
    try {
      try { return await this.generateWithRollover(jobId, prompt, onSubmitted, referenceImages, options); }
      catch (error) {
        if (!(error instanceof VerificationBeforeSubmitError) || this.config.browserMode !== 'cdp') throw error;
        // Verification appeared before Send, so nothing was submitted. Ordinary Chrome, which has no
        // automation endpoint, can usually pass it on the same profile; then try once more.
        logEvent(`verification page before Send on '${path.basename(this.config.dataDir)}'; opening normal Chrome, then retrying once`);
        await this.verifyInOrdinaryChrome();
        try { return await this.generateWithRollover(jobId, prompt, onSubmitted, referenceImages, options); }
        catch (retry) {
          if (!(retry instanceof VerificationBeforeSubmitError)) throw retry;
          logEvent(`verification still shown on '${path.basename(this.config.dataDir)}' after normal Chrome; stopped without sending`);
          throw new BrowserError(`ChatGPT still asks for verification after this account was opened in normal Chrome. No prompt was submitted. Run ${cli('manage-accounts')}, select this account, choose "Sign in again with Chrome" and complete the check.`);
        }
      }
    }
    catch (error) {
      if (error instanceof BrowserError) throw error;
      throw new BrowserError(`Browser interaction failed. Inspect the page with ${cli('login')} and check the selector overrides. Check the conversation before submitting again.`);
    }
  }

  private async generateWithRollover(jobId: string, prompt: string, onSubmitted: (url: string) => void, referenceImages: ImageArtifact[], options: GenerationOptions): Promise<GenerationResult> {
    try { return await this.generateInBrowser(jobId, prompt, onSubmitted, referenceImages, options); }
    catch (error) {
      if (!(error instanceof ConversationFullError) || !options.allowConversationRollover) throw error;
      // Only a definitive conversation-length rejection is safe to continue in a new chat.
      // Re-upload original snapshots. Never retry account limits, timeouts, or unknown errors.
      const page = await this.start();
      await page.goto(this.baseUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      return await this.generateInBrowser(jobId, prompt, onSubmitted, referenceImages,
        options.aspectRatio !== undefined ? { aspectRatio: options.aspectRatio } : {});
    }
  }

  /** Open this profile in ordinary Chrome for a short time, as cookie setup does, then hand it back to controlled Chrome. */
  async verifyInOrdinaryChrome(): Promise<void> {
    await this.close();
    const manual = await openManualChrome(this.config, { urls: [this.baseUrl] });
    // A queued job must not wait for someone to quit Chrome, so 0 ("wait for manual exit") uses the default here.
    await finishManualChrome(manual, this.config.manualCloseMs || 10_000);
    // The ordinary browser's refreshed cookies become the source of truth on the next launch.
    this.manualHandoff = true;
  }

  private async generateInBrowser(jobId: string, prompt: string, onSubmitted: (url: string) => void, referenceImages: ImageArtifact[], options: GenerationOptions): Promise<GenerationResult> {
    const page = options.conversationUrl ? await this.start() : await this.open();
    if (options.conversationUrl) {
      const expected = new URL(options.conversationUrl);
      if (expected.origin !== new URL(this.baseUrl).origin || !expected.pathname.startsWith('/c/')) throw new BrowserError('The batch has no valid saved ChatGPT conversation URL. No prompt was submitted.');
      if (page.url() !== options.conversationUrl) await page.goto(options.conversationUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    } else if (page.url() !== this.baseUrl || await page.locator(this.config.selectors.assistant).count()) {
      await page.goto(this.baseUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    }
    // A full-chat notice can replace the composer entirely; check it before readiness.
    this.throwForLimit(await this.visibleLimit(page));
    let status = await this.sessionStatus(false);
    // Cloudflare's "Just a moment" page often clears by itself within a few seconds.
    for (const deadline = Date.now() + this.verificationWaitMs; status.status === 'challenge' && Date.now() < deadline;) {
      await delay(500);
      status = await this.inspect(page);
    }
    this.throwForLimit(await this.visibleLimit(page));
    if (status.status === 'challenge') throw new VerificationBeforeSubmitError(status.message);
    if (status.status !== 'ready') throw new BrowserError(status.message);
    if (options.conversationUrl && page.url() !== options.conversationUrl) throw new BrowserError('The saved batch conversation could not be opened. No prompt was submitted.');
    if (await page.locator(stopButtons).filter({ visible: true }).count()) throw new BrowserError('ChatGPT is still responding to an earlier request. No new prompt was submitted. Check that conversation before continuing.');
    this.throwForLimit(await this.visibleLimit(page));
    await this.clearDraftAttachments(page);
    const assistants = page.locator(this.config.selectors.assistant);
    const initialCount = await assistants.count();
    const initialGalleryCount = await page.locator(generatedGallery).count();
    // Include unloaded sources so lazy loading an earlier card cannot finish this job.
    const initialResultSources = new Set(await page.locator(generatedResultImages).evaluateAll(elements =>
      elements.map(element => (element as HTMLImageElement).currentSrc || (element as HTMLImageElement).src)));
    const composer = page.locator(this.config.selectors.composer).filter({ visible: true }).first();
    // fill supports both textareas and contenteditable editors, without clipboard access.
    const instruction = referenceImages.length
      ? options.reuseReferences
        ? 'Create a new image using the original reference images previously attached in this conversation and this description.'
        : 'Create a new image using the attached reference images and this description.'
      : 'Create an image based on this description.';
    const aspectRatio = options.aspectRatio !== undefined ? `\n\nOutput aspect ratio = ${options.aspectRatio}` : '';
    await composer.fill(`${instruction} Generate the image itself using ChatGPT's image creation feature.\n\n${prompt}${aspectRatio}`);
    if (referenceImages.length && !options.reuseReferences) await this.attachReferences(page, referenceImages);
    await this.submitPrompt(page, composer, initialCount, initialGalleryCount, initialResultSources,
      options.reuseReferences ? [] : referenceImages.map(image => path.basename(image.path)));
    onSubmitted(page.url());
    let conversationUrl = page.url();
    const deadline = Date.now() + this.config.timeoutMs;
    let stableKey = '';
    let stableSince = 0;
    let lastText = '';
    let textSince = Date.now();
    while (Date.now() < deadline) {
      if (page.isClosed()) throw new BrowserError('Browser was closed during image generation.');
      if (page.url() !== conversationUrl) { conversationUrl = page.url(); onSubmitted(conversationUrl); }
      const state = await this.inspect(page);
      if (state.status === 'login_required' || state.status === 'challenge') throw new BrowserError(state.message);
      const { candidates: unique, responseText } = await this.collectImages(page, initialCount, initialGalleryCount, initialResultSources);
      const streaming = await page.locator(stopButtons).filter({ visible: true }).count() > 0;
      const key = JSON.stringify(unique);
      if (unique.length && !streaming) {
        if (key !== stableKey) { stableKey = key; stableSince = Date.now(); }
        if (Date.now() - stableSince >= Math.max(2_000, this.config.pollMs * 2)) {
          const images = await this.saveImages(page, jobId, unique);
          return { conversationUrl: page.url(), images };
        }
      } else { stableKey = ''; stableSince = 0; }
      if (!unique.length && !streaming) this.throwForLimit(await this.visibleLimit(page, responseText));
      if (responseText !== lastText) { lastText = responseText; textSince = Date.now(); }
      if (!unique.length && !streaming && responseText.trim() && Date.now() - textSince > 10_000 && !/generating|creating|processing|working on|starting|image generation\s+(?:is\s+)?(?:in progress|underway)/i.test(responseText)) {
        throw new TextOnlyResponseError();
      }
      await delay(this.config.pollMs);
    }
    throw new BrowserError('Timed out waiting for a generated image. Check the ChatGPT conversation before retrying; generation may still be in progress.');
  }

  private throwForLimit(notice?: GenerationLimitNotice): void {
    if (notice?.kind === 'conversation_full') throw new ConversationFullError();
    if (notice?.kind === 'usage_limit') throw new BrowserError(notice.freeTier
      ? 'Your ChatGPT Free plan image allowance has been exhausted. Wait for this account\'s limit to reset before using it again.'
      : 'ChatGPT reported an image/account usage limit. Wait for this account\'s limit to reset before using it again.',
    notice.freeTier ? 'free_tier_exhausted' : 'image_usage_limit', notice.resetText);
  }

  private async submitPrompt(page: Page, composer: Locator, initialAssistantCount: number, initialGalleryCount: number, initialResultSources: ReadonlySet<string>, referenceNames: string[] = []): Promise<void> {
    const send = page.locator(this.config.selectors.send).filter({ visible: true }).first();
    // Activate before checking readiness: foregrounding can update upload UI state.
    try { await page.bringToFront(); }
    catch { throw new BrowserError('Could not activate the ChatGPT tab to send the prompt. No prompt was submitted. Keep the dedicated Chrome window open.'); }
    const readyDeadline = Date.now() + (referenceNames.length ? this.config.timeoutMs : Math.min(60_000, this.config.timeoutMs));
    let readySince = 0;
    while (Date.now() < readyDeadline) {
      this.throwForLimit(await this.visibleLimit(page));
      const ready = await send.isVisible() && await send.isEnabled()
        && await this.referencesReady(page, referenceNames);
      if (ready) {
        if (!readySince) readySince = Date.now();
        if (Date.now() - readySince >= 500) break;
      } else readySince = 0;
      await delay(100);
    }
    if (!readySince || Date.now() - readySince < 500) throw new BrowserError('ChatGPT did not make the send button ready. No prompt was submitted. Inspect the attachments and browser session.');
    const initialUserCount = await page.locator(userMessages).count();
    // Click once. Never resend an ambiguous submission: it could consume usage twice.
    try { await send.click(); }
    catch { throw new BrowserError('Could not click ChatGPT\'s Send button. Keep the dedicated Chrome window open and check the draft and conversation before retrying; no automatic resend was made.'); }
    const acceptedDeadline = Date.now() + Math.min(15_000, this.config.timeoutMs);
    while (Date.now() < acceptedDeadline) {
      this.throwForLimit(await this.visibleLimit(page));
      const state = await this.inspect(page);
      if (state.status === 'login_required' || state.status === 'challenge') throw new BrowserError(state.message);
      const draft = await composer.evaluate(element => element instanceof HTMLTextAreaElement ? element.value : element.textContent ?? '').catch(() => undefined);
      if (draft !== undefined && !draft.trim()
        || await page.locator(userMessages).count() > initialUserCount
        || await page.locator(stopButtons).filter({ visible: true }).count()
        || (await this.collectImages(page, initialAssistantCount, initialGalleryCount, initialResultSources)).candidates.length) return;
      await delay(100);
    }
    throw new BrowserError('The send button was clicked, but ChatGPT did not confirm accepting the message. Check the draft and conversation before retrying; no automatic resend was made.');
  }

  private async referencesReady(page: Page, names: string[]): Promise<boolean> {
    if (await page.locator(this.config.selectors.uploadProgress).filter({ visible: true }).count()) return false;
    if (!names.length) return true;
    const previews = await page.locator(this.config.selectors.attachmentPreview).evaluateAll(elements => {
      const cards = new Set<Element>();
      return elements
      .filter((element): element is HTMLImageElement => element instanceof HTMLImageElement)
      .filter(img => img.getClientRects().length > 0 && img.complete && img.naturalWidth > 0)
      .filter(img => {
        const card = img.closest('.composer-attachment-surface, [data-testid="attachment-preview"], [role="group"]') ?? img;
        if (cards.has(card)) return false;
        cards.add(card);
        return true;
      })
      .map(img => {
        let busy = false;
        for (let parent: Element | null = img; parent && parent !== document.body; parent = parent.parentElement) {
          if (parent.getAttribute('aria-busy') === 'true') busy = true;
        }
        return { name: img.alt || img.closest('[role="group"][aria-label]')?.getAttribute('aria-label') || '', busy };
      });
    });
    if (previews.some(preview => preview.busy)) return false;
    // Consume each preview once: one thumbnail cannot satisfy multiple references.
    const matched = new Set<number>();
    return names.every(name => {
      const parsed = path.parse(name);
      const index = previews.findIndex((preview, index) => {
        if (matched.has(index)) return false;
        const uploaded = path.parse(preview.name);
        return uploaded.ext === parsed.ext && (uploaded.name === parsed.name
          // ChatGPT uses both collision counters and timestamp suffixes.
          || uploaded.name.replace(/\s*\(\d+(?:-\d+)?\)$/, '') === parsed.name);
      });
      if (index < 0) return false;
      matched.add(index);
      return true;
    });
  }

  private async visibleLimit(page: Page, responseText = ''): Promise<GenerationLimitNotice | undefined> {
    const notices = await page.locator('[role="alert"]').filter({ visible: true }).allTextContents();
    // Plain notices are also used by ChatGPT. Match whole notice elements, excluding user
    // messages and the composer so a prompt quoting a limit cannot cause a rollover.
    const plain = await page.getByText(/^(?:You(?:'ve|’ve| have) (?:reached|hit)|This conversation (?:is|has become) too|(?:Conversation|Chat) (?:length |context )?limit reached|Image (?:creation|generation) limit reached|You(?:'re|’re| are) (?:generating images too quickly|out of (?:images|image creations))|Too many requests)/i)
      .evaluateAll(elements => elements.filter(el => el.getClientRects().length > 0
        && !el.closest('[data-message-author-role="user"], [data-turn="user"], form, [contenteditable="true"]'))
        .map(el => (el as HTMLElement).innerText ?? el.textContent ?? ''));
    // Read the complete assistant notice as well as its individual paragraphs so
    // the plan and reset time remain associated with the usage-limit heading.
    const latestAssistant = page.locator(this.config.selectors.assistant).last();
    const assistantText = responseText || (await latestAssistant.count()
      ? await latestAssistant.innerText({ timeout: 1000 }).catch(() => '') : '');
    const limits = [...notices, ...plain, assistantText].map(generationLimitNotice).filter((notice): notice is GenerationLimitNotice => !!notice);
    const usage = limits.filter(notice => notice.kind === 'usage_limit');
    if (usage.length) return { kind: 'usage_limit', ...(usage.some(notice => notice.freeTier) ? { freeTier: true } : {}),
      ...(usage.find(notice => notice.resetText)?.resetText ? { resetText: usage.find(notice => notice.resetText)!.resetText } : {}) };
    return limits.find(notice => notice.kind === 'conversation_full');
  }

  private async attachReferences(page: Page, images: ImageArtifact[]): Promise<void> {
    try {
      const input = page.locator(this.config.selectors.fileInput).first();
      await input.waitFor({ state: 'attached' });
      if (images.length > 1 && await input.getAttribute('multiple') === null) {
        throw new BrowserError('This ChatGPT upload input accepts one reference image at a time. No prompt was submitted. Update the file input selector or pass one image.');
      }
      await input.setInputFiles(images.map(image => image.path));
      const names = images.map(image => path.basename(image.path));
      const deadline = Date.now() + this.config.timeoutMs;
      let readySince = 0;
      while (Date.now() < deadline) {
        const state = await this.inspect(page);
        if (state.status === 'challenge') throw new VerificationBeforeSubmitError(`${state.message} No prompt was submitted.`);
        if (state.status === 'login_required') throw new BrowserError(`${state.message} No prompt was submitted.`);
        const alerts = await page.locator('[role="alert"]').allTextContents();
        if (alerts.some(text => /(?:upload|file|image|attachment).*(?:failed|error|unable|unsupported|too large|limit)|(?:failed|unable).*(?:upload|attach)/i.test(text))) {
          throw new BrowserError('ChatGPT rejected a reference image upload. No prompt was submitted. Inspect the upload error in Chrome.');
        }
        if (await this.referencesReady(page, names)) {
          if (!readySince) readySince = Date.now();
          if (Date.now() - readySince >= 500) return;
        } else readySince = 0;
        await delay(Math.min(this.config.pollMs, 500));
      }
      throw new BrowserError('Timed out waiting for reference images to finish uploading. No prompt was submitted. Inspect Chrome or update the attachment selector overrides.');
    } catch (error) {
      if (error instanceof BrowserError) throw error;
      throw new BrowserError('Reference images could not be attached to ChatGPT. No prompt was submitted. Inspect Chrome and the file input selector.');
    }
  }

  private async clearDraftAttachments(page: Page): Promise<void> {
    const remove = page.locator('.composer-attachment-surface button[aria-label^="Remove "], [data-testid="attachment-preview"] button[aria-label^="Remove "], form button[aria-label^="Remove file"]').filter({ visible: true });
    const deadline = Date.now() + 15_000;
    while (await remove.count()) {
      if (Date.now() >= deadline) throw new BrowserError('Could not clear old draft attachments. No prompt was submitted. Remove them from the ChatGPT composer before retrying.');
      // ChatGPT reveals this button on hover; invoke its native click without desktop input.
      await remove.first().evaluate(element => (element as HTMLButtonElement).click());
      await delay(100);
    }
    if (await page.locator(this.config.selectors.attachmentPreview).filter({ visible: true }).count()) {
      throw new BrowserError('ChatGPT has old draft attachments that could not be removed. No prompt was submitted. Clear the composer attachments before retrying.');
    }
  }

  private async loadedImages(locator: Locator): Promise<Candidate[]> {
    return locator.evaluateAll(elements => elements
      .filter((element): element is HTMLImageElement => element instanceof HTMLImageElement)
      .filter(img => !img.closest('[aria-hidden="true"]'))
      .filter(img => img.complete && img.naturalWidth >= 256 && img.naturalHeight >= 256 && img.getClientRects().length > 0)
      .map(img => ({ src: img.currentSrc || img.src, width: img.naturalWidth, height: img.naturalHeight })));
  }

  private async collectImages(page: Page, initialAssistantCount: number, initialGalleryCount: number, initialResultSources: ReadonlySet<string> = new Set()): Promise<{ candidates: Candidate[]; responseText: string }> {
    const candidates: Candidate[] = [];
    let responseText = '';
    const assistants = page.locator(this.config.selectors.assistant);
    for (let i = initialAssistantCount; i < await assistants.count(); i++) {
      const turn = assistants.nth(i);
      responseText += await turn.innerText().catch(() => '');
      candidates.push(...await this.loadedImages(turn.locator(this.config.selectors.image)));
    }
    // The current gallery is rendered outside the legacy assistant-message containers.
    // Only new galleries belong to this request; ignore previews present before submission.
    const galleries = page.locator(generatedGallery);
    for (let i = initialGalleryCount; i < await galleries.count(); i++) {
      candidates.push(...await this.loadedImages(galleries.nth(i).locator('[data-testid="generated-image-preview"]').locator(this.config.selectors.image)));
    }
    candidates.push(...(await this.loadedImages(page.locator(generatedResultImages)))
      .filter(candidate => !initialResultSources.has(candidate.src)));
    return { candidates: [...new Map(candidates.filter(item => item.src).map(item => [item.src, item])).values()], responseText };
  }

  /** Save an existing conversation's finished images without submitting a new prompt. */
  async recover(jobId: string, conversationUrl: string): Promise<GenerationResult> {
    const expected = new URL(conversationUrl);
    if (expected.origin !== new URL(this.baseUrl).origin || expected.pathname === '/') throw new BrowserError('This job has no recoverable ChatGPT conversation URL.');
    const page = await this.start();
    try {
      if (page.url() !== conversationUrl) await page.goto(conversationUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      const deadline = Date.now() + 30_000;
      let stableKey = '';
      let stableSince = 0;
      while (Date.now() < deadline) {
        if (page.url() !== conversationUrl) throw new BrowserError('The conversation changed during recovery. Open the recorded job conversation before recovering.');
        const state = await this.inspect(page);
        if (state.status === 'login_required' || state.status === 'challenge') throw new BrowserError(state.message);
        const { candidates } = await this.collectImages(page, 0, 0);
        const streaming = await page.locator(stopButtons).filter({ visible: true }).count() > 0;
        const key = JSON.stringify(candidates);
        if (candidates.length && !streaming) {
          if (key !== stableKey) { stableKey = key; stableSince = Date.now(); }
          if (Date.now() - stableSince >= 2000) return { conversationUrl: page.url(), images: await this.saveImages(page, jobId, candidates) };
        } else { stableKey = ''; stableSince = 0; }
        await delay(Math.min(this.config.pollMs, 1000));
      }
      throw new BrowserError('No finished generated image was found in the recorded conversation. No new prompt was submitted.');
    } catch (error) {
      if (error instanceof BrowserError) throw error;
      throw new BrowserError('Could not recover images from the recorded conversation. No new prompt was submitted.');
    }
  }

  private async saveImages(page: Page, jobId: string, candidates: Candidate[]): Promise<ImageArtifact[]> {
    const directory = path.join(this.config.dataDir, 'images', jobId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const images: ImageArtifact[] = [];
    for (const [index, candidate] of candidates.entries()) {
      let bytes: Buffer;
      try {
        if (candidate.src.startsWith('data:') || candidate.src.startsWith('blob:')) {
          const base64 = await page.evaluate(async src => {
            const response = await fetch(src);
            const blob = await response.blob();
            if (!blob.type.startsWith('image/') || blob.size > 30 * 1024 * 1024) throw new Error('Invalid image');
            return await new Promise<string>((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
              reader.onerror = reject;
              reader.readAsDataURL(blob);
            });
          }, candidate.src);
          bytes = Buffer.from(base64, 'base64');
        } else {
          const url = new URL(candidate.src);
          if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname))) throw new Error('Unexpected image URL');
          const response = await this.context!.request.get(candidate.src, { timeout: 30_000 });
          try {
            if (!response.ok()) throw new Error('Image download failed');
            bytes = await response.body();
          } finally { await response.dispose(); }
        }
        if (!bytes.length || bytes.length > 30 * 1024 * 1024) throw new Error('Invalid image size');
        const metadata = await sharp(bytes).metadata();
        if (!metadata.width || !metadata.height || metadata.width < 256 || metadata.height < 256) throw new Error('Invalid image dimensions');
        const formats: Record<string, [string, string]> = { png: ['png', 'image/png'], jpeg: ['jpg', 'image/jpeg'], webp: ['webp', 'image/webp'], gif: ['gif', 'image/gif'], avif: ['avif', 'image/avif'] };
        const format = formats[metadata.format ?? ''];
        if (!format) throw new Error('Unsupported image format');
        const file = path.join(directory, `${index + 1}.${format[0]}`);
        await writeFile(file, bytes, { mode: 0o600 });
        await chmod(file, 0o600);
        images.push({ path: file, mimeType: format[1], bytes: bytes.length });
      } catch {
        throw new BrowserError('A generated image was detected but could not be downloaded. Check the ChatGPT conversation; no new prompt was submitted.');
      }
    }
    return images;
  }

  async closeAfterSetup(): Promise<void> {
    await this.shutdown();
  }

  /** Save the session and fully close this profile; subsequent work can reopen it. */
  async shutdown(): Promise<void> {
    try { await this.close(); }
    finally {
      // close() already snapshots the session. Chrome also flushes its persistent profile.
      if (this.config.browserMode === 'cdp') await stopChrome(this.config, { saveCookies: false });
    }
  }

  async close(): Promise<void> {
    await this.starting?.catch(() => {});
    try {
      if (this.context) {
        const cookies = await this.context.cookies().catch(() => undefined);
        if (cookies) await saveCookies(this.config.dataDir, cookies);
      }
    } finally {
      await this.closeConnection();
      this.context = undefined;
      this.page = undefined;
    }
  }

  private async closeConnection(): Promise<void> {
    if (this.connection) {
      // A CDP-connected Browser.close disconnects Playwright. Chrome stays running.
      await this.connection.close();
      this.connection = undefined;
    } else { await this.context?.close(); }
    this.context = undefined;
    this.page = undefined;
  }
}
