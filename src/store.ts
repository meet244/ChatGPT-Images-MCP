import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';

export type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
export type ChatMode = 'same_chat' | 'separate_chats';
export interface ImageArtifact { path: string; mimeType: string; bytes: number; }
export type UsageLimitCode = 'free_tier_exhausted' | 'image_usage_limit';
export interface ImageCooldown {
  errorCode: UsageLimitCode;
  error: string;
  detectedAt: string;
  retryAfter: string;
  limitReset?: string;
}
export const imageCooldownMs = 24 * 60 * 60 * 1000;
export interface JobAttempt {
  batchAttempt: number;
  status: JobStatus;
  conversationUrl?: string;
  images?: ImageArtifact[];
  executionAccount?: string;
  attemptedAccounts?: string[];
  error?: string;
}
export interface Job {
  id: string;
  prompt: string;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  conversationUrl?: string;
  images?: ImageArtifact[];
  referenceImages?: ImageArtifact[];
  aspectRatio?: string;
  batchId?: string;
  batchIndex?: number;
  chatMode?: ChatMode;
  error?: string;
  errorCode?: UsageLimitCode;
  limitReset?: string;
  limitDetectedAt?: string;
  retryAfter?: string;
  /** The owning database stays fixed even when execution switches profiles. */
  autoSwitchAccount?: boolean;
  executionAccount?: string;
  attemptedAccounts?: string[];
  sameChatMandatory?: boolean;
  batchAttempt?: number;
  batchExecutionAccount?: string;
  batchTriedAccounts?: string[];
  previousAttempts?: JobAttempt[];
}
export interface Batch {
  id: string;
  chatMode: ChatMode;
  aspectRatio?: string;
  status: JobStatus;
  total: number;
  progress: Record<JobStatus, number>;
  jobs: Job[];
  sameChatMandatory: boolean;
  attempt: number;
}

