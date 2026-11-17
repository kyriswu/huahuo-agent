import { RequestContext } from '@mastra/core/request-context';
import { describe, expect, it, vi } from 'vitest';
import { applyTrustedIdentity, readTrustedIdentity } from '../src/auth/trusted-identity.js';
import { RagClient, ragQueryInputSchema } from '../src/server/rag-client.js';

function trustedContext() {
  const context = new RequestContext();
  applyTrustedIdentity(context, readTrustedIdentity({
    'x-huahuo-user-id': 'a0000000-0000-4000-8000-000000000001',
    'x-huahuo-session-id': 'b0000000-0000-4000-8000-000000000002',
    'x-huahuo-auth-method': 'bearer',
    'x-trace-id': 'rag-contract',
  }));
  return context;
}

describe('Server RAG request limits', () => {
  it('accepts the Server maximum and default search mode', () => {
    expect(ragQueryInputSchema.parse({ query: 'x'.repeat(2000), topK: 50 })).toMatchObject({ mode: 'hybrid', topK: 50 });
  });
  it.each([{ query: 'x'.repeat(2001) }, { query: 'search', topK: 51 }])('rejects requests Server would reject before using a provider', input => {
    expect(ragQueryInputSchema.safeParse(input).success).toBe(false);
  });

  it.each(['userId', 'sessionId', 'authMethod', 'traceId'])('rejects model-supplied %s before contacting Server', async key => {
    const fetchImpl = vi.fn<typeof fetch>();
    const client = new RagClient({ baseUrl: 'http://server.test', requestContext: trustedContext(), fetchImpl });
    await expect(client.query({ query: 'hello', [key]: 'forged' })).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns validated retrieval data while preserving Server result metadata', async () => {
    const data = {
      mode: 'hybrid', query: 'hello',
      results: [{ chunkId: 'chunk', score: 0.9, source: { documentId: 'doc' }, futureMetadata: true }],
      retrievalMetadata: { index: 'active' },
    };
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ success: true, data, traceId: 'rag-contract' }));
    const client = new RagClient({ baseUrl: 'http://server.test', requestContext: trustedContext(), fetchImpl });
    expect(await client.query({ query: ' hello ' })).toEqual(data);
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))).toEqual({ query: 'hello', mode: 'hybrid', topK: 10 });
  });

  it.each([
    { query: 'hello', results: [] },
    { mode: 'semantic', query: 'hello', results: [] },
    { mode: 'hybrid', query: 'hello', results: ['not a result record'] },
  ])('rejects invalid successful RAG data', async data => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ success: true, data, traceId: 'rag-contract' }));
    const client = new RagClient({ baseUrl: 'http://server.test', requestContext: trustedContext(), fetchImpl });
    await expect(client.query({ query: 'hello' })).rejects.toMatchObject({ code: 'SERVER_RESPONSE_INVALID' });
  });
});
