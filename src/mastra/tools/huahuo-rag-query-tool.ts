import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { HuahuoServerClient } from '../../server/huahuo-server-client.js';

export const ragQueryInputSchema = z.object({
  query: z.string().trim().min(1).max(2_000),
  mode: z.enum(['keyword', 'dense', 'hybrid']).default('hybrid'),
  topK: z.number().int().min(1).max(50).default(10),
});

// Preserve server-added retrieval metadata as the RAG pipeline evolves.
const ragQueryOutputSchema = z.record(z.string(), z.unknown());
const RAG_QUERY_TIMEOUT_MS = 60_000;

export const huahuoRagQueryTool = createTool({
  id: 'huahuo-rag-query',
  description:
    'Query Huahuo knowledge through the Server RAG API. Only query (up to 2000 characters), mode, and topK (up to 50) are accepted. The Server selects authorized active sources and its current search index, returning ranked chunks, source context and retrieval metadata. This tool reads existing indexed data; it does not ingest or mutate documents.',
  inputSchema: ragQueryInputSchema,
  outputSchema: ragQueryOutputSchema,
  execute: async ({ query, mode, topK }, context) => {
    const client = new HuahuoServerClient({ requestContext: context.requestContext });
    return client.ragQuery({
        query,
        mode,
        topK,
      }, context.abortSignal
        ? AbortSignal.any([context.abortSignal, AbortSignal.timeout(RAG_QUERY_TIMEOUT_MS)])
        : AbortSignal.timeout(RAG_QUERY_TIMEOUT_MS));
  },
});
