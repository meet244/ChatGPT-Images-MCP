import { JobStore, type Job, type ImageArtifact, type ChatMode, type Batch, type ImageCooldown } from './store.js';
import { BrowserError, TextOnlyResponseError, type ChatGPTBrowser, type GenerationResult, type SessionStatus, type GenerationOptions } from './browser.js';
import { stageReferences, discardReferences } from './references.js';

export interface ImageGenerator {
  generate(jobId: string, prompt: string, onSubmitted: (url: string) => void, referenceImages?: ImageArtifact[], options?: GenerationOptions): Promise<GenerationResult>;
  shutdown?(): Promise<void>;
}
export class CooldownError extends Error {
  constructor(readonly cooldown: ImageCooldown, readonly account?: string, noFallback = false) {
    super(`${cooldown.error} Image requests${account ? ` for account '${account}'` : ''} are blocked until ${cooldown.retryAfter} (24-hour cooldown).${noFallback ? ' No other ready signed-in account is available.' : ''}`);
  }
}
export type JobExecutor = (job: Job, onSubmitted: (url: string) => void, options: GenerationOptions, previous?: Job) => Promise<GenerationResult>;
export class BatchRestartError extends Error {}
export class JobQueue {
  private running = false;
  private stopped = false;
  private active?: Promise<void>;
  private inspecting = false;
  private admissions: Promise<void> = Promise.resolve();
  private pendingAdmissions = 0;
  private executor?: JobExecutor;
  private idleHandler?: () => Promise<void>;
  private cleanupNeeded = false;
  private cleaning = false;
  private cleanupActive?: Promise<void>;
  constructor(private store: JobStore, private browser: ImageGenerator) {}
  setExecutor(executor: JobExecutor): void { this.executor = executor; }
  setIdleHandler(handler: () => Promise<void>): void { this.idleHandler = handler; }
  hasPendingWork(): boolean {
    return this.running || this.inspecting || this.pendingAdmissions > 0 || this.store.byStatus('queued').length > 0;
  }
  private async cleanupIfIdle(): Promise<void> {
    if ((!this.cleanupNeeded && !this.idleHandler) || this.hasPendingWork() || this.cleaning) return;
    this.cleanupNeeded = false;
    this.cleaning = true;
    this.cleanupActive = (async () => {
      try {
        if (this.idleHandler) await this.idleHandler();
        else await this.browser.shutdown?.();
      } catch {
        // Browser cleanup must not turn an already saved image into a failed generation.
        process.stderr.write('Could not close an idle image browser. Saved job results are retained.\n');
      } finally {
        this.cleaning = false;
        if (!this.stopped && this.store.byStatus('queued').length) this.kick();
      }
    })();
    await this.cleanupActive;
  }

  assertGenerationAllowed(autoSwitchAccount = false): void {
    if (autoSwitchAccount && this.executor) return;
    const cooldown = this.store.imageCooldown();
    if (cooldown) throw new CooldownError(cooldown);
  }

