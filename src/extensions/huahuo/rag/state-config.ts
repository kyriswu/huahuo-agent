import { RagConfigurationError } from './errors.ts';

export const AUTHORIZED_STATE_DATABASE_TARGET = 'pgsql-huahuo-test';
export const AUTHORIZED_STATE_DATABASE_HOSTS = new Set([
  'pgm-2ze7o54d25m8kn53.pg.rds.aliyuncs.com',
  'pgm-2ze7o54d25m8kn53no.pg.rds.aliyuncs.com',
]);

export interface RagStateDatabaseConfig {
  url: string;
  target: string;
}

/** Validate target identity without logging or exposing the connection string. */
export function loadRagStateDatabaseConfig(
  env: NodeJS.ProcessEnv = process.env,
  options: { requireTarget?: boolean } = {},
): RagStateDatabaseConfig {
  const url = env.RAG_STATE_DATABASE_URL?.trim();
  if (!url) throw new RagConfigurationError('Missing required environment variable: RAG_STATE_DATABASE_URL');
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new RagConfigurationError('RAG_STATE_DATABASE_URL must be a valid PostgreSQL URL');
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new RagConfigurationError('RAG_STATE_DATABASE_URL must use postgres:// or postgresql://');
  }
  const target = env.RAG_STATE_DATABASE_TARGET?.trim() || '';
  if ((options.requireTarget ?? false) && target !== AUTHORIZED_STATE_DATABASE_TARGET) {
    throw new RagConfigurationError(`RAG_STATE_DATABASE_TARGET must be ${AUTHORIZED_STATE_DATABASE_TARGET}`);
  }
  if (!AUTHORIZED_STATE_DATABASE_HOSTS.has(parsed.hostname)) {
    throw new RagConfigurationError('RAG_STATE_DATABASE_URL is not an authorized test PostgreSQL host');
  }
  return { url, target: target || AUTHORIZED_STATE_DATABASE_TARGET };
}

