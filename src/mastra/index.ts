import { Mastra } from '@mastra/core';
import { MastraEditor } from '@mastra/editor';
import { PostgresStore } from '@mastra/pg';

import { weatherAgent } from './agents/weather-agent.ts';
import { huoxAgent } from './agents/huox.ts';
import { mastraConfig } from './config.ts';
import { chatgptOpenAIGateway } from './gateways/chatgpt-openai-gateway.ts';
import { weatherWorkflow } from './workflows/weather-workflow.ts';
import { createAiTemplateRoute } from './routes/ai-templates.ts';
import { huahuoRagQueryTool } from './tools/huahuo-rag-query-tool.ts';
import { weatherTool } from './tools/weather-tool.ts';
import { deepseekWebTools } from './tools/mcp/index.ts';
import { huahuoAuth, huahuoAuthMiddleware } from '../auth/mastra-auth.ts';
import { createStudioGateway } from '../studio/gateway.ts';
import { agentPublicPath } from '../studio/config.ts';
import { createStudioPrefixMiddleware } from '../studio/public-prefix.ts';
import {traceMiddleware} from '../request-trace.js';
import {logger} from '../logging.js';
import {createAgentObservability} from '../observability/mastra.js';

function createPostgresStorage() {
  const password = process.env.MASTRA_POSTGRES_PASSWORD?.trim();
  if (process.env.MASTRA_POSTGRES_REQUIRED === 'true') {
    if (!password) throw new Error('MASTRA_POSTGRES_PASSWORD_REQUIRED');
    if (process.env.MASTRA_DISABLE_STORAGE_INIT === 'true') throw new Error('MASTRA_STORAGE_INIT_REQUIRED');
  }
  if (!password) return undefined;
  const host = process.env.MASTRA_POSTGRES_HOST?.trim();
  const database = process.env.MASTRA_POSTGRES_DATABASE?.trim();
  const user = process.env.MASTRA_POSTGRES_USER?.trim();
  if (!host || !database || !user) throw new Error('MASTRA_POSTGRES_COORDINATES_REQUIRED');

  return new PostgresStore({
    id: 'huahuo-mastra-postgres',
    host,
    port: Number(process.env.MASTRA_POSTGRES_PORT ?? '5432'),
    database,
    user,
    password,
    ssl: mastraConfig.postgresSsl,
    max: mastraConfig.postgresPoolMax,
    idleTimeoutMillis: mastraConfig.postgresIdleTimeoutMillis,
  });
}

const storage = createPostgresStorage();
const studioGateway = createStudioGateway();
const telemetry = createAgentObservability();
// Mastra catches exporter.init errors, so listener readiness must gate startup here.
await telemetry.start();

export const mastra = new Mastra({
  logger,
  observability: telemetry.observability,
  loggerOptions: { export: false },
  ...(storage ? { storage } : {}),
  editor: new MastraEditor(),
  server: {
    studioBase: agentPublicPath(),
    mcp: { enabled: false },
    auth: huahuoAuth,
    apiRoutes: [...studioGateway.routes, createAiTemplateRoute()],
    middleware: [createStudioPrefixMiddleware(agentPublicPath(), process.env.APP_ENV !== 'production'), traceMiddleware, studioGateway.middleware, huahuoAuthMiddleware],
  },
  agents: { huoxAgent, weatherAgent },
  tools: { huahuoRagQueryTool, weatherTool, ...deepseekWebTools },
  gateways: { chatgptOpenAI: chatgptOpenAIGateway },
  workflows: { weatherWorkflow },
});

// The deployer's HTTP server can start before its storage init. Complete
// Mastra's idempotent initialization before the server can report healthy.
try {
  await storage?.init();
} catch (error) {
  if (error instanceof Error) logger.trackException(error);
  throw new Error('MASTRA_STORAGE_INIT_FAILED');
}
