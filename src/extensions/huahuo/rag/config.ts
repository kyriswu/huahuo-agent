import { RagConfigurationError } from './errors.ts';

export interface RagEmbeddingConfig {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  dimensions?: number;
  /** Some providers (including SiliconFlow BGE-M3) do not accept this request field. */
  sendDimensions: boolean;
  /** Model input limit used for safety checks; it is not a tokenizer. */
  maxInputTokens: number;
  timeoutMs: number;
  maxRetries: number;
}

export interface RagChunkingConfig {
  maxTokens: number;
  overlapTokens: number;
  tokenCountStrategy: 'heuristic-v1';
}

export interface RagIngestConfig {
  batchSize: number;
  pipelineVersion: string;
}

export interface RagRuntimeConfig {
  embedding: RagEmbeddingConfig;
  chunking: RagChunkingConfig;
  ingest: RagIngestConfig;
  stateDatabaseUrl?: string;
}

function positiveInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new RagConfigurationError(`${name} must be a positive integer`);
  }
  return value;
}

function nonNegativeInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new RagConfigurationError(`${name} must be a non-negative integer`);
  }
  return value;
}

function booleanValue(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: boolean,
): boolean {
  const raw = env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new RagConfigurationError(`${name} must be "true" or "false"`);
}

function optionalDimensions(env: NodeJS.ProcessEnv): number | undefined {
  const raw = env.RAG_EMBEDDING_DIMENSIONS?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new RagConfigurationError('RAG_EMBEDDING_DIMENSIONS must be a positive integer');
  }
  return value;
}

/** Read RAG settings without logging or exposing credential values. */
export function loadRagConfig(env: NodeJS.ProcessEnv = process.env): RagRuntimeConfig {
  const maxTokens = positiveInteger(env, 'RAG_CHUNK_SIZE', 800);
  const overlapTokens = nonNegativeInteger(env, 'RAG_CHUNK_OVERLAP', 120);
  if (overlapTokens >= maxTokens) {
    throw new RagConfigurationError('RAG_CHUNK_OVERLAP must be an integer smaller than RAG_CHUNK_SIZE');
  }
  const tokenCountStrategy = env.RAG_TOKEN_COUNT_STRATEGY?.trim() || 'heuristic-v1';
  if (tokenCountStrategy !== 'heuristic-v1') {
    throw new RagConfigurationError('RAG_TOKEN_COUNT_STRATEGY must be "heuristic-v1"');
  }

  return {
    embedding: {
      ...(env.RAG_EMBEDDING_BASE_URL ? { baseUrl: env.RAG_EMBEDDING_BASE_URL.trim() } : {}),
      ...(env.RAG_EMBEDDING_API_KEY ? { apiKey: env.RAG_EMBEDDING_API_KEY } : {}),
      ...(env.RAG_EMBEDDING_MODEL ? { model: env.RAG_EMBEDDING_MODEL.trim() } : {}),
      ...(optionalDimensions(env) !== undefined ? { dimensions: optionalDimensions(env) } : {}),
      sendDimensions: booleanValue(env, 'RAG_EMBEDDING_SEND_DIMENSIONS', false),
      maxInputTokens: positiveInteger(env, 'RAG_EMBEDDING_MAX_INPUT_TOKENS', 8_192),
      timeoutMs: positiveInteger(env, 'RAG_EMBEDDING_TIMEOUT_MS', 30_000),
      maxRetries: nonNegativeInteger(env, 'RAG_EMBEDDING_MAX_RETRIES', 2),
    },
    chunking: { maxTokens, overlapTokens, tokenCountStrategy },
    ingest: {
      batchSize: positiveInteger(env, 'RAG_INGEST_BATCH_SIZE', 32),
      pipelineVersion: env.RAG_INDEX_PIPELINE_VERSION?.trim() || 'v1',
    },
    ...(env.RAG_STATE_DATABASE_URL ? { stateDatabaseUrl: env.RAG_STATE_DATABASE_URL.trim() } : {}),
  };
}

export function requireRealEmbeddingConfig(
  config: Pick<RagRuntimeConfig, 'embedding'>,
): Required<Pick<RagEmbeddingConfig, 'baseUrl' | 'apiKey' | 'model' | 'dimensions'>> {
  const missing: string[] = [];
  if (!config.embedding.baseUrl) missing.push('RAG_EMBEDDING_BASE_URL');
  if (!config.embedding.apiKey) missing.push('RAG_EMBEDDING_API_KEY');
  if (!config.embedding.model) missing.push('RAG_EMBEDDING_MODEL');
  if (!config.embedding.dimensions) missing.push('RAG_EMBEDDING_DIMENSIONS');
  if (missing.length > 0) {
    throw new RagConfigurationError(`Missing real embedding configuration: ${missing.join(', ')}`);
  }
  const baseUrl = config.embedding.baseUrl;
  const apiKey = config.embedding.apiKey;
  const model = config.embedding.model;
  const dimensions = config.embedding.dimensions;
  if (!baseUrl || !apiKey || !model || dimensions === undefined) {
    throw new RagConfigurationError('Embedding configuration is incomplete');
  }
  return {
    baseUrl,
    apiKey,
    model,
    dimensions,
  };
}
