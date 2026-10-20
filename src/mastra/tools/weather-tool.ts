import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

export const weatherTool = createTool({
  id: 'get-weather',
  description: 'Return a deterministic example weather report for a city.',
  inputSchema: z.object({
    city: z.string().min(1),
  }),
  outputSchema: z.object({
    city: z.string(),
    forecast: z.string(),
  }),
  execute: async ({ city }) => ({
    city,
    forecast: 'Sunny and 21°C',
  }),
});
