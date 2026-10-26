import { Agent } from '@mastra/core/agent';
import { Memory } from '@mastra/memory';

import { mastraConfig } from '../config.ts';
import { chatgptOpenAIModel } from '../gateways/chatgpt-openai-gateway.ts';
import { weatherTool } from '../tools/weather-tool.ts';

export const weatherAgent = new Agent({
  id: 'weather-agent',
  name: 'Weather Agent',
  instructions:
    'You are a helpful weather assistant. Use the weather tool when a city is provided.',
  model: chatgptOpenAIModel,
  memory: new Memory({
    options: {
      lastMessages: mastraConfig.memoryLastMessages,
      generateTitle: mastraConfig.memoryGenerateTitle,
    },
  }),
  tools: {
    weatherTool,
  },
});