export class JobStore {
  private db: Database.Database;
  constructor(readonly dataDir: string, private now: () => number = Date.now) {
    this.db = new Database(path.join(dataDir, 'jobs.sqlite'));
    this.db.pragma('journal_mode = WAL');
    this.db.exec('CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, status TEXT NOT NULL, body TEXT NOT NULL)');
    this.db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, body TEXT NOT NULL)');
    // Upgrade existing profiles using the latest already-recorded limit. Never
    // reset the timestamp merely because a worker or MCP client restarts.
    if (!this.db.prepare('SELECT 1 FROM settings WHERE key = ?').get('image_cooldown')) {
      const previous = this.db.prepare("SELECT body FROM jobs WHERE status = 'failed' AND json_extract(body, '$.errorCode') IN ('free_tier_exhausted', 'image_usage_limit') ORDER BY COALESCE(json_extract(body, '$.limitDetectedAt'), json_extract(body, '$.updatedAt')) DESC LIMIT 1").get() as { body: string } | undefined;
      if (previous) {
        const job = JSON.parse(previous.body) as Job;
        const cooldown = this.recordImageLimit(job.errorCode!, job.error ?? 'ChatGPT image allowance is exhausted.', job.limitReset, job.limitDetectedAt ?? job.updatedAt);
        this.update(job.id, { limitDetectedAt: cooldown.detectedAt, retryAfter: cooldown.retryAfter });
      }
    }
    // A running job might already have been submitted. Never resubmit it automatically.
    for (const job of this.byStatus('running')) this.update(job.id, { status: 'failed', error: 'Server stopped during generation. Check the ChatGPT conversation before submitting again.' });
    for (const job of this.byStatus('failed')) {
      if (job.batchId) this.stopBatch(job.batchId, `Batch stopped after job ${job.id} failed. Check its conversation before starting another batch.`);
    }
  }
  recordImageLimit(errorCode: UsageLimitCode, error: string, limitReset?: string, detectedAt = new Date(this.now()).toISOString()): ImageCooldown {
    const detected = Date.parse(detectedAt);
    if (!Number.isFinite(detected)) throw new Error('The saved image-limit timestamp is invalid.');
    const cooldown: ImageCooldown = { errorCode, error, detectedAt,
      retryAfter: new Date(detected + imageCooldownMs).toISOString(), ...(limitReset ? { limitReset } : {}) };
    this.db.prepare('INSERT INTO settings (key, body) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET body = excluded.body').run('image_cooldown', JSON.stringify(cooldown));
    return cooldown;
  }
  imageCooldown(): ImageCooldown | undefined {
    const row = this.db.prepare('SELECT body FROM settings WHERE key = ?').get('image_cooldown') as { body: string } | undefined;
    if (!row) return;
    const cooldown = JSON.parse(row.body) as ImageCooldown;
    if (!['free_tier_exhausted', 'image_usage_limit'].includes(cooldown.errorCode)
      || !Number.isFinite(Date.parse(cooldown.detectedAt)) || !Number.isFinite(Date.parse(cooldown.retryAfter))) throw new Error('The saved image cooldown is invalid.');
    return this.now() < Date.parse(cooldown.retryAfter) ? cooldown : undefined;
  }
  /** Persist per executing profile, including requests owned by another account. */
  recordTextOnlyFailure(): ImageCooldown | undefined {
    return this.db.transaction(() => {
      const row = this.db.prepare('SELECT body FROM settings WHERE key = ?').get('text_only_failures') as { body: string } | undefined;
      const previous = row ? JSON.parse(row.body) as { count: number; lastFailureAt: number } : undefined;
      const now = this.now();
      // A streak must not immediately exhaust the account again after its cooldown expires.
      const count = previous && now - previous.lastFailureAt < imageCooldownMs ? previous.count + 1 : 1;
      this.db.prepare('INSERT INTO settings (key, body) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET body = excluded.body')
        .run('text_only_failures', JSON.stringify({ count, lastFailureAt: now }));
      if (count < 2) return;
      return this.recordImageLimit('image_usage_limit', 'Assumed ChatGPT image limit exhausted after two consecutive completed text-only responses without an image.');
    })();
  }
  resetTextOnlyFailures(): void {
    this.db.prepare('DELETE FROM settings WHERE key = ?').run('text_only_failures');
  }
  create(prompt: string, referenceImages: ImageArtifact[] = [], aspectRatio?: string): Job {
    const now = new Date().toISOString();
    const job: Job = { id: randomUUID(), prompt, status: 'queued', createdAt: now, updatedAt: now,
      ...(referenceImages.length ? { referenceImages } : {}),
      ...(aspectRatio !== undefined ? { aspectRatio } : {}) };
    this.db.prepare('INSERT INTO jobs VALUES (?, ?, ?, ?)').run(job.id, now, job.status, JSON.stringify(job));
    return job;
  }
  createBatch(prompts: string[], chatMode: ChatMode, referenceImages: ImageArtifact[] = [], aspectRatio?: string, autoSwitchAccount = false, sameChatMandatory = false): Batch {
    if (!prompts.length || prompts.length > 25) throw new Error('A batch requires 1–25 prompts.');
    if (sameChatMandatory && chatMode !== 'same_chat') throw new Error('Mandatory same-chat batches cannot use separate chats.');
    const batchId = randomUUID();
    this.db.transaction(() => {
      for (const [batchIndex, prompt] of prompts.entries()) {
        const job = this.create(prompt, referenceImages, aspectRatio);
        this.update(job.id, { batchId, batchIndex, chatMode, ...(autoSwitchAccount ? { autoSwitchAccount } : {}),
          ...(sameChatMandatory ? { sameChatMandatory, batchAttempt: 0 } : {}) });
      }
    })();
    return this.getBatch(batchId);
  }
  getBatch(id: string): Batch {
    const jobs = (this.db.prepare("SELECT body FROM jobs WHERE json_extract(body, '$.batchId') = ? ORDER BY rowid").all(id) as { body: string }[])
      .map(row => JSON.parse(row.body) as Job);
    if (!jobs.length) throw new Error('Batch not found.');
    const progress: Record<JobStatus, number> = { queued: 0, running: 0, completed: 0, failed: 0, cancelled: 0 };
    for (const job of jobs) progress[job.status]++;
    const status: JobStatus = progress.running ? 'running' : progress.queued ? 'queued'
      : progress.failed ? 'failed' : progress.cancelled ? 'cancelled' : 'completed';
    return { id, chatMode: jobs[0]!.chatMode!, ...(jobs[0]!.aspectRatio !== undefined ? { aspectRatio: jobs[0]!.aspectRatio } : {}), status, total: jobs.length, progress, jobs,
      sameChatMandatory: jobs[0]!.sameChatMandatory ?? false, attempt: jobs[0]!.batchAttempt ?? 0 };
  }
  /** Keep original IDs and files; prior partial results are archived instead of mixed into the new batch. */
  restartBatch(id: string, account: string, failedJobId: string, reason: string): void {
    this.db.transaction(() => {
      const batch = this.getBatch(id);
      if (!batch.sameChatMandatory) throw new Error('Only a mandatory same-chat batch may be restarted.');
      const tried = [...new Set([...batch.jobs.flatMap(job => job.batchTriedAccounts ?? []),
        ...batch.jobs.flatMap(job => job.attemptedAccounts ?? []), account])];
      for (const job of batch.jobs) {
        const previousAttempts = [...(job.previousAttempts ?? [])];
        if (job.status === 'completed' || job.status === 'running') {
          previousAttempts.push({ batchAttempt: job.batchAttempt ?? 0, status: job.id === failedJobId ? 'failed' : job.status,
            conversationUrl: job.conversationUrl, images: job.images, executionAccount: job.executionAccount,
            attemptedAccounts: job.attemptedAccounts, ...(job.id === failedJobId ? { error: reason } : {}) });
        }
        this.update(job.id, { batchAttempt: batch.attempt + 1, batchExecutionAccount: account, batchTriedAccounts: tried,
          ...(job.status !== 'cancelled' ? { status: 'queued', conversationUrl: undefined, images: undefined,
            executionAccount: undefined, attemptedAccounts: undefined, error: undefined, errorCode: undefined,
            limitReset: undefined, limitDetectedAt: undefined, retryAfter: undefined, previousAttempts } : {}) });
      }
    })();
  }
  /** Reserve space to replay a mandatory batch even after some of its jobs have completed. */
  queueCapacityUsed(): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS count FROM jobs AS job WHERE status = 'queued'
      OR (status IN ('running', 'completed') AND json_extract(body, '$.sameChatMandatory') = 1
        AND EXISTS (SELECT 1 FROM jobs AS pending WHERE pending.status IN ('queued', 'running')
          AND json_extract(pending.body, '$.batchId') = json_extract(job.body, '$.batchId')))`)
      .get() as { count: number };
    return row.count;
  }
  stopBatch(id: string, reason: string): void {
    this.db.transaction(() => {
      for (const job of this.getBatch(id).jobs) {
        if (job.status === 'queued') this.update(job.id, { status: 'cancelled', error: reason });
      }
    })();
  }
  get(id: string): Job {
    const row = this.db.prepare('SELECT body FROM jobs WHERE id = ?').get(id) as { body: string } | undefined;
    if (!row) throw new Error('Job not found.');
    return JSON.parse(row.body) as Job;
  }
  update(id: string, patch: Partial<Omit<Job, 'id' | 'createdAt' | 'prompt'>>): Job {
    const job = { ...this.get(id), ...patch, updatedAt: new Date().toISOString() };
    this.db.prepare('UPDATE jobs SET status = ?, body = ? WHERE id = ?').run(job.status, JSON.stringify(job), id);
    return job;
  }
  byStatus(status: JobStatus): Job[] {
    return (this.db.prepare('SELECT body FROM jobs WHERE status = ? ORDER BY rowid').all(status) as { body: string }[]).map(row => JSON.parse(row.body) as Job);
  }
  list(limit = 20): Job[] {
    return (this.db.prepare('SELECT body FROM jobs ORDER BY created_at DESC, rowid DESC LIMIT ?').all(limit) as { body: string }[]).map(row => JSON.parse(row.body) as Job);
  }
  close(): void { this.db.close(); }
}
