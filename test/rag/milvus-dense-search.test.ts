import { describe, expect, it } from 'vitest';
import { MilvusDenseSearchAdapter } from '../../src/adapters/rag/milvus-dense-search.ts';
import type { MilvusClient } from '@zilliz/milvus2-sdk-node';

class FakeMilvusClient {
  request: unknown;
  response: unknown = {
    status: { error_code: 'Success' },
    results: [
      { id: 'id-1', run_id: 'run-1', source_id: 'source-1', content: 'Apple fruit', score: 0.99 },
    ],
  };

  async search(request: unknown): Promise<unknown> {
    this.request = request;
    return this.response;
  }
}

function adapter(client: FakeMilvusClient): MilvusDenseSearchAdapter {
  return new MilvusDenseSearchAdapter(client as unknown as MilvusClient, {
    collection: 'huahuo_rag_poc_dense',
    vectorDim: 4,
  });
}

describe('MilvusDenseSearchAdapter', () => {
  it('validates query dimensions and finite values', async () => {
    const client = new FakeMilvusClient();
    await expect(adapter(client).search({ vector: [1, 0, 0] }))
      .rejects.toThrow('dimension 4');
    await expect(adapter(client).search({ vector: [1, 0, Number.NaN, 0] }))
      .rejects.toThrow('finite numeric array');
  });

  it('escapes run_id filters and maps dense results', async () => {
    const client = new FakeMilvusClient();
    const results = await adapter(client).search({
      vector: [1, 0, 0, 0],
      limit: 3,
      runId: 'run-"\\quoted',
    });
    expect(results).toEqual([
      {
        id: 'id-1',
        content: 'Apple fruit',
        sourceId: 'source-1',
        score: 0.99,
        runId: 'run-1',
      },
    ]);
    expect(client.request).toMatchObject({
      collection_name: 'huahuo_rag_poc_dense',
      limit: 3,
      metric_type: 'COSINE',
      filter: 'run_id == "run-\\"\\\\quoted"',
    });
  });

  it('rejects a non-success Milvus status', async () => {
    const client = new FakeMilvusClient();
    client.response = { error_code: 'UnexpectedError', reason: 'backend unavailable' };
    await expect(adapter(client).search({ vector: [1, 0, 0, 0] }))
      .rejects.toThrow('UnexpectedError');
  });
});
