import type {
  IndexVersionKey,
  IndexVersionRecord,
  IndexVersionStatus,
} from '../../extensions/huahuo/rag/types.ts';

export interface DocumentVersionStore {
  findByIdempotencyKey(idempotencyKey: string): Promise<IndexVersionRecord | undefined>;
  findByDocumentVersion(documentId: string, documentVersion: string): Promise<IndexVersionRecord[]>;
  start(
    key: IndexVersionKey & { idempotencyKey: string; sourceId: string; sourceType: IndexVersionRecord['sourceType'] },
  ): Promise<IndexVersionRecord>;
  markStatus(
    idempotencyKey: string,
    status: IndexVersionStatus,
    fields?: Partial<Pick<IndexVersionRecord, 'chunkCount' | 'errorCode' | 'errorMessage'>>,
  ): Promise<IndexVersionRecord>;
  promoteVisible(idempotencyKey: string): Promise<IndexVersionRecord>;
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
    },
  ): Promise<IndexVersionRecord> {
    const existing = this.records.get(key.idempotencyKey);
    if (existing) {
      const updated = { ...existing, status: 'processing' as const, updatedAt: now() };
      this.records.set(key.idempotencyKey, updated);
      return { ...updated };
    }
    const timestamp = now();
    const created: IndexVersionRecord = {
      ...key,
      status: 'pending',
      chunkCount: 0,
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

