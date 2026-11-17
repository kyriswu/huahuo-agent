import { Agent } from '@mastra/core/agent';
import { Memory } from '@mastra/memory';

import { mastraConfig } from '../config.ts';
import { agentModel } from '../model-config.ts';
import { weatherTool } from '../tools/weather-tool.ts';
import { firstTextProcessor } from '../../observability/first-text.js';
const telemetryProcessor = firstTextProcessor('weather-agent');

export const weatherAgent = new Agent({
  id: 'weather-agent',
  name: 'Weather Agent',
  instructions:
    'You are a helpful weather assistant. Use the weather tool when a city is provided.',
  model: agentModel,
  inputProcessors: [telemetryProcessor],
  outputProcessors: [telemetryProcessor],
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
