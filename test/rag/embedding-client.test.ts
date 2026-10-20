import { describe, expect, it } from 'vitest';
import {
  EmbeddingProviderError,
} from '../../src/extensions/huahuo/rag/errors.ts';
import { OpenAICompatibleEmbeddingClient } from '../../src/adapters/rag/embedding-client.ts';

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const options = {
  baseUrl: 'https://embedding.example.test/v1',
  apiKey: 'test-key',
  model: 'test-model',
  dimensions: 3,
  timeoutMs: 100,
  maxRetries: 0,
};

describe('OpenAICompatibleEmbeddingClient', () => {
  it('sends a batch request and validates the ordered response', async () => {
    let request: RequestInit | undefined;
    const client = new OpenAICompatibleEmbeddingClient({
      ...options,
      fetchImpl: async (_url, init) => {
        request = init;
        return response({
          data: [
            { index: 1, embedding: [0.4, 0.5, 0.6] },
            { index: 0, embedding: [0.1, 0.2, 0.3] },
          ],
        });
      },
    });
    await expect(client.embed(['one', 'two'])).resolves.toEqual([
      [0.1, 0.2, 0.3],
      [0.4, 0.5, 0.6],
    ]);
    expect(request?.headers).toMatchObject({
      authorization: 'Bearer test-key',
      'content-type': 'application/json',
    });
    expect(JSON.parse(String(request?.body))).toMatchObject({
      model: 'test-model',
      input: ['one', 'two'],
      dimensions: 3,
    });
  });

  it('rejects non-2xx responses without retrying non-retryable errors', async () => {
    let calls = 0;
    const client = new OpenAICompatibleEmbeddingClient({
      ...options,
      fetchImpl: async () => {
        calls += 1;
        return response({ error: { message: 'invalid request' } }, 400);
      },
    });
    await expect(client.embed(['one'])).rejects.toMatchObject({
      code: 'EMBEDDING_PROVIDER_UNAVAILABLE',
    });
    expect(calls).toBe(1);
  });

  it('retries a transient provider response a finite number of times', async () => {
    let calls = 0;
    const client = new OpenAICompatibleEmbeddingClient({
      ...options,
      maxRetries: 1,
      fetchImpl: async () => {
        calls += 1;
        return calls === 1
          ? response({ error: { message: 'busy' } }, 503)
          : response({ data: [{ embedding: [0.1, 0.2, 0.3] }] });
      },
    });
    await expect(client.embed(['one'])).resolves.toEqual([[0.1, 0.2, 0.3]]);
    expect(calls).toBe(2);
  });

  it('rejects invalid JSON, count mismatch, non-numeric vectors, and dimensions', async () => {
    const invalidJson = new OpenAICompatibleEmbeddingClient({
      ...options,
      fetchImpl: async () => new Response('{', { status: 200 }),
    });
    await expect(invalidJson.embed(['one'])).rejects.toMatchObject({
      code: 'EMBEDDING_RESPONSE_INVALID',
    });

    const countMismatch = new OpenAICompatibleEmbeddingClient({
      ...options,
      fetchImpl: async () => response({ data: [] }),
    });
    await expect(countMismatch.embed(['one'])).rejects.toMatchObject({
      code: 'EMBEDDING_RESPONSE_INVALID',
    });

    const badVector = new OpenAICompatibleEmbeddingClient({
      ...options,
      fetchImpl: async () => response({ data: [{ embedding: [0.1, Number.NaN, 0.3] }] }),
    });
    await expect(badVector.embed(['one'])).rejects.toBeInstanceOf(EmbeddingProviderError);

    const badDimension = new OpenAICompatibleEmbeddingClient({
      ...options,
      fetchImpl: async () => response({ data: [{ embedding: [0.1, 0.2] }] }),
    });
    await expect(badDimension.embed(['one'])).rejects.toThrow('configured dimension 3');
  });

  it('returns an explicit timeout error', async () => {
    const client = new OpenAICompatibleEmbeddingClient({
      ...options,
      timeoutMs: 5,
      fetchImpl: async (_url, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      }),
    });
    await expect(client.embed(['one'])).rejects.toMatchObject({
      code: 'EMBEDDING_PROVIDER_TIMEOUT',
    });
  });
});

