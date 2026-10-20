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
  sourceId: string;
  sourceType: SourceType;
  status: IndexVersionStatus;
  chunkCount: number;
  errorCode?: string;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
}

export interface IngestDocumentResult extends IndexVersionRecord {
  reused: boolean;
}
