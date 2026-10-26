import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { createEmbeddingClient } from '../src/adapters/rag/embedding-client.ts';
import { MilvusRagRepository } from '../src/adapters/rag/milvus-rag-repository.ts';
import { PostgresDocumentVersionStore } from '../src/adapters/rag/postgres-document-version-store.ts';
import { PostgresRagChunkStore } from '../src/adapters/rag/postgres-rag-chunk-store.ts';
import { parseDocument } from '../src/application/rag/document-parser.ts';
import { ingestDocument } from '../src/application/rag/ingest-document.ts';
import { InMemoryDocumentVersionStore } from '../src/application/rag/document-version-service.ts';
import {
  loadMilvusConnectionConfig,
} from '../src/extensions/huahuo/rag/milvus-poc-config.ts';
import {
  loadRagConfig,
  requireRealEmbeddingConfig,
} from '../src/extensions/huahuo/rag/config.ts';
import { RagConfigurationError } from '../src/extensions/huahuo/rag/errors.ts';
import { loadRagStateDatabaseConfig } from '../src/extensions/huahuo/rag/state-config.ts';
import type { SourceType } from '../src/extensions/huahuo/rag/types.ts';
import { createMilvusClient, classifyMilvusError, safeMilvusMessage } from '../src/adapters/rag/milvus-client.ts';

const startedAt = Date.now();

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new RagConfigurationError(`Missing required environment variable: ${name}`);
  return value;
}

async function main(): Promise<void> {
  const filePath = required('RAG_INGEST_MARKDOWN_PATH');
  const ragConfig = loadRagConfig();
  const embeddingConfig = requireRealEmbeddingConfig(ragConfig);
  const useProcessLocalState = process.env.RAG_INGEST_PROCESS_LOCAL_STATE === 'true';
  const state = useProcessLocalState
    ? undefined
    : loadRagStateDatabaseConfig(process.env, { requireTarget: true });
  const versionStore = useProcessLocalState
    ? new InMemoryDocumentVersionStore()
    : PostgresDocumentVersionStore.fromConnectionString(state!.url);
  const contentStore = state ? PostgresRagChunkStore.fromConnectionString(state.url) : undefined;
  if (versionStore instanceof PostgresDocumentVersionStore) await versionStore.ping();
  const sourceType = required('RAG_INGEST_SOURCE_TYPE') as SourceType;
  if (!['article', 'file', 'note'].includes(sourceType)) {
    throw new RagConfigurationError('RAG_INGEST_SOURCE_TYPE must be article, file, or note');
  }
  const parsed = await parseDocument({
    content: await readFile(filePath),
    fileName: basename(filePath),
    title: process.env.RAG_INGEST_TITLE?.trim() || basename(filePath),
  });
  const client = await createMilvusClient(loadMilvusConnectionConfig());
  try {
    const repository = new MilvusRagRepository(client, ragConfig.ragCollection);
    await repository.ensureReady(embeddingConfig.dimensions);
    const result = await ingestDocument(
      {
        sourceId: required('RAG_INGEST_SOURCE_ID'),
        sourceType,
        documentId: required('RAG_INGEST_DOCUMENT_ID'),
        documentVersion: required('RAG_INGEST_DOCUMENT_VERSION'),
        title: parsed.title || basename(filePath),
        content: parsed.content,
        tenantId: required('RAG_INGEST_TENANT_ID'),
        ownerId: required('RAG_INGEST_OWNER_ID'),
        knowledgeBaseId: required('RAG_INGEST_KNOWLEDGE_BASE_ID'),
        metadata: {
          ...(parsed.metadata ?? {}),
          parserVersion: parsed.parserVersion,
          format: parsed.format,
        },
      },
      {
        pipelineVersion: ragConfig.ingest.pipelineVersion,
        embeddingModel: embeddingConfig.model,
        embeddingDimensions: embeddingConfig.dimensions,
        maxTokens: ragConfig.chunking.maxTokens,
        overlapTokens: ragConfig.chunking.overlapTokens,
        batchSize: ragConfig.ingest.batchSize,
      },
      {
        embedding: createEmbeddingClient(ragConfig.embedding),
        repository,
        ...(contentStore ? { contentStore } : {}),
        versionStore,
        ...(versionStore instanceof PostgresDocumentVersionStore ? { jobStore: versionStore } : {}),
      },
    );
    console.log(JSON.stringify({
      ok: true,
      successCount: 1,
      failureCount: 0,
      durationMs: Date.now() - startedAt,
      collection: ragConfig.ragCollection,
      statePersistence: useProcessLocalState ? 'process-local-only' : 'postgres',
      documentId: result.documentId,
      documentVersion: result.documentVersion,
      contentHash: result.contentHash,
      pipelineVersion: result.pipelineVersion,
      chunkCount: result.chunkCount,
      status: result.status,
      reusedWithinProcess: result.reused,
    }));
  } finally {
    await client.closeConnection();
    if (versionStore instanceof PostgresDocumentVersionStore) await versionStore.close();
    await contentStore?.close();
  }
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({
    ok: false,
    status: error instanceof RagConfigurationError ? 'BLOCKED' : 'FAIL',
    exitCode: error instanceof RagConfigurationError ? 2 : 1,
    successCount: 0,
    failureCount: 1,
    durationMs: Date.now() - startedAt,
    errorKind: error instanceof RagConfigurationError ? 'configuration' : classifyMilvusError(error),
    message: safeMilvusMessage(error),
  }));
  process.exitCode = error instanceof RagConfigurationError ? 2 : 1;
});

