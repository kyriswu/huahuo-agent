import type {
  IngestionJobRecord,
  IndexVersionKey,
  IndexVersionRecord,
  IndexVersionStatus,
} from '../../extensions/huahuo/rag/types.ts';

export interface DocumentVersionStore {
  findByIdempotencyKey(idempotencyKey: string): Promise<IndexVersionRecord | undefined>;
  findByDocumentVersion(documentId: string, documentVersion: string): Promise<IndexVersionRecord[]>;
  start(
    key: IndexVersionKey & { idempotencyKey: string; sourceId: string; sourceType: IndexVersionRecord['sourceType']; runId?: string },
  ): Promise<IndexVersionRecord>;
  markStatus(
    idempotencyKey: string,
    status: IndexVersionStatus,
    fields?: Partial<Pick<IndexVersionRecord, 'chunkCount' | 'errorCode' | 'errorMessage'>>,
  ): Promise<IndexVersionRecord>;
  promoteVisible(idempotencyKey: string): Promise<IndexVersionRecord>;
}

export interface DocumentIngestionJobStore {
  createOrGetJob(input: {
    jobId?: string;
    idempotencyKey: string;
    runId: string;
    documentId: string;
    documentVersion: string;
    pipelineVersion: string;
  }): Promise<IngestionJobRecord>;
  claimJob(jobId: string, leaseOwner: string, leaseMs: number): Promise<IngestionJobRecord | undefined>;
  completeJob(jobId: string, leaseOwner: string, fencingToken: number): Promise<IngestionJobRecord>;
  failJob(
    jobId: string,
    leaseOwner: string,
    fencingToken: number,
    errorCode: string,
    errorMessage: string,
  ): Promise<IngestionJobRecord>;
  findRecoverableJobs(limit?: number): Promise<IngestionJobRecord[]>;
}

function now(): string {
  return new Date().toISOString();
}

export function makeIdempotencyKey(key: IndexVersionKey): string {
  return [
    key.documentId,
    key.documentVersion,
    key.contentHash,
    key.pipelineVersion,
    key.embeddingModel,
    key.embeddingDimensions,
  ].join(':');
}

/**
 * Process-local state store for tests and the mock flow.
 *
 * A production deployment must replace this with a durable index-state API or
 * database. Milvus rows alone cannot provide cross-process state recovery.
 */
export class InMemoryDocumentVersionStore implements DocumentVersionStore {
  private readonly records = new Map<string, IndexVersionRecord>();

  async findByIdempotencyKey(idempotencyKey: string): Promise<IndexVersionRecord | undefined> {
    const record = this.records.get(idempotencyKey);
    return record ? { ...record } : undefined;
  }

  async findByDocumentVersion(documentId: string, documentVersion: string): Promise<IndexVersionRecord[]> {
    return [...this.records.values()]
      .filter((record) => record.documentId === documentId && record.documentVersion === documentVersion)
      .map((record) => ({ ...record }));
  }

  async start(
    key: IndexVersionKey & {
      idempotencyKey: string;
      sourceId: string;
      sourceType: IndexVersionRecord['sourceType'];
      runId?: string;
    },
  ): Promise<IndexVersionRecord> {
    const existing = this.records.get(key.idempotencyKey);
    if (existing) {
      const updated = {
        ...existing,
        runId: key.runId ?? existing.runId,
        status: 'processing' as const,
        attemptCount: existing.attemptCount + 1,
        updatedAt: now(),
      };
      this.records.set(key.idempotencyKey, updated);
      return { ...updated };
    }
    const timestamp = now();
    const created: IndexVersionRecord = {
      ...key,
      runId: key.runId,
      status: 'pending',
      chunkCount: 0,
      attemptCount: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.records.set(key.idempotencyKey, created);
    const processing = { ...created, status: 'processing' as const, updatedAt: now() };
    this.records.set(key.idempotencyKey, processing);
    return { ...processing };
  }

  async markStatus(
    idempotencyKey: string,
    status: IndexVersionStatus,
    fields: Partial<Pick<IndexVersionRecord, 'chunkCount' | 'errorCode' | 'errorMessage'>> = {},
  ): Promise<IndexVersionRecord> {
    const existing = this.records.get(idempotencyKey);
    if (!existing) throw new Error(`Unknown index version: ${idempotencyKey}`);
    const updated = { ...existing, ...fields, status, updatedAt: now() };
    this.records.set(idempotencyKey, updated);
    return { ...updated };
  }

  async promoteVisible(idempotencyKey: string): Promise<IndexVersionRecord> {
    const next = this.records.get(idempotencyKey);
    if (!next || (next.status !== 'ready' && next.status !== 'visible')) {
      throw new Error('Only a ready index version can become visible');
    }
    for (const [key, record] of this.records) {
      if (record.documentId === next.documentId && record.status === 'visible' && key !== idempotencyKey) {
        this.records.set(key, { ...record, status: 'superseded', updatedAt: now() });
      }
    }
    const visible = { ...next, status: 'visible' as const, updatedAt: now() };
    this.records.set(idempotencyKey, visible);
    return { ...visible };
  }
}

/** Process-local job store used only by tests and failure-injection flows. */
export class InMemoryDocumentIngestionJobStore implements DocumentIngestionJobStore {
  private readonly jobs = new Map<string, IngestionJobRecord>();

