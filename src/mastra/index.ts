import { Mastra } from '@mastra/core';
import { MastraEditor } from '@mastra/editor';
import { PostgresStore } from '@mastra/pg';

import { weatherAgent } from './agents/weather-agent.ts';
import { huoxAgent } from './agents/huox.ts';
import { mastraConfig } from './config.ts';
import { chatgptOpenAIGateway } from './gateways/chatgpt-openai-gateway.ts';
import { weatherWorkflow } from './workflows/weather-workflow.ts';
import { huahuoRagQueryTool } from './tools/huahuo-rag-query-tool.ts';
import { weatherTool } from './tools/weather-tool.ts';
import { huahuoApiAuthRequired, huahuoAuth, huahuoAuthMiddleware, huahuoServiceAuthMiddleware } from '../auth/mastra-auth.ts';
import { validateAgentServiceAuthConfig } from '../auth/service-key.ts';

validateAgentServiceAuthConfig();

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
  editor: new MastraEditor(),
  server: {
    ...(huahuoApiAuthRequired ? { auth: huahuoAuth } : {}),
    middleware: [huahuoServiceAuthMiddleware, huahuoAuthMiddleware],
  },
  agents: { huoxAgent, weatherAgent },
  tools: { huahuoRagQueryTool, weatherTool },
  gateways: { chatgptOpenAI: chatgptOpenAIGateway },
  workflows: { weatherWorkflow },
});
