import { createHash } from 'node:crypto';
import { Pool } from 'pg';
import { makeIdempotencyKey } from '../../application/rag/document-version-service.ts';
import type { PgClientLike, PgPoolLike } from './postgres-document-version-store.ts';
import type {
  IndexVersionKey,
  RAGChunkRow,
  RagChunkContentRecord,
  RagChunkContentStorePort,
} from '../../extensions/huahuo/rag/types.ts';

function asIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return new Date(String(value)).toISOString();
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string') {
    try { return JSON.parse(value) as T; } catch { return fallback; }
  }
  return value as T;
}

function hashText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function mapChunk(row: Record<string, unknown>): RagChunkContentRecord {
  return {
    idempotencyKey: String(row.idempotency_key),
    chunkId: String(row.chunk_id),
    documentId: String(row.document_id),
    documentVersion: String(row.document_version),
    chunkIndex: Number(row.chunk_index),
    text: String(row.text),
    headingPath: parseJson<string[]>(row.heading_path, []),
    startOffset: Number(row.start_offset),
    endOffset: Number(row.end_offset),
    tokenCount: Number(row.token_count),
    contentHash: String(row.chunk_hash),
    chunkerVersion: String(row.chunker_version),
    documentContentHash: String(row.document_content_hash),
    pipelineVersion: String(row.pipeline_version),
    documentVersionState: String(row.document_version_state) as RAGChunkRow['documentVersionState'],
    sourceId: String(row.source_id),
    sourceType: String(row.source_type) as RagChunkContentRecord['sourceType'],
    title: String(row.title),
    tenantId: String(row.tenant_id),
    ownerId: String(row.owner_id),
    knowledgeBaseId: String(row.knowledge_base_id),
    ...(row.run_id === null || row.run_id === undefined ? {} : { runId: String(row.run_id) }),
    metadata: parseJson<Record<string, unknown>>(row.metadata, {}),
    createdAt: asIso(row.created_at),
    updatedAt: asIso(row.updated_at),
  };
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

const SELECT_COLUMNS = `
  idempotency_key, chunk_id, document_id, document_version, pipeline_version,
  chunk_index, chunk_hash, document_content_hash, chunker_version, text,
  heading_path, start_offset, end_offset, token_count, source_id, source_type,
  title, tenant_id, owner_id, knowledge_base_id, run_id,
  document_version_state, metadata, created_at, updated_at`;

/** PostgreSQL canonical text store; it never stores embeddings. */
export class PostgresRagChunkStore implements RagChunkContentStorePort {
  private readonly pool: PgPoolLike;

  constructor(pool: PgPoolLike) {
    this.pool = pool;
  }

  static fromConnectionString(connectionString: string, options: { maxPoolSize?: number } = {}): PostgresRagChunkStore {
    if (!connectionString.trim()) throw new Error('RAG_STATE_DATABASE_URL is required');
    return new PostgresRagChunkStore(new Pool({ connectionString, max: options.maxPoolSize ?? 5 }));
  }

  async close(): Promise<void> {
    await this.pool.end?.();
  }

  async upsertChunks(rows: RAGChunkRow[]): Promise<void> {
    if (rows.length === 0) return;
    await transaction(this.pool, async (client) => {
      for (const row of rows) {
        const key = makeIdempotencyKey(row);
        await client.query(
          `INSERT INTO rag_chunk_contents (
             idempotency_key, chunk_id, document_id, document_version, pipeline_version,
             chunk_index, chunk_hash, document_content_hash, chunker_version, text,
             heading_path, start_offset, end_offset, token_count, source_id, source_type,
             title, tenant_id, owner_id, knowledge_base_id, run_id,
             document_version_state, metadata
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23::jsonb)
           ON CONFLICT (idempotency_key, chunk_id) DO UPDATE SET
             text = EXCLUDED.text,
             chunk_hash = EXCLUDED.chunk_hash,
             heading_path = EXCLUDED.heading_path,
             start_offset = EXCLUDED.start_offset,
             end_offset = EXCLUDED.end_offset,
             token_count = EXCLUDED.token_count,
             document_version_state = EXCLUDED.document_version_state,
             metadata = EXCLUDED.metadata,
             updated_at = NOW()` ,
          [
            key, row.chunkId, row.documentId, row.documentVersion, row.pipelineVersion,
            row.chunkIndex, hashText(row.text), row.contentHash, row.chunkerVersion, row.text,
            JSON.stringify(row.headingPath), row.startOffset, row.endOffset, row.tokenCount,
            row.sourceId, row.sourceType, row.title, row.tenantId, row.ownerId,
            row.knowledgeBaseId, row.runId ?? null, row.documentVersionState,
            JSON.stringify(row.metadata ?? {}),
          ],
        );
      }
    });
  }

  async findByChunkIds(chunkIds: string[], options: { tenantId?: string } = {}): Promise<RagChunkContentRecord[]> {
    const ids = [...new Set(chunkIds.filter((id) => id.trim()))];
    if (ids.length === 0) return [];
    const values: unknown[] = [ids];
    const conditions = ['chunk_id = ANY($1::text[])'];
    if (options.tenantId) { values.push(options.tenantId); conditions.push(`tenant_id = $${values.length}`); }
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT ${SELECT_COLUMNS} FROM rag_chunk_contents WHERE ${conditions.join(' AND ')} ORDER BY chunk_index ASC`,
      values,
    );
    return result.rows.map(mapChunk);
  }

  async findByVersion(key: IndexVersionKey, state?: RAGChunkRow['documentVersionState']): Promise<RagChunkContentRecord[]> {
    const values: unknown[] = [key.documentId, key.documentVersion, key.pipelineVersion, key.contentHash];
    const conditions = [
      'document_id = $1', 'document_version = $2', 'pipeline_version = $3',
      'document_content_hash = $4',
    ];
    if (state) { values.push(state); conditions.push(`document_version_state = $${values.length}`); }
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT ${SELECT_COLUMNS} FROM rag_chunk_contents WHERE ${conditions.join(' AND ')} ORDER BY chunk_index ASC`,
      values,
    );
    return result.rows.map(mapChunk);
  }
}
