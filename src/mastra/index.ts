import { Mastra } from '@mastra/core';

import { weatherAgent } from './agents/weather-agent.ts';
import { weatherWorkflow } from './workflows/weather-workflow.ts';

export const mastra = new Mastra({
  agents: { weatherAgent },
  workflows: { weatherWorkflow },
});
