import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import type {
  DocumentIngestionJobStore,
  DocumentVersionStore,
} from '../../application/rag/document-version-service.ts';
import { makeIdempotencyKey } from '../../application/rag/document-version-service.ts';
import {
  DocumentVersionConflictError,
  RagError,
} from '../../extensions/huahuo/rag/errors.ts';
import type {
  IngestionJobRecord,
  IndexVersionKey,
  IndexVersionRecord,
  IngestionJobStatus,
} from '../../extensions/huahuo/rag/types.ts';

export interface PgQueryResult<T> {
  rows: T[];
}

export interface PgClientLike {
  query<T = Record<string, unknown>>(text: string, values?: unknown[]): Promise<PgQueryResult<T>>;
  release(): void;
}

export interface PgPoolLike {
  query<T = Record<string, unknown>>(text: string, values?: unknown[]): Promise<PgQueryResult<T>>;
  connect(): Promise<PgClientLike>;
  end?(): Promise<void>;
}

export interface PostgresDocumentVersionStoreOptions {
  pool?: PgPoolLike;
  maxPoolSize?: number;
}

export interface RagDocumentHeadRecord {
  documentId: string;
  activeDocumentVersion?: string;
  activePipelineVersion?: string;
  generation: number;
  updatedAt: string;
}

function asIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return new Date(String(value)).toISOString();
}

function optionalIso(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : asIso(value);
}

function mapVersion(row: Record<string, unknown>): IndexVersionRecord {
  return {
    idempotencyKey: String(row.idempotency_key),
    documentId: String(row.document_id),
    documentVersion: String(row.document_version),
    contentHash: String(row.content_hash),
    pipelineVersion: String(row.pipeline_version),
    embeddingModel: String(row.embedding_model),
    embeddingDimensions: Number(row.embedding_dimensions),
    runId: row.run_id === null || row.run_id === undefined ? undefined : String(row.run_id),
    sourceId: String(row.source_id),
    sourceType: String(row.source_type) as IndexVersionRecord['sourceType'],
    status: String(row.status) as IndexVersionRecord['status'],
    chunkCount: Number(row.chunk_count),
    attemptCount: Number(row.attempt_count ?? 0),
    ...(row.error_code ? { errorCode: String(row.error_code) } : {}),
    ...(row.error_message ? { errorMessage: String(row.error_message) } : {}),
    createdAt: asIso(row.created_at),
    updatedAt: asIso(row.updated_at),
  };
}

function mapJob(row: Record<string, unknown>): IngestionJobRecord {
  return {
    jobId: String(row.job_id),
    idempotencyKey: String(row.idempotency_key),
    runId: String(row.run_id),
    documentId: String(row.document_id),
    documentVersion: String(row.document_version),
    pipelineVersion: String(row.pipeline_version),
    status: String(row.status) as IngestionJobStatus,
    attemptCount: Number(row.attempt_count),
    ...(row.next_attempt_at ? { nextAttemptAt: asIso(row.next_attempt_at) } : {}),
    ...(row.lease_owner ? { leaseOwner: String(row.lease_owner) } : {}),
    ...(row.lease_until ? { leaseUntil: asIso(row.lease_until) } : {}),
    fencingToken: Number(row.fencing_token),
    lastCompletedBatch: Number(row.last_completed_batch),
    ...(row.error_code ? { errorCode: String(row.error_code) } : {}),
    ...(row.error_message ? { errorMessage: String(row.error_message) } : {}),
    createdAt: asIso(row.created_at),
    updatedAt: asIso(row.updated_at),
  };
}

function stateError(message: string, cause?: unknown): RagError {
  return new RagError('INGEST_FAILED', message, { retryable: true, cause });
}

