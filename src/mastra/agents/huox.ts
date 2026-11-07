import { Agent } from '@mastra/core/agent';
import { Memory } from '@mastra/memory';

import { mastraConfig } from '../config.ts';
import { chatgptOpenAIModel } from '../gateways/chatgpt-openai-gateway.ts';
import { huahuoRagQueryTool } from '../tools/huahuo-rag-query-tool.ts';

/**
 * Primary Huahuo business agent.
 *
 * Business tools are added here as their application services become
 * available. Keeping the agent free of transport and database code lets those
 * integrations evolve behind the existing application/adapters boundaries.
 */
export const huoxAgent = new Agent({
  id: 'huox',
  name: 'HuoX',
  instructions: [
    "You are Huahuo's primary business assistant.",
    'Help users complete Huahuo tasks clearly and reliably.',
    "Answer in the user's language unless they ask for another language.",
    'Do not invent business data, permissions, task results, or external actions.',
    'Ask a focused clarification question when the request lacks required context.',
    'Respect tenant, ownership, and authorization boundaries supplied by the application.',
    'Use registered tools when they are available, and explain when a requested capability is not yet connected.',
    'For questions requiring Huahuo knowledge, call huahuoRagQueryTool before answering; base factual claims on its returned evidence and context, and say when no indexed evidence is returned.',
  ].join('\n'),
  model: chatgptOpenAIModel,
  memory: new Memory({
    options: {
      lastMessages: mastraConfig.memoryLastMessages,
      generateTitle: mastraConfig.memoryGenerateTitle,
    },
  }),
  tools: {
    huahuoRagQueryTool,
  },
});
