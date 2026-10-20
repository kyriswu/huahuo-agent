import { createHash } from 'node:crypto';
import { ingestDocument } from '../src/application/rag/ingest-document.ts';
import { InMemoryDocumentVersionStore } from '../src/application/rag/document-version-service.ts';
import type { RagChunkRepository } from '../src/adapters/rag/milvus-rag-repository.ts';
import type { IndexVersionKey, RAGChunkRow } from '../src/extensions/huahuo/rag/types.ts';

class MockEmbeddingClient {
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => {
      const digest = createHash('sha256').update(text).digest();
      return [digest[0] / 255, digest[1] / 255, digest[2] / 255, digest[3] / 255];
    });
  }
}

class InMemoryChunkRepository implements RagChunkRepository {
  private readonly rows = new Map<string, RAGChunkRow>();

  async ensureReady(): Promise<void> {}

  async upsertChunks(rows: RAGChunkRow[]): Promise<void> {
    for (const row of rows) this.rows.set(row.chunkId, { ...row });
  }

  async countVersionChunks(
    key: IndexVersionKey,
    state: RAGChunkRow['documentVersionState'],
  ): Promise<number> {
    return [...this.rows.values()].filter((row) =>
      row.documentId === key.documentId
      && row.documentVersion === key.documentVersion
      && row.contentHash === key.contentHash
      && row.pipelineVersion === key.pipelineVersion
      && row.embeddingModel === key.embeddingModel
      && row.embeddingDimensions === key.embeddingDimensions
      && row.documentVersionState === state,
    ).length;
  }
}

async function main(): Promise<void> {
  const result = await ingestDocument(
    {
      sourceId: 'mock-source-1',
      sourceType: 'article',
      documentId: 'mock-document-1',
      documentVersion: 'v1',
      title: 'Mock RAG document',
      content: '# Hello\n\nThis is a deterministic mock ingestion document.',
      tenantId: 'mock-tenant',
      ownerId: 'mock-owner',
      knowledgeBaseId: 'mock-kb',
    },
    {
      pipelineVersion: 'mock-v1',
      embeddingModel: 'mock-deterministic-v1',
      embeddingDimensions: 4,
      maxTokens: 800,
      overlapTokens: 120,
      batchSize: 32,
    },
    {
      embedding: new MockEmbeddingClient(),
      repository: new InMemoryChunkRepository(),
      versionStore: new InMemoryDocumentVersionStore(),
    },
  );
  console.log(JSON.stringify({
    ok: true,
    mode: 'mock',
    status: result.status,
    documentId: result.documentId,
    documentVersion: result.documentVersion,
    contentHash: result.contentHash,
    chunkCount: result.chunkCount,
    embeddingModel: result.embeddingModel,
    embeddingDimensions: result.embeddingDimensions,
  }));
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({
    ok: false,
    message: error instanceof Error ? error.message : 'Mock ingest failed',
  }));
  process.exitCode = 1;
});

