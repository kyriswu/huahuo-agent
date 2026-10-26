import { describe, expect, it } from 'vitest';
import type { MilvusClient } from '@zilliz/milvus2-sdk-node';
import {
  createRagChunkSchema,
  MilvusRagRepository,
} from '../../src/adapters/rag/milvus-rag-repository.ts';

describe('formal RAG Milvus schema', () => {
  it('uses a configured embedding dimension and keeps the PoC dimension out', () => {
    const schema = createRagChunkSchema(1536);
    const vector = schema.find((field) => field.name === 'embedding');
    expect(vector).toMatchObject({ dim: 1536 });
    expect(schema.find((field) => field.name === 'chunk_id')).toMatchObject({
      is_primary_key: true,
    });
    expect(schema.find((field) => field.name === 'document_version_state')).toBeTruthy();
    expect(schema.find((field) => field.name === 'run_id')).toMatchObject({
      data_type: 21,
      max_length: 128,
    });
    expect(schema.find((field) => field.name === 'text')).toBeTruthy();
    expect(schema.filter((field) => field.data_type === 23)).toHaveLength(0);
    expect(schema.find((field) => field.name === 'heading_path')).toMatchObject({
      data_type: 21,
      max_length: 4096,
    });
  });

  it('rejects an absent or invalid dimension', () => {
    expect(() => createRagChunkSchema(0)).toThrow('positive embedding dimension');
    expect(() => createRagChunkSchema(4.5)).toThrow('positive embedding dimension');
  });

  it('serializes derived JSON values as VarChar payloads for SDK 2.6.17', async () => {
    let request: unknown;
    const client = {
      upsert: async (value: unknown) => {
        request = value;
        return { status: { error_code: 'Success' } };
      },
    } as unknown as MilvusClient;
    const repository = new MilvusRagRepository(client);
    await repository.upsertChunks([{
      chunkId: 'chunk-1',
      documentId: 'doc-1',
      documentVersion: 'v1',
      chunkIndex: 0,
      text: 'text',
      headingPath: ['A', 'B'],
      startOffset: 0,
      endOffset: 4,
      tokenCount: 1,
      contentHash: 'hash',
      chunkerVersion: 'v1',
      sourceId: 'source-1',
      sourceType: 'article',
      title: 'Title',
      tenantId: 'tenant-1',
      ownerId: 'owner-1',
      knowledgeBaseId: 'kb-1',
      pipelineVersion: 'v1',
      documentVersionState: 'building',
      embeddingModel: 'model',
      embeddingDimensions: 3,
      embedding: [1, 0, 0],
      metadata: { key: 'value' },
    }]);
    const row = (request as { data: Array<Record<string, unknown>> }).data[0];
    expect(row.heading_path).toBe('["A","B"]');
    expect(row.metadata).toBe('{"key":"value"}');
  });

  it('stops when describeIndex returns an unexpected error', async () => {
    const schema = createRagChunkSchema(3);
    const client = {
      hasCollection: async () => ({ status: { error_code: 'Success' }, value: true }),
      describeCollection: async () => ({
        status: { error_code: 'Success' },
        schema: { fields: schema, enable_dynamic_field: false },
      }),
      describeIndex: async () => ({
        status: { error_code: 'UnexpectedError', reason: 'backend unavailable' },
        index_descriptions: [],
      }),
      createIndex: async () => ({ status: { error_code: 'Success' } }),
    } as unknown as MilvusClient;
    await expect(new MilvusRagRepository(client).ensureReady(3))
      .rejects.toMatchObject({ code: 'MILVUS_UNAVAILABLE' });
  });

  it('does not implicitly create the formal collection during verification', async () => {
    const client = {
      hasCollection: async () => ({ status: { error_code: 'Success' }, value: false }),
      createCollection: async () => ({ status: { error_code: 'Success' } }),
    } as unknown as MilvusClient;
    await expect(new MilvusRagRepository(client).ensureReady(1024, { createIfMissing: false }))
      .rejects.toThrow('run the explicit initialization command first');
  });
});

