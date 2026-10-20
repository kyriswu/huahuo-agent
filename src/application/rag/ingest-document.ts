import { chunkMarkdown, normalizeMarkdown, sha256 } from './chunk-markdown.ts';
import { makeIdempotencyKey, type DocumentVersionStore } from './document-version-service.ts';
import {
  DocumentInputError,
  DocumentVersionConflictError,
  EmptyDocumentError,
  IngestError,
  RagError,
} from '../../extensions/huahuo/rag/errors.ts';
import type {
  IndexVersionKey,
  IngestDocumentResult,
  RAGChunkRow,
  RAGDocumentInput,
} from '../../extensions/huahuo/rag/types.ts';
import type { EmbeddingClient } from '../../adapters/rag/embedding-client.ts';
import type { RagChunkRepository } from '../../adapters/rag/milvus-rag-repository.ts';

export interface IngestDocumentOptions {
  pipelineVersion: string;
  embeddingModel: string;
  embeddingDimensions: number;
  maxTokens: number;
  overlapTokens: number;
  batchSize: number;
}

export interface IngestDocumentDependencies {
  embedding: EmbeddingClient;
  repository: RagChunkRepository;
  versionStore: DocumentVersionStore;
}

function validateInput(input: RAGDocumentInput): void {
  const required: Array<keyof RAGDocumentInput> = [
    'sourceId',
    'sourceType',
    'documentId',
    'documentVersion',
    'title',
    'tenantId',
    'ownerId',
    'knowledgeBaseId',
  ];
  for (const field of required) {
    if (typeof input[field] !== 'string' || input[field].trim().length === 0) {
      throw new DocumentInputError(`${field} is required`);
    }
  }
  if (typeof input.content !== 'string') throw new DocumentInputError('content must be a string');
}

function asErrorFields(error: unknown): { code: string; message: string } {
  if (error instanceof RagError) {
    return { code: error.code, message: error.message.slice(0, 300) };
  }
  if (error instanceof Error) return { code: 'INGEST_FAILED', message: error.message.slice(0, 300) };
  return { code: 'INGEST_FAILED', message: 'Unknown ingest failure' };
}

async function upsertBatches(
  rows: RAGChunkRow[],
  repository: RagChunkRepository,
  batchSize: number,
): Promise<void> {
  for (let offset = 0; offset < rows.length; offset += batchSize) {
    await repository.upsertChunks(rows.slice(offset, offset + batchSize));
  }
}

export async function ingestDocument(
  input: RAGDocumentInput,
  options: IngestDocumentOptions,
  dependencies: IngestDocumentDependencies,
): Promise<IngestDocumentResult> {
  validateInput(input);
  if (!Number.isInteger(options.embeddingDimensions) || options.embeddingDimensions <= 0) {
    throw new DocumentInputError('embeddingDimensions must be a positive integer');
  }
  if (!options.embeddingModel.trim() || !options.pipelineVersion.trim()) {
    throw new DocumentInputError('embeddingModel and pipelineVersion are required');
  }
  if (!Number.isInteger(options.batchSize) || options.batchSize <= 0) {
    throw new DocumentInputError('batchSize must be a positive integer');
  }

  const normalizedContent = normalizeMarkdown(input.content);
  const contentHash = sha256(normalizedContent);
  const key: IndexVersionKey = {
    documentId: input.documentId,
    documentVersion: input.documentVersion,
    contentHash,
    pipelineVersion: options.pipelineVersion,
    embeddingModel: options.embeddingModel,
    embeddingDimensions: options.embeddingDimensions,
  };
  const idempotencyKey = makeIdempotencyKey(key);
  const existing = await dependencies.versionStore.findByIdempotencyKey(idempotencyKey);
  if (existing?.status === 'ready' || existing?.status === 'visible') {
    return { ...existing, reused: true };
  }

  const sameDocumentVersion = await dependencies.versionStore.findByDocumentVersion(
    input.documentId,
    input.documentVersion,
  );
  if (sameDocumentVersion.some((record) => record.contentHash !== contentHash)) {
    throw new DocumentVersionConflictError(
      `Document version ${input.documentId}@${input.documentVersion} already has a different content hash`,
    );
  }

  await dependencies.versionStore.start({
    ...key,
    idempotencyKey,
    sourceId: input.sourceId,
    sourceType: input.sourceType,
  });

  try {
    const chunks = chunkMarkdown({
      documentId: input.documentId,
      documentVersion: input.documentVersion,
      content: normalizedContent,
      maxTokens: options.maxTokens,
      overlapTokens: options.overlapTokens,
      chunkerVersion: options.pipelineVersion,
    });
    if (chunks.length === 0) throw new EmptyDocumentError();

    const embeddings: number[][] = [];
    for (let offset = 0; offset < chunks.length; offset += options.batchSize) {
      const batch = await dependencies.embedding.embed(
        chunks.slice(offset, offset + options.batchSize).map((chunk) => chunk.text),
      );
      embeddings.push(...batch);
    }
    if (embeddings.length !== chunks.length) {
      throw new IngestError(`Embedding count ${embeddings.length} does not match chunk count ${chunks.length}`);
    }
    if (embeddings.some((vector) => vector.length !== options.embeddingDimensions)) {
      throw new IngestError(`Embedding dimension does not match configured dimension ${options.embeddingDimensions}`);
    }

    const rows: RAGChunkRow[] = chunks.map((chunk, index) => ({
      ...chunk,
      sourceId: input.sourceId,
      sourceType: input.sourceType,
      title: input.title,
      tenantId: input.tenantId,
      ownerId: input.ownerId,
      knowledgeBaseId: input.knowledgeBaseId,
      contentHash,
      pipelineVersion: options.pipelineVersion,
      documentVersionState: 'building',
      embeddingModel: options.embeddingModel,
      embeddingDimensions: options.embeddingDimensions,
      embedding: embeddings[index],
      metadata: input.metadata,
    }));

    await upsertBatches(rows, dependencies.repository, options.batchSize);
    const buildingCount = await dependencies.repository.countVersionChunks(key, 'building');
    if (buildingCount !== rows.length) {
      throw new IngestError(`Milvus verification found ${buildingCount} building chunks, expected ${rows.length}`);
    }

    const readyRows = rows.map((row) => ({ ...row, documentVersionState: 'ready' as const }));
    await upsertBatches(readyRows, dependencies.repository, options.batchSize);
    const readyCount = await dependencies.repository.countVersionChunks(key, 'ready');
    if (readyCount !== rows.length) {
      throw new IngestError(`Milvus verification found ${readyCount} ready chunks, expected ${rows.length}`);
    }

    const ready = await dependencies.versionStore.markStatus(idempotencyKey, 'ready', {
      chunkCount: rows.length,
    });
    const visible = await dependencies.versionStore.promoteVisible(idempotencyKey);
    return { ...visible, reused: false, status: visible.status ?? ready.status };
  } catch (error) {
    const fields = asErrorFields(error);
    await dependencies.versionStore.markStatus(idempotencyKey, 'failed', {
      errorCode: fields.code,
      errorMessage: fields.message,
    });
    if (error instanceof RagError) throw error;
    throw new IngestError(`Document ingest failed: ${fields.message}`, { cause: error });
  }
}