  async createOrGetJob(input: {
    jobId?: string;
    idempotencyKey: string;
    runId: string;
    documentId: string;
    documentVersion: string;
    pipelineVersion: string;
  }): Promise<IngestionJobRecord> {
    const existing = this.jobs.get(input.idempotencyKey);
    if (existing) return { ...existing };
    const timestamp = now();
    const job: IngestionJobRecord = {
      jobId: input.jobId ?? input.idempotencyKey,
      idempotencyKey: input.idempotencyKey,
      runId: input.runId,
      documentId: input.documentId,
      documentVersion: input.documentVersion,
      pipelineVersion: input.pipelineVersion,
      status: 'pending',
      attemptCount: 0,
      fencingToken: 0,
      lastCompletedBatch: -1,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.jobs.set(job.idempotencyKey, job);
    return { ...job };
  }

  async claimJob(jobId: string, leaseOwner: string, leaseMs: number): Promise<IngestionJobRecord | undefined> {
    const job = [...this.jobs.values()].find((candidate) => candidate.jobId === jobId);
    if (!job) return undefined;
    const nowMs = Date.now();
    if (job.status === 'processing' && job.leaseUntil && Date.parse(job.leaseUntil) > nowMs) return undefined;
    const updated = {
      ...job,
      status: 'processing' as const,
      attemptCount: job.attemptCount + 1,
      leaseOwner,
      leaseUntil: new Date(nowMs + leaseMs).toISOString(),
      fencingToken: job.fencingToken + 1,
      updatedAt: now(),
    };
    this.jobs.set(job.idempotencyKey, updated);
    return { ...updated };
  }

  private findOwned(jobId: string, leaseOwner: string, fencingToken: number): IngestionJobRecord {
    const job = [...this.jobs.values()].find((candidate) => candidate.jobId === jobId);
    if (!job || job.status !== 'processing' || job.leaseOwner !== leaseOwner || job.fencingToken !== fencingToken) {
      throw new Error('INGESTION_JOB_FENCE_LOST');
    }
    return job;
  }

  async completeJob(jobId: string, leaseOwner: string, fencingToken: number): Promise<IngestionJobRecord> {
    const job = this.findOwned(jobId, leaseOwner, fencingToken);
    const updated = { ...job, status: 'completed' as const, leaseUntil: undefined, updatedAt: now() };
    this.jobs.set(job.idempotencyKey, updated);
    return { ...updated };
  }

  async failJob(
    jobId: string,
    leaseOwner: string,
    fencingToken: number,
    errorCode: string,
    errorMessage: string,
  ): Promise<IngestionJobRecord> {
    const job = this.findOwned(jobId, leaseOwner, fencingToken);
    const updated = {
      ...job,
      status: 'failed' as const,
      errorCode,
      errorMessage: errorMessage.slice(0, 300),
      leaseUntil: undefined,
      updatedAt: now(),
    };
    this.jobs.set(job.idempotencyKey, updated);
    return { ...updated };
  }

  async findRecoverableJobs(limit = 100): Promise<IngestionJobRecord[]> {
    const nowMs = Date.now();
    return [...this.jobs.values()]
      .filter((job) => job.status === 'pending' || job.status === 'retry_wait' || (job.status === 'processing' && (!job.leaseUntil || Date.parse(job.leaseUntil) <= nowMs)))
      .slice(0, limit)
      .map((job) => ({ ...job }));
  }
}

