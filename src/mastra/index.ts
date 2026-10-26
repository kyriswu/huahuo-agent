import { Mastra } from '@mastra/core';
import { PostgresStore } from '@mastra/pg';

import { weatherAgent } from './agents/weather-agent.ts';
import { mastraConfig } from './config.ts';
import { chatgptOpenAIGateway } from './gateways/chatgpt-openai-gateway.ts';
import { weatherWorkflow } from './workflows/weather-workflow.ts';

function createPostgresStorage() {
  const password = process.env.MASTRA_POSTGRES_PASSWORD?.trim();
  if (!password) return undefined;

  return new PostgresStore({
    id: 'huahuo-mastra-postgres',
    host: process.env.MASTRA_POSTGRES_HOST ?? 'pgm-2ze7o54d25m8kn53no.pg.rds.aliyuncs.com',
    port: Number(process.env.MASTRA_POSTGRES_PORT ?? '5432'),
    database: process.env.MASTRA_POSTGRES_DATABASE ?? 'huahuo_mastra_memory_20261025',
    user: process.env.MASTRA_POSTGRES_USER ?? 'huahuo_admin',
    password,
    ssl: mastraConfig.postgresSsl,
    max: mastraConfig.postgresPoolMax,
    idleTimeoutMillis: mastraConfig.postgresIdleTimeoutMillis,
  });
}

const storage = createPostgresStorage();

export const mastra = new Mastra({
  ...(storage ? { storage } : {}),
  agents: { weatherAgent },
  gateways: { chatgptOpenAI: chatgptOpenAIGateway },
  workflows: { weatherWorkflow },
});
