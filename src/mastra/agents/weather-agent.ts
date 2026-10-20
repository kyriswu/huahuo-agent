import { Agent } from '@mastra/core/agent';

import { weatherTool } from '../tools/weather-tool.ts';

export const weatherAgent = new Agent({
  id: 'weather-agent',
  name: 'Weather Agent',
  instructions:
    'You are a helpful weather assistant. Use the weather tool when a city is provided.',
  model: 'deepseek/deepseek-flash',
  tools: {
    weatherTool,
  },
});
