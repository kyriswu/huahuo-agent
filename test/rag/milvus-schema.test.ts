import { describe, expect, it } from 'vitest';
import { createRagChunkSchema } from '../../src/adapters/rag/milvus-rag-repository.ts';

describe('formal RAG Milvus schema', () => {
  it('uses a configured embedding dimension and keeps the PoC dimension out', () => {
    const schema = createRagChunkSchema(1536);
    const vector = schema.find((field) => field.name === 'embedding');
    expect(vector).toMatchObject({ dim: 1536 });
    expect(schema.find((field) => field.name === 'chunk_id')).toMatchObject({
      is_primary_key: true,
    });
    expect(schema.find((field) => field.name === 'document_version_state')).toBeTruthy();
    expect(schema.find((field) => field.name === 'text')).toBeTruthy();
  });

  it('rejects an absent or invalid dimension', () => {
    expect(() => createRagChunkSchema(0)).toThrow('positive embedding dimension');
    expect(() => createRagChunkSchema(4.5)).toThrow('positive embedding dimension');
  });
});

