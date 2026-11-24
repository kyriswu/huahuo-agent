import { createTool } from '@mastra/core/tools';
import { getTrustedIdentity } from '../../auth/mastra-auth.js';
import { logger } from '../../logging.js';
import { RagClient, ragQueryInputSchema, ragQueryOutputSchema } from '../../server/rag-client.js';

export const huahuoRagQueryTool = createTool({
  id: 'huahuo-rag-query',
  description:
    'Query Huahuo knowledge through the Server RAG API. Only query (up to 2000 characters), mode, and topK (up to 50) are accepted. The Server selects authorized active sources and its current search index, returning ranked chunks, source context and retrieval metadata. This tool reads existing indexed data; it does not ingest or mutate documents.',
  inputSchema: ragQueryInputSchema,
  outputSchema: ragQueryOutputSchema,
  execute: async (input, context) => {
    const client = new RagClient({ identity: getTrustedIdentity(context.requestContext), logger });
    return client.query(input, context.abortSignal);
  },
});
