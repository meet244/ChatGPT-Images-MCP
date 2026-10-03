import { JobStore, type Job, type ImageArtifact, type ChatMode, type Batch, type ImageCooldown } from './store.js';
import { BrowserError, type ChatGPTBrowser, type GenerationResult, type SessionStatus, type GenerationOptions } from './browser.js';
import { stageReferences, discardReferences } from './references.js';

export interface ImageGenerator {
  generate(jobId: string, prompt: string, onSubmitted: (url: string) => void, referenceImages?: ImageArtifact[], options?: GenerationOptions): Promise<GenerationResult>;
}
export class CooldownError extends Error {
  constructor(readonly cooldown: ImageCooldown) {
    super(`${cooldown.error} Image requests are blocked until ${cooldown.retryAfter} (24-hour cooldown).`);
  }
}
export class JobQueue {
  private running = false;
  private stopped = false;
  private active?: Promise<void>;
  private inspecting = false;
  private admissions: Promise<void> = Promise.resolve();
  private pendingAdmissions = 0;
  constructor(private store: JobStore, private browser: ImageGenerator) {}

  assertGenerationAllowed(): void {
    const cooldown = this.store.imageCooldown();
    if (cooldown) throw new CooldownError(cooldown);
  }

  enqueue(prompt: string, referenceImages: ImageArtifact[] = [], aspectRatio?: string): Job {
    if (this.stopped) throw new Error('Server is shutting down.');
    this.assertGenerationAllowed();
    if (this.store.byStatus('queued').length >= 25) throw new Error('Queue is full. Wait for existing jobs before submitting more.');
    const job = this.store.create(prompt, referenceImages, aspectRatio);
    this.kick();
    return job;
  }
  enqueueWithReferences(prompt: string, paths: string[] = [], aspectRatio?: string): Promise<Job> {
    this.pendingAdmissions++;
    // Serialize file validation as well as browser work: slow copies cannot reorder requests.
    const admission = this.admissions.then(async () => {
      if (this.stopped) throw new Error('Server is shutting down.');
      this.assertGenerationAllowed();
      if (this.store.byStatus('queued').length >= 25) throw new Error('Queue is full. Wait for existing jobs before submitting more.');
      const references = await stageReferences(this.store.dataDir, paths);
      try { return this.enqueue(prompt, references, aspectRatio); }
      catch (error) { await discardReferences(references); throw error; }
    });
    this.admissions = admission.then(() => {}, () => {});
    return admission.finally(() => { this.pendingAdmissions--; });
  }
  enqueueBatch(prompts: string[], chatMode: ChatMode, paths: string[] = [], aspectRatio?: string): Promise<Batch> {
    this.pendingAdmissions++;
    const admission = this.admissions.then(async () => {
      if (this.stopped) throw new Error('Server is shutting down.');
      this.assertGenerationAllowed();
      if (!prompts.length || prompts.length > 25) throw new Error('A batch requires 1–25 prompts.');
      if (this.store.byStatus('queued').length + prompts.length > 25) throw new Error('The batch does not fit in the queue. At most 25 jobs can wait; no part of this batch was queued.');
      const references = await stageReferences(this.store.dataDir, paths);
      try {
        if (this.stopped) throw new Error('Server is shutting down.');
        this.assertGenerationAllowed();
        const batch = this.store.createBatch(prompts, chatMode, references, aspectRatio);
        this.kick();
        return this.store.getBatch(batch.id);
      } catch (error) { await discardReferences(references); throw error; }
    });
    this.admissions = admission.then(() => {}, () => {});
    return admission.finally(() => { this.pendingAdmissions--; });
  }
  kick(): void {
    if (this.running || this.stopped || this.inspecting) return;
    this.running = true;
    this.active = this.drain().finally(() => {
      this.running = false;
      // A request can arrive after drain finds no work but before this callback.
      if (this.store.byStatus('queued').length) this.kick();
    });
  }
  private async drain(): Promise<void> {
    while (!this.stopped) {
      const job = this.store.byStatus('queued')[0];
      if (!job) return;
      const cooldown = this.store.imageCooldown();
      if (cooldown) {
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
        const result = await this.browser.generate(job.id, job.prompt, url => this.store.update(job.id, { conversationUrl: url }), job.referenceImages ?? [],
          { allowConversationRollover: Boolean(job.batchId), ...(job.aspectRatio !== undefined ? { aspectRatio: job.aspectRatio } : {}),
            ...(previous?.conversationUrl ? { conversationUrl: previous.conversationUrl, reuseReferences: true } : {}) });
        this.store.update(job.id, { status: 'completed', ...result });
      } catch (error) {
        // Browser adapter only throws public errors; do not expose raw browser stack traces.
        const cooldown = error instanceof BrowserError && error.code
          ? this.store.recordImageLimit(error.code, error.message, error.resetText) : undefined;
        this.store.update(job.id, { status: 'failed', error: error instanceof Error ? error.message : 'Image generation failed.',
          ...(error instanceof BrowserError ? { errorCode: error.code, limitReset: error.resetText } : {}),
          ...(cooldown ? { limitDetectedAt: cooldown.detectedAt, retryAfter: cooldown.retryAfter } : {}) });
        if (job.batchId) this.store.stopBatch(job.batchId, `Batch stopped after job ${job.id} failed. Completed images are retained; inspect the failed job before submitting again.`);
      }
    }
  }
  cancel(id: string): Job {
    const job = this.store.get(id);
    if (job.status !== 'queued') throw new Error('Only queued jobs can be cancelled. A running prompt may already be generating in ChatGPT.');
    return this.store.update(id, { status: 'cancelled' });
  }
  async inspectSession(browser: ChatGPTBrowser): Promise<SessionStatus | { status: 'busy'; message: string } | (ImageCooldown & { status: 'usage_limit'; message: string })> {
    const cooldown = this.store.imageCooldown();
    if (cooldown) return { status: 'usage_limit', message: new CooldownError(cooldown).message, ...cooldown };
    if (this.running || this.inspecting) return { status: 'busy', message: 'Browser is processing a job or session check. Try again when the queue is idle.' };
    this.inspecting = true;
    try { return await browser.sessionStatus(); }
    finally { this.inspecting = false; this.kick(); }
  }
  isBusy(): boolean { return this.running || this.inspecting || this.pendingAdmissions > 0; }
  async stop(): Promise<void> { this.stopped = true; await this.admissions; await this.active; }
}
