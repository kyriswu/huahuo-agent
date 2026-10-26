import { describe, expect, it } from 'vitest';
import { ingestDocument } from '../../src/application/rag/ingest-document.ts';
import { InMemoryDocumentVersionStore } from '../../src/application/rag/document-version-service.ts';
import type { RagChunkRepository } from '../../src/adapters/rag/milvus-rag-repository.ts';
import type { IndexVersionKey, RAGChunkRow } from '../../src/extensions/huahuo/rag/types.ts';

class FakeEmbedding {
  calls = 0;

  async embed(texts: string[]): Promise<number[][]> {
    this.calls += 1;
    return texts.map((_text, index) => [index + 1, 0, 0]);
  }
}

class FakeRepository implements RagChunkRepository {
  rows = new Map<string, RAGChunkRow>();
  failNext = false;
  failOnCall?: number;
  upsertCalls = 0;

  async ensureReady(): Promise<void> {}

  async upsertChunks(rows: RAGChunkRow[]): Promise<void> {
    this.upsertCalls += 1;
    if (this.failNext || this.failOnCall === this.upsertCalls) {
      this.failNext = false;
      this.failOnCall = undefined;
      throw new Error('temporary write failure');
    }
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

const input = {
  sourceId: 'source-1',
  sourceType: 'article' as const,
  documentId: 'doc-1',
  documentVersion: 'v1',
  title: 'Title',
  content: '# Heading\n\nA stable document body.',
  tenantId: 'tenant-1',
  ownerId: 'owner-1',
  knowledgeBaseId: 'kb-1',
};

const options = {
  pipelineVersion: 'v1',
  embeddingModel: 'test-embedding',
  embeddingDimensions: 3,
  maxTokens: 800,
  overlapTokens: 120,
  batchSize: 2,
};

describe('ingestDocument', () => {
  it('writes a first version and returns visible state', async () => {
    const embedding = new FakeEmbedding();
    const repository = new FakeRepository();
    const result = await ingestDocument(input, options, {
      embedding,
      repository,
      versionStore: new InMemoryDocumentVersionStore(),
    });
    expect(result.status).toBe('visible');
    expect(result.chunkCount).toBe(1);
    expect(repository.rows.size).toBe(1);
    expect([...repository.rows.values()][0]?.documentVersionState).toBe('ready');
  });

  it('is idempotent for the same document, content, and pipeline', async () => {
    const embedding = new FakeEmbedding();
    const repository = new FakeRepository();
    const versionStore = new InMemoryDocumentVersionStore();
    const first = await ingestDocument(input, options, { embedding, repository, versionStore });
    const second = await ingestDocument(input, options, { embedding, repository, versionStore });
    expect(second.reused).toBe(true);
    expect(second.idempotencyKey).toBe(first.idempotencyKey);
    expect(embedding.calls).toBe(1);
  });

  it('makes a new version visible only after successful processing', async () => {
    const repository = new FakeRepository();
    const versionStore = new InMemoryDocumentVersionStore();
    const embedding = new FakeEmbedding();
    await ingestDocument(input, options, { embedding, repository, versionStore });
    const updated = await ingestDocument(
      { ...input, documentVersion: 'v2', content: `${input.content}\n\nUpdated.` },
      options,
      { embedding, repository, versionStore },
    );
    expect(updated.status).toBe('visible');
    expect((await versionStore.findByDocumentVersion('doc-1', 'v1'))[0]?.status).toBe('superseded');
  });

  it('keeps the old visible version when a new write fails and allows retry', async () => {
    const repository = new FakeRepository();
    const versionStore = new InMemoryDocumentVersionStore();
    const embedding = new FakeEmbedding();
    await ingestDocument(input, options, { embedding, repository, versionStore });
    repository.failNext = true;
    await expect(ingestDocument(
      { ...input, documentVersion: 'v2', content: `${input.content}\n\nFailure.` },
      options,
      { embedding, repository, versionStore },
    )).rejects.toThrow('temporary write failure');
    expect((await versionStore.findByDocumentVersion('doc-1', 'v1'))[0]?.status).toBe('visible');

    const retried = await ingestDocument(
      { ...input, documentVersion: 'v2', content: `${input.content}\n\nFailure.` },
      options,
      { embedding, repository, versionStore },
    );
    expect(retried.status).toBe('visible');
    expect((await versionStore.findByDocumentVersion('doc-1', 'v1'))[0]?.status).toBe('superseded');
  });

  it('rejects a changed content hash under the same document version', async () => {
    const versionStore = new InMemoryDocumentVersionStore();
    const dependencies = {
      embedding: new FakeEmbedding(),
      repository: new FakeRepository(),
      versionStore,
    };
    await ingestDocument(input, options, dependencies);
    await expect(ingestDocument({ ...input, content: 'different' }, options, dependencies))
      .rejects.toThrow('different content hash');
  });

  it('isolates a new pipeline version with a new idempotency key', async () => {
    const embedding = new FakeEmbedding();
    const repository = new FakeRepository();
    const versionStore = new InMemoryDocumentVersionStore();
    const first = await ingestDocument(input, options, { embedding, repository, versionStore });
    const next = await ingestDocument(input, { ...options, pipelineVersion: 'v2' }, {
      embedding,
      repository,
      versionStore,
    });
    expect(next.idempotencyKey).not.toBe(first.idempotencyKey);
    expect(embedding.calls).toBe(2);
    expect((await versionStore.findByDocumentVersion('doc-1', 'v1'))[0]?.status).toBe('superseded');
  });

  it('retries a partial batch without duplicating valid chunk IDs', async () => {
    const repository = new FakeRepository();
    const versionStore = new InMemoryDocumentVersionStore();
    const embedding = new FakeEmbedding();
    const longInput = {
      ...input,
      content: '# Heading\n\none two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen.',
    };
    repository.failOnCall = 2;
    await expect(ingestDocument(longInput, { ...options, maxTokens: 4, overlapTokens: 1, batchSize: 1 }, {
      embedding,
      repository,
      versionStore,
    })).rejects.toThrow('temporary write failure');
    const retried = await ingestDocument(longInput, { ...options, maxTokens: 4, overlapTokens: 1, batchSize: 1 }, {
      embedding,
      repository,
      versionStore,
    });
    expect(retried.status).toBe('visible');
    expect(repository.rows.size).toBe(retried.chunkCount);
    expect(new Set(repository.rows.keys()).size).toBe(repository.rows.size);
  });
});

