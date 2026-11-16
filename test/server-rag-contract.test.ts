import { describe, expect, it } from 'vitest';
import { ragQueryInputSchema } from '../src/mastra/tools/huahuo-rag-query-tool.js';

describe('Server RAG request limits', () => {
  it('accepts the Server maximum and default search mode', () => {
    expect(ragQueryInputSchema.parse({ query: 'x'.repeat(2000), topK: 50 })).toMatchObject({ mode: 'hybrid', topK: 50 });
  });
  it.each([{ query: 'x'.repeat(2001) }, { query: 'search', topK: 51 }])('rejects requests Server would reject before using a provider', input => {
    expect(ragQueryInputSchema.safeParse(input).success).toBe(false);
  });
});
