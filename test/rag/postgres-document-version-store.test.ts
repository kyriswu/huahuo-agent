import { describe, expect, it } from 'vitest';
import {
  InMemoryDocumentIngestionJobStore,
  InMemoryDocumentVersionStore,
} from '../../src/application/rag/document-version-service.ts';
import {
  PostgresDocumentVersionStore,
  type PgPoolLike,
  type PgClientLike,
} from '../../src/adapters/rag/postgres-document-version-store.ts';

const versionRow = {
  idempotency_key: 'doc:v1:hash:pipeline:model:3',
  document_id: 'doc',
  document_version: 'v1',
  content_hash: 'hash',
  pipeline_version: 'pipeline',
  embedding_model: 'model',
  embedding_dimensions: 3,
  run_id: 'run-1',
  source_id: 'source',
  source_type: 'article',
  status: 'processing',
  chunk_count: 0,
  attempt_count: 1,
  error_code: null,
  error_message: null,
  created_at: new Date('2026-01-01T00:00:00Z'),
  updated_at: new Date('2026-01-01T00:00:00Z'),
};

const jobRow = {
  job_id: 'job-1',
  idempotency_key: versionRow.idempotency_key,
  run_id: 'run-1',
  document_id: 'doc',
  document_version: 'v1',
  pipeline_version: 'pipeline',
  status: 'pending',
  attempt_count: 0,
  next_attempt_at: null,
  lease_owner: null,
  lease_until: null,
  fencing_token: 0,
  last_completed_batch: -1,
  error_code: null,
  error_message: null,
  created_at: new Date('2026-01-01T00:00:00Z'),
  updated_at: new Date('2026-01-01T00:00:00Z'),
};

class FakePool implements PgPoolLike, PgClientLike {
  readonly queries: string[] = [];

  async query<T = Record<string, unknown>>(text: string): Promise<{ rows: T[] }> {
    this.queries.push(text);
    if (text.includes('INSERT INTO rag_document_versions')) return { rows: [versionRow as T] };
    if (text.includes('SELECT') && text.includes('rag_document_versions')) return { rows: [versionRow as T] };
    if (text.includes('SELECT') && text.includes('rag_ingestion_jobs')) return { rows: [jobRow as T] };
    if (text.includes('INSERT INTO rag_ingestion_jobs')) return { rows: [] };
    return { rows: [] };
  }

  async connect(): Promise<PgClientLike> {
    return this;
  }

  release(): void {}
}

describe('PostgresDocumentVersionStore and job state', () => {
  it('maps durable document version and job records without exposing credentials', async () => {
    const pool = new FakePool();
    const store = new PostgresDocumentVersionStore(pool);
    const version = await store.start({
      idempotencyKey: versionRow.idempotency_key,
      documentId: 'doc',
      documentVersion: 'v1',
      contentHash: 'hash',
      pipelineVersion: 'pipeline',
      embeddingModel: 'model',
      embeddingDimensions: 3,
      sourceId: 'source',
      sourceType: 'article',
      runId: 'run-1',
    });
    expect(version.runId).toBe('run-1');
    expect(version.attemptCount).toBe(1);
    const job = await store.createOrGetJob({
      idempotencyKey: version.idempotencyKey,
      runId: 'run-1',
      documentId: 'doc',
      documentVersion: 'v1',
      pipelineVersion: 'pipeline',
      jobId: 'job-1',
    });
    expect(job.jobId).toBe('job-1');
    expect(pool.queries.every((query) => !query.includes('password') && !query.includes('apiKey'))).toBe(true);
  });

  it('supports process-local lease fencing for Mock recovery tests', async () => {
    const jobs = new InMemoryDocumentIngestionJobStore();
    const created = await jobs.createOrGetJob({
      idempotencyKey: 'key',
      runId: 'run',
      documentId: 'doc',
      documentVersion: 'v1',
      pipelineVersion: 'v1',
      jobId: 'job',
    });
    const claimed = await jobs.claimJob(created.jobId, 'worker-a', 60_000);
    expect(claimed?.fencingToken).toBe(1);
    await expect(jobs.claimJob(created.jobId, 'worker-b', 60_000)).resolves.toBeUndefined();
    await expect(jobs.completeJob(created.jobId, 'worker-a', 1)).resolves.toMatchObject({ status: 'completed' });
  });

  it('tracks retry attempts in the in-memory version test implementation', async () => {
    const store = new InMemoryDocumentVersionStore();
    const key = {
      idempotencyKey: 'key',
      documentId: 'doc',
      documentVersion: 'v1',
      contentHash: 'hash',
      pipelineVersion: 'v1',
      embeddingModel: 'model',
      embeddingDimensions: 3,
      sourceId: 'source',
      sourceType: 'article' as const,
      runId: 'run',
    };
    await store.start(key);
    await store.markStatus('key', 'failed', { errorCode: 'TEST_FAILURE' });
    const retry = await store.start(key);
    expect(retry.attemptCount).toBe(2);
    expect(retry.runId).toBe('run');
  });
});

