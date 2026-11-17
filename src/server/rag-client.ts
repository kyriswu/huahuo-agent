import type { RequestContext } from '@mastra/core/request-context';
import { z } from 'zod';
import { ServerHttpClient, type ServerHttpClientOptions } from './http-client.js';

const ragQueryModeSchema = z.enum(['keyword', 'dense', 'hybrid']);

export const ragQueryInputSchema = z.object({
  query: z.string().trim().min(1).max(2_000),
  mode: ragQueryModeSchema.default('hybrid'),
  topK: z.number().int().min(1).max(50).default(10),
}).strict();

// The Server owns result metadata; validate the retrieval contract without
// discarding new chunk, source, or ranking fields.
export const ragQueryOutputSchema = z.object({
  mode: ragQueryModeSchema,
  query: z.string(),
  results: z.array(z.record(z.string(), z.unknown())),
}).passthrough();

export type RagQueryInput = z.input<typeof ragQueryInputSchema>;
export type RagQueryResult = z.infer<typeof ragQueryOutputSchema>;

export interface RagClientOptions extends ServerHttpClientOptions {
  requestContext?: RequestContext;
}

export class RagClient {
  private readonly http: ServerHttpClient;
  private readonly requestContext?: RequestContext;

  constructor(options: RagClientOptions = {}) {
    this.http = new ServerHttpClient(options);
    this.requestContext = options.requestContext;
  }

  async query(input: RagQueryInput, signal?: AbortSignal): Promise<RagQueryResult> {
    return this.http.post('/internal/v1/rag/query', ragQueryInputSchema.parse(input), ragQueryOutputSchema, {
      requestContext: this.requestContext,
      signal,
      timeoutMs: 60_000,
    });
  }
}
