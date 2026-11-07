import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { HuahuoServerClient } from '../../server/huahuo-server-client.js';

const ragQueryInputSchema = z.object({
  query: z.string().trim().min(1).max(8_000),
  mode: z.enum(['keyword', 'dense', 'hybrid']).default('hybrid'),
  topK: z.number().int().min(1).max(100).default(10),
});

// Preserve server-added retrieval metadata as the RAG pipeline evolves.
const ragQueryOutputSchema = z.record(z.string(), z.unknown());
const RAG_QUERY_TIMEOUT_MS = 60_000;

export const huahuoRagQueryTool = createTool({
  id: 'huahuo-rag-query',
  description:
    'Query Huahuo knowledge through the hybrid RAG API. Only query, mode, and topK are accepted. The Server automatically selects the current active document versions and embedding index. Returns ranked Child evidence and Parent context. This tool only reads existing indexed data; it does not ingest or mutate documents.',
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
