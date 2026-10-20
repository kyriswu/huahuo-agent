import type { SearchMode } from '../../../contracts/rag-search.ts';
import { RagConfigurationError } from './errors.ts';

export interface HuahuoRagConfig {
  milvus: {
    endpoint: string;
    token?: string;
    collection: string;
  };
  embedding: RagEmbeddingConfig;
  chunking: RagChunkingConfig;
  ingest: RagIngestConfig;
  ragCollection: string;
  searchMode: SearchMode;
  rerank: {
    enabled: boolean;
    baseUrl?: string;
    apiKey?: string;
    model?: string;
  };
}

export interface RagEmbeddingConfig {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  dimensions?: number;
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
  ragCollection: string;
  searchMode: SearchMode;
  rerank: HuahuoRagConfig['rerank'];
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
  const searchMode = env.RAG_SEARCH_MODE?.trim() || 'semantic';
  if (searchMode !== 'keyword' && searchMode !== 'semantic' && searchMode !== 'hybrid') {
    throw new RagConfigurationError('RAG_SEARCH_MODE must be one of "keyword", "semantic", or "hybrid"');
  }

  const maxTokens = positiveInteger(env, 'RAG_CHUNK_SIZE', 800);
  const overlapTokens = Number(env.RAG_CHUNK_OVERLAP?.trim() || 120);
  if (!Number.isInteger(overlapTokens) || overlapTokens < 0 || overlapTokens >= maxTokens) {
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
      timeoutMs: positiveInteger(env, 'RAG_EMBEDDING_TIMEOUT_MS', 10_000),
      maxRetries: Number.isInteger(Number(env.RAG_EMBEDDING_MAX_RETRIES ?? 2))
        && Number(env.RAG_EMBEDDING_MAX_RETRIES ?? 2) >= 0
        ? Number(env.RAG_EMBEDDING_MAX_RETRIES ?? 2)
        : (() => {
            throw new RagConfigurationError('RAG_EMBEDDING_MAX_RETRIES must be a non-negative integer');
          })(),
    },
    chunking: { maxTokens, overlapTokens, tokenCountStrategy },
    ingest: {
      batchSize: positiveInteger(env, 'RAG_INGEST_BATCH_SIZE', 32),
      pipelineVersion: env.RAG_INDEX_PIPELINE_VERSION?.trim() || 'v1',
    },
    ragCollection: env.RAG_MILVUS_COLLECTION?.trim() || 'huahuo_chunks',
    searchMode,
    rerank: {
      enabled: env.RAG_RERANK_ENABLED === 'true',
      ...(env.RAG_RERANK_BASE_URL ? { baseUrl: env.RAG_RERANK_BASE_URL } : {}),
      ...(env.RAG_RERANK_API_KEY ? { apiKey: env.RAG_RERANK_API_KEY } : {}),
      ...(env.RAG_RERANK_MODEL ? { model: env.RAG_RERANK_MODEL } : {}),
    },
  };
}

/** Legacy search configuration with the pre-existing MILVUS_ENDPOINT contract. */
export function loadHuahuoRagConfig(env: NodeJS.ProcessEnv = process.env): HuahuoRagConfig {
  const endpoint = env.MILVUS_ENDPOINT?.trim();
  if (!endpoint) {
    throw new RagConfigurationError('Missing required environment variable: MILVUS_ENDPOINT');
  }
  const runtime = loadRagConfig(env);
  return {
    milvus: {
      endpoint,
      collection: env.MILVUS_COLLECTION?.trim() || 'huahuo_documents',
      ...(env.MILVUS_TOKEN ? { token: env.MILVUS_TOKEN } : {}),
    },
    ...runtime,
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
