import { randomUUID } from 'node:crypto';
import { chunkMarkdown, normalizeMarkdown, sha256 } from './chunk-markdown.ts';
import {
  makeIdempotencyKey,
  type DocumentIngestionJobStore,
  type DocumentVersionStore,
} from './document-version-service.ts';
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
  EmbeddingClientPort,
  RagChunkContentStorePort,
  RagChunkRepositoryPort,
} from '../../extensions/huahuo/rag/types.ts';

export interface IngestDocumentOptions {
  pipelineVersion: string;
  embeddingModel: string;
  embeddingDimensions: number;
  maxTokens: number;
  overlapTokens: number;
  batchSize: number;
  runId?: string;
}

export interface IngestDocumentDependencies {
  embedding: EmbeddingClientPort;
  repository: RagChunkRepositoryPort;
  /** Canonical text/metadata store, normally PostgreSQL. */
  contentStore?: RagChunkContentStorePort;
  versionStore: DocumentVersionStore;
  jobStore?: DocumentIngestionJobStore;
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
  if (!['article', 'file', 'note'].includes(input.sourceType)) {
    throw new DocumentInputError('sourceType must be article, file, or note');
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
  repository: RagChunkRepositoryPort,
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
  const runId = options.runId ?? input.runId ?? idempotencyKey;
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

  let claimedJob: { jobId: string; leaseOwner: string; fencingToken: number } | undefined;
  if (dependencies.jobStore) {
    const job = await dependencies.jobStore.createOrGetJob({
      idempotencyKey,
      runId,
      documentId: input.documentId,
      documentVersion: input.documentVersion,
      pipelineVersion: options.pipelineVersion,
    });
    if (job.status === 'completed') {
      const completed = await dependencies.versionStore.findByIdempotencyKey(idempotencyKey);
      if (completed?.status === 'ready' || completed?.status === 'visible') {
        return { ...completed, reused: true };
      }
    }
    const leaseOwner = `ingest-${process.pid}-${randomUUID()}`;
    const claimed = await dependencies.jobStore.claimJob(job.jobId, leaseOwner, 5 * 60_000);
    if (!claimed) throw new IngestError('Ingestion job is already processing under another lease');
    claimedJob = { jobId: claimed.jobId, leaseOwner, fencingToken: claimed.fencingToken };
  }

  try {
    await dependencies.versionStore.start({
      ...key,
      idempotencyKey,
      sourceId: input.sourceId,
      sourceType: input.sourceType,
      runId,
    });
  } catch (error) {
    if (claimedJob && dependencies.jobStore) {
      await dependencies.jobStore.failJob(
        claimedJob.jobId,
        claimedJob.leaseOwner,
        claimedJob.fencingToken,
        'STATE_STORE_START_FAILED',
        error instanceof Error ? error.message : 'state store start failed',
      ).catch(() => undefined);
    }
    throw error;
  }

  let promoted = false;
  try {
    const chunks = chunkMarkdown({
      documentId: input.documentId,
      documentVersion: input.documentVersion,
      title: input.title,
      content: normalizedContent,
      sourceType: input.sourceType,
      metadata: input.metadata,
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
      runId,
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

    // Keep the canonical chunk text in the durable content store.  It is
    // written in the building state first, then promoted together with the
    // vector rows after Milvus verification.  This makes retries idempotent
    // and prevents an incomplete index from becoming visible to retrieval.
    await dependencies.contentStore?.upsertChunks(rows);
    await upsertBatches(rows, dependencies.repository, options.batchSize);
    const buildingCount = await dependencies.repository.countVersionChunks(key, 'building');
    if (buildingCount !== rows.length) {
      throw new IngestError(`Milvus verification found ${buildingCount} building chunks, expected ${rows.length}`);
    }

    const readyRows = rows.map((row) => ({ ...row, documentVersionState: 'ready' as const }));
    await upsertBatches(readyRows, dependencies.repository, options.batchSize);
    await dependencies.contentStore?.upsertChunks(readyRows);
    const readyCount = await dependencies.repository.countVersionChunks(key, 'ready');
    if (readyCount !== rows.length) {
      throw new IngestError(`Milvus verification found ${readyCount} ready chunks, expected ${rows.length}`);
    }

    const ready = await dependencies.versionStore.markStatus(idempotencyKey, 'ready', {
      chunkCount: rows.length,
    });
    const visible = await dependencies.versionStore.promoteVisible(idempotencyKey);
    promoted = true;
    if (claimedJob && dependencies.jobStore) {
      await dependencies.jobStore.completeJob(
        claimedJob.jobId,
        claimedJob.leaseOwner,
        claimedJob.fencingToken,
      );
    }
    return { ...visible, reused: false, status: visible.status ?? ready.status };
  } catch (error) {
    const fields = asErrorFields(error);
    if (!promoted) {
      await dependencies.versionStore.markStatus(idempotencyKey, 'failed', {
        errorCode: fields.code,
        errorMessage: fields.message,
      });
    }
    if (claimedJob && dependencies.jobStore && !promoted) {
      await dependencies.jobStore.failJob(
        claimedJob.jobId,
        claimedJob.leaseOwner,
        claimedJob.fencingToken,
        fields.code,
        fields.message,
      ).catch(() => undefined);
    }
    if (error instanceof RagError) throw error;
    throw new IngestError(`Document ingest failed: ${fields.message}`, { cause: error });
  }
}

