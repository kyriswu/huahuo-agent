import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';

const formatWeatherStep = createStep({
  id: 'format-weather',
  inputSchema: z.object({ city: z.string().min(1) }),
  outputSchema: z.object({ message: z.string() }),
  execute: async ({ inputData }) => ({
    message: `The example forecast for ${inputData.city} is sunny and 21°C.`,
  }),
});

export const weatherWorkflow = createWorkflow({
  id: 'weather-workflow',
  inputSchema: z.object({ city: z.string().min(1) }),
  outputSchema: z.object({ message: z.string() }),
})
  .then(formatWeatherStep)
  .commit();