async function transaction<T>(pool: PgPoolLike, action: (client: PgClientLike) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await action(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

const VERSION_COLUMNS = `
  idempotency_key, document_id, document_version, content_hash,
  pipeline_version, embedding_model, embedding_dimensions, run_id,
  source_id, source_type, status, chunk_count, attempt_count,
  error_code, error_message, created_at, updated_at
`;

const VERSION_COLUMNS_ALIAS = `
  v.idempotency_key, v.document_id, v.document_version, v.content_hash,
  v.pipeline_version, v.embedding_model, v.embedding_dimensions, v.run_id,
  v.source_id, v.source_type, v.status, v.chunk_count, v.attempt_count,
  v.error_code, v.error_message, v.created_at, v.updated_at
`;

const JOB_COLUMNS = `
  job_id, idempotency_key, run_id, document_id, document_version,
  pipeline_version, status, attempt_count, next_attempt_at,
  lease_owner, lease_until, fencing_token, last_completed_batch,
  error_code, error_message, created_at, updated_at
`;

export class PostgresDocumentVersionStore implements DocumentVersionStore, DocumentIngestionJobStore {
  private readonly pool: PgPoolLike;

  constructor(pool: PgPoolLike) {
    this.pool = pool;
  }

  static fromConnectionString(connectionString: string, options: { maxPoolSize?: number } = {}): PostgresDocumentVersionStore {
    if (!connectionString.trim()) throw new Error('RAG_STATE_DATABASE_URL is required');
    const pool = new Pool({ connectionString, max: options.maxPoolSize ?? 5 });
    return new PostgresDocumentVersionStore(pool);
  }

  async close(): Promise<void> {
    await this.pool.end?.();
  }

  async ping(): Promise<void> {
    await this.pool.query('SELECT 1');
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<IndexVersionRecord | undefined> {
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT ${VERSION_COLUMNS} FROM rag_document_versions WHERE idempotency_key = $1`,
      [idempotencyKey],
    );
    return result.rows[0] ? mapVersion(result.rows[0]) : undefined;
  }

  async findByDocumentVersion(documentId: string, documentVersion: string): Promise<IndexVersionRecord[]> {
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT ${VERSION_COLUMNS} FROM rag_document_versions WHERE document_id = $1 AND document_version = $2 ORDER BY updated_at DESC`,
      [documentId, documentVersion],
    );
    return result.rows.map(mapVersion);
  }

  async listVersions(limit = 100): Promise<IndexVersionRecord[]> {
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT ${VERSION_COLUMNS} FROM rag_document_versions ORDER BY updated_at DESC LIMIT $1`,
      [limit],
    );
    return result.rows.map(mapVersion);
  }

  async listHeads(limit = 1000): Promise<RagDocumentHeadRecord[]> {
    if (!Number.isInteger(limit) || limit <= 0) throw new Error('limit must be a positive integer');
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT document_id, active_document_version, active_pipeline_version,
              generation, updated_at
       FROM rag_document_heads
       ORDER BY updated_at DESC LIMIT $1`,
      [limit],
    );
    return result.rows.map((row) => ({
      documentId: String(row.document_id),
      ...(row.active_document_version ? { activeDocumentVersion: String(row.active_document_version) } : {}),
      ...(row.active_pipeline_version ? { activePipelineVersion: String(row.active_pipeline_version) } : {}),
      generation: Number(row.generation),
      updatedAt: asIso(row.updated_at),
    }));
  }

  async findActiveVersion(documentId: string): Promise<IndexVersionRecord | undefined> {
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT ${VERSION_COLUMNS_ALIAS} FROM rag_document_heads h
       JOIN rag_document_versions v
         ON v.document_id = h.document_id
        AND v.document_version = h.active_document_version
        AND v.pipeline_version = h.active_pipeline_version
       WHERE h.document_id = $1 AND v.status = 'visible'`,
      [documentId],
    );
    return result.rows[0] ? mapVersion(result.rows[0]) : undefined;
  }

  async start(
    key: IndexVersionKey & {
      idempotencyKey: string;
      sourceId: string;
      sourceType: IndexVersionRecord['sourceType'];
      runId?: string;
    },
  ): Promise<IndexVersionRecord> {
    try {
      const result = await this.pool.query<Record<string, unknown>>(
        `INSERT INTO rag_document_versions (
          idempotency_key, document_id, document_version, content_hash,
          pipeline_version, embedding_model, embedding_dimensions, run_id,
          source_id, source_type, status, chunk_count, attempt_count
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'processing',0,1)
        ON CONFLICT (idempotency_key) DO UPDATE SET
          run_id = COALESCE(EXCLUDED.run_id, rag_document_versions.run_id),
          status = 'processing',
          attempt_count = rag_document_versions.attempt_count + 1,
          updated_at = NOW()
        RETURNING ${VERSION_COLUMNS}`,
        [
          key.idempotencyKey,
          key.documentId,
          key.documentVersion,
          key.contentHash,
          key.pipelineVersion,
          key.embeddingModel,
          key.embeddingDimensions,
          key.runId ?? null,
          key.sourceId,
          key.sourceType,
        ],
      );
      if (!result.rows[0]) throw stateError('PostgreSQL did not return the started document version');
      return mapVersion(result.rows[0]);
    } catch (error) {
      if (error instanceof RagError) throw error;
      if ((error as { code?: string }).code === '23505') {
        throw new DocumentVersionConflictError('Document version already exists with a different processing identity');
      }
      throw stateError('PostgreSQL failed to start document version', error);
    }
  }

  async markStatus(
    idempotencyKey: string,
    status: IndexVersionRecord['status'],
    fields: Partial<Pick<IndexVersionRecord, 'chunkCount' | 'errorCode' | 'errorMessage'>> = {},
  ): Promise<IndexVersionRecord> {
    const result = await this.pool.query<Record<string, unknown>>(
      `UPDATE rag_document_versions
       SET status = $2,
           chunk_count = COALESCE($3, chunk_count),
           error_code = $4,
           error_message = $5,
           updated_at = NOW()
       WHERE idempotency_key = $1
       RETURNING ${VERSION_COLUMNS}`,
      [idempotencyKey, status, fields.chunkCount ?? null, fields.errorCode ?? null, fields.errorMessage?.slice(0, 300) ?? null],
    );
    if (!result.rows[0]) throw stateError(`Unknown document version: ${idempotencyKey}`);
    return mapVersion(result.rows[0]);
  }

  async promoteVisible(idempotencyKey: string): Promise<IndexVersionRecord> {
    return transaction(this.pool, async (client) => {
      const nextResult = await client.query<Record<string, unknown>>(
        `SELECT ${VERSION_COLUMNS} FROM rag_document_versions WHERE idempotency_key = $1 FOR UPDATE`,
        [idempotencyKey],
      );
      if (!nextResult.rows[0]) throw stateError(`Unknown document version: ${idempotencyKey}`);
      const next = mapVersion(nextResult.rows[0]);
      if (next.status !== 'ready' && next.status !== 'visible') {
        throw new RagError('INDEX_VERSION_NOT_READY', 'Only a ready document version can become visible');
      }
      await client.query(
        `UPDATE rag_document_versions SET status = 'superseded', updated_at = NOW()
         WHERE document_id = $1 AND status = 'visible' AND idempotency_key <> $2`,
        [next.documentId, idempotencyKey],
      );
      const visibleResult = await client.query<Record<string, unknown>>(
        `UPDATE rag_document_versions SET status = 'visible', updated_at = NOW()
         WHERE idempotency_key = $1 RETURNING ${VERSION_COLUMNS}`,
        [idempotencyKey],
      );
      await client.query(
        `INSERT INTO rag_document_heads (document_id, active_document_version, active_pipeline_version, generation)
         VALUES ($1,$2,$3,1)
         ON CONFLICT (document_id) DO UPDATE SET
           active_document_version = EXCLUDED.active_document_version,
           active_pipeline_version = EXCLUDED.active_pipeline_version,
           generation = rag_document_heads.generation + 1,
           updated_at = NOW()`,
        [next.documentId, next.documentVersion, next.pipelineVersion],
      );
      if (!visibleResult.rows[0]) throw stateError('PostgreSQL did not return the visible document version');
      return mapVersion(visibleResult.rows[0]);
    });
  }

  async createOrGetJob(input: {
    jobId?: string;
    idempotencyKey: string;
    runId: string;
    documentId: string;
    documentVersion: string;
    pipelineVersion: string;
  }): Promise<IngestionJobRecord> {
    const jobId = input.jobId ?? randomUUID();
    return transaction(this.pool, async (client) => {
      await client.query(
        `INSERT INTO rag_ingestion_jobs (
          job_id, idempotency_key, run_id, document_id, document_version,
          pipeline_version, status
        ) VALUES ($1,$2,$3,$4,$5,$6,'pending')
        ON CONFLICT (idempotency_key) DO NOTHING`,
        [jobId, input.idempotencyKey, input.runId, input.documentId, input.documentVersion, input.pipelineVersion],
      );
      const result = await client.query<Record<string, unknown>>(
        `SELECT ${JOB_COLUMNS} FROM rag_ingestion_jobs WHERE idempotency_key = $1 FOR UPDATE`,
        [input.idempotencyKey],
      );
      if (!result.rows[0]) throw stateError('PostgreSQL did not return the ingestion job');
      return mapJob(result.rows[0]);
    });
  }

  async claimJob(jobId: string, leaseOwner: string, leaseMs: number): Promise<IngestionJobRecord | undefined> {
    if (!Number.isInteger(leaseMs) || leaseMs <= 0) throw new Error('leaseMs must be a positive integer');
    const result = await this.pool.query<Record<string, unknown>>(
      `UPDATE rag_ingestion_jobs
       SET status = 'processing',
           attempt_count = attempt_count + 1,
           lease_owner = $2,
           lease_until = NOW() + ($3 * INTERVAL '1 millisecond'),
           fencing_token = fencing_token + 1,
           updated_at = NOW()
       WHERE job_id = $1
         AND (status IN ('pending','retry_wait','failed')
              OR (status = 'processing' AND (lease_until IS NULL OR lease_until <= NOW())))
         AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())
       RETURNING ${JOB_COLUMNS}`,
      [jobId, leaseOwner, leaseMs],
    );
    return result.rows[0] ? mapJob(result.rows[0]) : undefined;
  }

  async completeJob(jobId: string, leaseOwner: string, fencingToken: number): Promise<IngestionJobRecord> {
    const result = await this.pool.query<Record<string, unknown>>(
      `UPDATE rag_ingestion_jobs
       SET status = 'completed', lease_owner = NULL, lease_until = NULL, updated_at = NOW()
       WHERE job_id = $1 AND status = 'processing' AND lease_owner = $2 AND fencing_token = $3
       RETURNING ${JOB_COLUMNS}`,
      [jobId, leaseOwner, fencingToken],
    );
    if (!result.rows[0]) throw stateError('INGESTION_JOB_FENCE_LOST');
    return mapJob(result.rows[0]);
  }

  async failJob(
    jobId: string,
    leaseOwner: string,
    fencingToken: number,
    errorCode: string,
    errorMessage: string,
  ): Promise<IngestionJobRecord> {
    const result = await this.pool.query<Record<string, unknown>>(
      `UPDATE rag_ingestion_jobs
       SET status = 'failed', lease_owner = NULL, lease_until = NULL,
           error_code = $4, error_message = $5, updated_at = NOW()
       WHERE job_id = $1 AND status = 'processing' AND lease_owner = $2 AND fencing_token = $3
       RETURNING ${JOB_COLUMNS}`,
      [jobId, leaseOwner, fencingToken, errorCode, errorMessage.slice(0, 300)],
    );
    if (!result.rows[0]) throw stateError('INGESTION_JOB_FENCE_LOST');
    return mapJob(result.rows[0]);
  }

  async findRecoverableJobs(limit = 100): Promise<IngestionJobRecord[]> {
    if (!Number.isInteger(limit) || limit <= 0) throw new Error('limit must be a positive integer');
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT ${JOB_COLUMNS} FROM rag_ingestion_jobs
       WHERE status IN ('pending','retry_wait')
          OR (status = 'processing' AND (lease_until IS NULL OR lease_until <= NOW()))
       ORDER BY updated_at ASC LIMIT $1`,
      [limit],
    );
    return result.rows.map(mapJob);
  }

  /** Utility for callers that need a deterministic idempotency key in task records. */
  static idempotencyKey(key: IndexVersionKey): string {
    return makeIdempotencyKey(key);
  }
}

