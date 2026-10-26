export type SourceType = 'article' | 'file' | 'note';

export type IndexVersionStatus =
  | 'pending'
  | 'processing'
  | 'ready'
  | 'failed'
  | 'visible'
  | 'superseded';

export interface RAGDocumentInput {
  sourceId: string;
  sourceType: SourceType;
  documentId: string;
  documentVersion: string;
  title: string;
  content: string;
  tenantId: string;
  ownerId: string;
  knowledgeBaseId: string;
  /** Unique ingestion/acceptance run identifier for traceability. */
  runId?: string;
  metadata?: Record<string, unknown>;
}

export interface MarkdownChunk {
  chunkId: string;
  documentId: string;
  documentVersion: string;
  chunkIndex: number;
  text: string;
  headingPath: string[];
  startOffset: number;
  endOffset: number;
  tokenCount: number;
  contentHash: string;
  chunkerVersion: string;
}

export interface RAGChunkRow extends MarkdownChunk {
  runId?: string;
  sourceId: string;
  sourceType: SourceType;
  title: string;
  tenantId: string;
  ownerId: string;
  knowledgeBaseId: string;
  contentHash: string;
  pipelineVersion: string;
  documentVersionState: 'building' | 'ready' | 'retired' | 'deleted';
  embeddingModel: string;
  embeddingDimensions: number;
  embedding: number[];
  metadata?: Record<string, unknown>;
}

export interface IndexVersionKey {
  documentId: string;
  documentVersion: string;
  contentHash: string;
  pipelineVersion: string;
  embeddingModel: string;
  embeddingDimensions: number;
}

export interface IndexVersionRecord extends IndexVersionKey {
  idempotencyKey: string;
  runId?: string;
  sourceId: string;
  sourceType: SourceType;
  status: IndexVersionStatus;
  chunkCount: number;
  attemptCount: number;
  errorCode?: string;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
}

export interface IngestDocumentResult extends IndexVersionRecord {
  reused: boolean;
}

export type IngestionJobStatus =
  | 'pending'
  | 'processing'
  | 'retry_wait'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface IngestionJobRecord {
  jobId: string;
  idempotencyKey: string;
  runId: string;
  documentId: string;
  documentVersion: string;
  pipelineVersion: string;
  status: IngestionJobStatus;
  attemptCount: number;
  nextAttemptAt?: string;
  leaseOwner?: string;
  leaseUntil?: string;
  fencingToken: number;
  lastCompletedBatch: number;
  errorCode?: string;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
}

/** Application ports implemented by external adapters. */
export interface EmbeddingClientPort {
  embed(texts: string[]): Promise<number[][]>;
}

export interface RagChunkRepositoryPort {
  ensureReady(vectorDimensions: number): Promise<void>;
  upsertChunks(rows: RAGChunkRow[]): Promise<void>;
  countVersionChunks(key: IndexVersionKey, state: RAGChunkRow['documentVersionState']): Promise<number>;
}

/**
 * Canonical chunk content is kept outside the vector index.  Implementations
 * may use PostgreSQL or an object store; the Milvus adapter remains concerned
 * with vectors and retrieval metadata only.
 */
export interface RagChunkContentRecord extends MarkdownChunk {
  idempotencyKey: string;
  runId?: string;
  sourceId: string;
  sourceType: SourceType;
  title: string;
  tenantId: string;
  ownerId: string;
  knowledgeBaseId: string;
  documentContentHash: string;
  pipelineVersion: string;
  documentVersionState: RAGChunkRow['documentVersionState'];
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface RagChunkContentStorePort {
  upsertChunks(rows: RAGChunkRow[]): Promise<void>;
  findByChunkIds(chunkIds: string[], options?: { tenantId?: string }): Promise<RagChunkContentRecord[]>;
  findByVersion(
    key: IndexVersionKey,
    state?: RAGChunkRow['documentVersionState'],
  ): Promise<RagChunkContentRecord[]>;
}