  enqueue(prompt: string, referenceImages: ImageArtifact[] = [], aspectRatio?: string, autoSwitchAccount = false): Job {
    if (this.stopped) throw new Error('Server is shutting down.');
    this.assertGenerationAllowed(autoSwitchAccount);
    if (this.store.queueCapacityUsed() >= 25) throw new Error('Queue is full. Wait for existing jobs before submitting more.');
    let job = this.store.create(prompt, referenceImages, aspectRatio);
    if (autoSwitchAccount) job = this.store.update(job.id, { autoSwitchAccount });
    this.kick();
    return job;
  }
  enqueueWithReferences(prompt: string, paths: string[] = [], aspectRatio?: string, autoSwitchAccount = false): Promise<Job> {
    this.pendingAdmissions++;
    // Serialize file validation as well as browser work: slow copies cannot reorder requests.
    const admission = this.admissions.then(async () => {
      if (this.stopped) throw new Error('Server is shutting down.');
      this.assertGenerationAllowed(autoSwitchAccount);
      if (this.store.queueCapacityUsed() >= 25) throw new Error('Queue is full. Wait for existing jobs before submitting more.');
      const references = await stageReferences(this.store.dataDir, paths);
      try { return this.enqueue(prompt, references, aspectRatio, autoSwitchAccount); }
      catch (error) { await discardReferences(references); throw error; }
    });
    this.admissions = admission.then(() => {}, () => {});
    return admission.finally(async () => { this.pendingAdmissions--; await this.cleanupIfIdle(); });
  }
  enqueueBatch(prompts: string[], chatMode: ChatMode, paths: string[] = [], aspectRatio?: string, autoSwitchAccount = false, sameChatMandatory = false): Promise<Batch> {
    this.pendingAdmissions++;
    const admission = this.admissions.then(async () => {
      if (this.stopped) throw new Error('Server is shutting down.');
      this.assertGenerationAllowed(autoSwitchAccount);
      if (!prompts.length || prompts.length > 25) throw new Error('A batch requires 1–25 prompts.');
      if (sameChatMandatory && chatMode !== 'same_chat') throw new Error('Mandatory same-chat batches cannot use separate chats.');
      if (this.store.queueCapacityUsed() + prompts.length > 25) throw new Error('The batch does not fit in the queue. At most 25 jobs can wait; no part of this batch was queued.');
      const references = await stageReferences(this.store.dataDir, paths);
      try {
        if (this.stopped) throw new Error('Server is shutting down.');
        this.assertGenerationAllowed(autoSwitchAccount);
        const batch = this.store.createBatch(prompts, chatMode, references, aspectRatio, autoSwitchAccount, sameChatMandatory);
        this.kick();
        return this.store.getBatch(batch.id);
      } catch (error) { await discardReferences(references); throw error; }
    });
    this.admissions = admission.then(() => {}, () => {});
    return admission.finally(async () => { this.pendingAdmissions--; await this.cleanupIfIdle(); });
  }
  kick(): void {
    if (this.running || this.stopped || this.inspecting || this.cleaning) return;
    this.running = true;
    this.active = this.drain().finally(async () => {
      this.running = false;
      // A request can arrive after drain finds no work but before this callback.
      if (this.store.byStatus('queued').length) this.kick();
      else await this.cleanupIfIdle();
    });
  }
  private async drain(): Promise<void> {
    while (!this.stopped) {
      const job = this.store.byStatus('queued')[0];
      if (!job) return;
      this.cleanupNeeded = true;
      const cooldown = this.store.imageCooldown();
      if (cooldown && !(job.autoSwitchAccount && this.executor)) {
        this.store.update(job.id, { status: 'failed', error: new CooldownError(cooldown).message,
          errorCode: cooldown.errorCode, limitReset: cooldown.limitReset,
          limitDetectedAt: cooldown.detectedAt, retryAfter: cooldown.retryAfter });
        if (job.batchId) this.store.stopBatch(job.batchId, 'Batch stopped during the saved 24-hour image cooldown.');
        continue;
      }
      this.store.update(job.id, { status: 'running' });
      try {
        const previous = job.batchId && job.chatMode === 'same_chat'
          ? this.store.getBatch(job.batchId).jobs.filter(item => item.batchIndex! < job.batchIndex! && item.status === 'completed').at(-1)
          : undefined;
        const onSubmitted = (url: string): void => { this.store.update(job.id, { conversationUrl: url }); };
        const options = { allowConversationRollover: Boolean(job.batchId) && !job.sameChatMandatory, ...(job.aspectRatio !== undefined ? { aspectRatio: job.aspectRatio } : {}),
          ...(previous?.conversationUrl ? { conversationUrl: previous.conversationUrl, reuseReferences: true } : {}) };
        const result = this.executor
          ? await this.executor(job, onSubmitted, options, previous)
          : await this.browser.generate(job.id, job.prompt, onSubmitted, job.referenceImages ?? [], options);
        if (!this.executor) this.store.resetTextOnlyFailures();
        this.store.update(job.id, { status: 'completed', ...result });
      } catch (error) {
        // The account manager atomically requeued the whole mandatory batch after a definitive rejection.
        if (error instanceof BatchRestartError) continue;
        // Managed execution already records the outcome on the executing profile, not the owner.
        const textOnlyCooldown = !this.executor && error instanceof TextOnlyResponseError
          ? this.store.recordTextOnlyFailure() : undefined;
        if (!this.executor && !(error instanceof TextOnlyResponseError)) this.store.resetTextOnlyFailures();
        // Browser adapter only throws public errors; do not expose raw browser stack traces.
        const cooldown = textOnlyCooldown ?? (error instanceof CooldownError ? error.cooldown : error instanceof BrowserError && error.code
          ? this.store.recordImageLimit(error.code, error.message, error.resetText) : undefined);
        this.store.update(job.id, { status: 'failed', error: error instanceof Error ? error.message : 'Image generation failed.',
          ...(error instanceof BrowserError ? { errorCode: error.code, limitReset: error.resetText } : {}),
          ...(cooldown ? { errorCode: cooldown.errorCode, limitReset: cooldown.limitReset, limitDetectedAt: cooldown.detectedAt, retryAfter: cooldown.retryAfter } : {}) });
        if (job.batchId) this.store.stopBatch(job.batchId, `Batch stopped after job ${job.id} failed. Completed images are retained; inspect the failed job before submitting again.`);
      }
    }
  }
  cancel(id: string): Job {
    const job = this.store.get(id);
    if (job.status !== 'queued') throw new Error('Only queued jobs can be cancelled. A running prompt may already be generating in ChatGPT.');
    return this.store.update(id, { status: 'cancelled' });
  }
  async inspectSession(browser: ChatGPTBrowser, closeBrowser = () => browser.shutdown()): Promise<SessionStatus | { status: 'busy'; message: string } | (ImageCooldown & { status: 'usage_limit'; message: string })> {
    const cooldown = this.store.imageCooldown();
    if (cooldown) return { status: 'usage_limit', message: new CooldownError(cooldown).message, ...cooldown };
    if (this.running || this.inspecting || this.cleaning) return { status: 'busy', message: 'Browser is processing a job, session check, or browser cleanup. Try again when the queue is idle.' };
    this.inspecting = true;
    try { return await browser.sessionStatus(); }
    finally {
      // Keep new generations paused until the status window has fully closed.
      try { await closeBrowser(); }
      finally { this.inspecting = false; this.kick(); }
    }
  }
  isBusy(): boolean { return this.hasPendingWork() || this.cleaning; }
  async stop(): Promise<void> { this.stopped = true; await this.admissions; await this.active; await this.cleanupActive; }
}
