import { describe, expect, it } from 'vitest';
import {
  loadRagConfig,
  requireRealEmbeddingConfig,
} from '../../src/extensions/huahuo/rag/config.ts';

describe('RAG configuration', () => {
  it('keeps real embedding settings optional for mock flows', () => {
    const config = loadRagConfig({});
    expect(config.embedding.baseUrl).toBeUndefined();
    expect(config.embedding.maxRetries).toBe(2);
    expect(config.embedding.sendDimensions).toBe(false);
    expect(config.embedding.maxInputTokens).toBe(8192);
    expect(() => requireRealEmbeddingConfig(config)).toThrow(
      'RAG_EMBEDDING_BASE_URL, RAG_EMBEDDING_API_KEY, RAG_EMBEDDING_MODEL, RAG_EMBEDDING_DIMENSIONS',
    );
  });

  it('validates dimensions, overlap, and retry limits', () => {
    expect(() => loadRagConfig({ RAG_EMBEDDING_DIMENSIONS: '0' }))
      .toThrow('RAG_EMBEDDING_DIMENSIONS must be a positive integer');
    expect(() => loadRagConfig({ RAG_CHUNK_SIZE: '8', RAG_CHUNK_OVERLAP: '8' }))
      .toThrow('RAG_CHUNK_OVERLAP must be an integer smaller than RAG_CHUNK_SIZE');
    expect(() => loadRagConfig({ RAG_EMBEDDING_MAX_RETRIES: '-1' }))
      .toThrow('RAG_EMBEDDING_MAX_RETRIES must be a non-negative integer');
    expect(loadRagConfig({ RAG_EMBEDDING_MAX_RETRIES: '  ' }).embedding.maxRetries).toBe(2);
    expect(loadRagConfig({ RAG_EMBEDDING_SEND_DIMENSIONS: 'false' }).embedding.sendDimensions).toBe(false);
    expect(() => loadRagConfig({ RAG_EMBEDDING_SEND_DIMENSIONS: 'yes' }))
      .toThrow('RAG_EMBEDDING_SEND_DIMENSIONS must be "true" or "false"');
  });
});
