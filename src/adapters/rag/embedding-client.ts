import {
  EmbeddingConfigurationError,
  EmbeddingProviderError,
} from '../../extensions/huahuo/rag/errors.ts';
import type { RagEmbeddingConfig } from '../../extensions/huahuo/rag/config.ts';

export interface EmbeddingClient {
  embed(texts: string[]): Promise<number[][]>;
}

export interface EmbeddingClientOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  dimensions?: number;
  timeoutMs?: number;
  maxRetries?: number;
  fetchImpl?: typeof fetch;
}

interface EmbeddingResponse {
  data?: Array<{ embedding?: unknown; index?: unknown }>;
  error?: { message?: unknown };
}

function safeProviderMessage(value: unknown): string {
  const message = typeof value === 'string' ? value : 'Embedding provider request failed';
  return message
    .replace(/(api[-_ ]?key|authorization|token|password)\s*[:=]\s*\S+/gi, '$1=[redacted]')
    .slice(0, 300);
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function validateVectors(
  values: unknown,
  expectedCount: number,
  expectedDimensions?: number,
): number[][] {
  if (!Array.isArray(values) || values.length !== expectedCount) {
    throw new EmbeddingProviderError(
      'EMBEDDING_RESPONSE_INVALID',
      `Embedding response count ${Array.isArray(values) ? values.length : 'unknown'} does not match input count ${expectedCount}`,
    );
  }
  const vectors = values.map((item, index) => {
    const embedding = (item as { embedding?: unknown } | undefined)?.embedding;
    if (
      !Array.isArray(embedding) ||
      embedding.some((value) => typeof value !== 'number' || !Number.isFinite(value))
    ) {
      throw new EmbeddingProviderError(
        'EMBEDDING_RESPONSE_INVALID',
        `Embedding response item ${index} is not a finite numeric vector`,
      );
    }
    return embedding;
  });
  const dimensions = vectors[0]?.length ?? 0;
  if (dimensions <= 0 || vectors.some((vector) => vector.length !== dimensions)) {
    throw new EmbeddingProviderError(
      'EMBEDDING_RESPONSE_INVALID',
      'Embedding response vectors do not have a consistent positive dimension',
    );
  }
  if (expectedDimensions !== undefined && dimensions !== expectedDimensions) {
    throw new EmbeddingProviderError(
      'EMBEDDING_RESPONSE_INVALID',
      `Embedding response dimension ${dimensions} does not match configured dimension ${expectedDimensions}`,
    );
  }
  return vectors;
}

export class OpenAICompatibleEmbeddingClient implements EmbeddingClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;

  constructor(private readonly options: EmbeddingClientOptions) {
    if (!options.baseUrl.trim() || !options.apiKey.trim() || !options.model.trim()) {
      throw new EmbeddingConfigurationError(
        'Embedding base URL, API key, and model are required for a real provider',
      );
    }
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.maxRetries = options.maxRetries ?? 2;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    if (texts.some((text) => typeof text !== 'string' || text.trim().length === 0)) {
      throw new EmbeddingProviderError(
        'EMBEDDING_RESPONSE_INVALID',
        'Embedding input must contain non-empty text strings',
      );
    }

    const body: Record<string, unknown> = {
      model: this.options.model,
      input: texts,
    };
    if (this.options.dimensions !== undefined) body.dimensions = this.options.dimensions;

    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await this.fetchImpl(`${this.options.baseUrl.replace(/\/$/, '')}/embeddings`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${this.options.apiKey}`,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        let payload: EmbeddingResponse;
        try {
          payload = await response.json() as EmbeddingResponse;
        } catch (error) {
          throw new EmbeddingProviderError(
            'EMBEDDING_RESPONSE_INVALID',
            'Embedding provider returned invalid JSON',
            { cause: error },
          );
        }

        if (!response.ok) {
          const providerMessage = safeProviderMessage(payload.error?.message);
          if (isRetryableStatus(response.status) && attempt < this.maxRetries) {
            await sleep(100 * 2 ** attempt);
            continue;
          }
          throw new EmbeddingProviderError(
            'EMBEDDING_PROVIDER_UNAVAILABLE',
            `Embedding provider returned HTTP ${response.status}${providerMessage ? `: ${providerMessage}` : ''}`,
            { retryable: isRetryableStatus(response.status) },
          );
        }

        const data = payload.data;
        const ordered = [...(data ?? [])].sort((left, right) => {
          const leftIndex = typeof left.index === 'number' ? left.index : 0;
          const rightIndex = typeof right.index === 'number' ? right.index : 0;
          return leftIndex - rightIndex;
        });
        return validateVectors(ordered, texts.length, this.options.dimensions);
      } catch (error) {
        lastError = error;
        if (error instanceof EmbeddingProviderError && !error.retryable) throw error;
        const timedOut = error instanceof Error && error.name === 'AbortError';
        if (timedOut) {
          if (attempt >= this.maxRetries) {
            throw new EmbeddingProviderError(
              'EMBEDDING_PROVIDER_TIMEOUT',
              `Embedding provider timed out after ${this.timeoutMs} ms`,
              { retryable: true, cause: error },
            );
          }
        } else if (error instanceof EmbeddingProviderError) {
          if (attempt >= this.maxRetries) throw error;
        } else if (attempt >= this.maxRetries) {
          throw new EmbeddingProviderError(
            'EMBEDDING_PROVIDER_UNAVAILABLE',
            `Embedding provider request failed: ${safeProviderMessage(error instanceof Error ? error.message : undefined)}`,
            { retryable: true, cause: error },
          );
        }
        await sleep(100 * 2 ** attempt);
      } finally {
        clearTimeout(timeout);
      }
    }
    throw new EmbeddingProviderError(
      'EMBEDDING_PROVIDER_UNAVAILABLE',
      'Embedding provider request failed after retries',
      { retryable: true, cause: lastError },
    );
  }
}

export function createEmbeddingClient(config: RagEmbeddingConfig): OpenAICompatibleEmbeddingClient {
  if (!config.baseUrl || !config.apiKey || !config.model) {
    throw new EmbeddingConfigurationError(
      'Missing RAG_EMBEDDING_BASE_URL, RAG_EMBEDDING_API_KEY, or RAG_EMBEDDING_MODEL',
    );
  }
  return new OpenAICompatibleEmbeddingClient({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    model: config.model,
    dimensions: config.dimensions,
    timeoutMs: config.timeoutMs,
    maxRetries: config.maxRetries,
  });
}

