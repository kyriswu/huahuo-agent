export interface MilvusConnectionConfig {
  address: string;
  username: string;
  password: string;
  database: string;
  connectTimeoutMs: number;
  tls: boolean;
}

export interface MilvusPocConfig extends MilvusConnectionConfig {
  collection: string;
  vectorDim: number;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function positiveInteger(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function booleanValue(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new Error(`${name} must be "true" or "false"`);
}

/**
 * Loads only the PoC settings. The password is retained in memory for the
 * SDK constructor and is never included in this object’s string output.
 */
export function loadMilvusPocConfig(
  env: NodeJS.ProcessEnv = process.env,
): MilvusPocConfig {
  return {
    ...loadMilvusConnectionConfig(env),
    collection: env.MILVUS_POC_COLLECTION?.trim() || 'huahuo_rag_poc_dense',
    vectorDim: positiveInteger(env, 'MILVUS_POC_VECTOR_DIM', 4),
  };
}

export function loadMilvusConnectionConfig(
  env: NodeJS.ProcessEnv = process.env,
): MilvusConnectionConfig {
  return {
    address: required(env, 'MILVUS_ADDRESS'),
    username: required(env, 'MILVUS_USERNAME'),
    password: required(env, 'MILVUS_PASSWORD'),
    database: env.MILVUS_DATABASE?.trim() || 'default',
    connectTimeoutMs: positiveInteger(env, 'MILVUS_CONNECT_TIMEOUT_MS', 10_000),
    tls: booleanValue(env, 'MILVUS_TLS', false),
  };
}
