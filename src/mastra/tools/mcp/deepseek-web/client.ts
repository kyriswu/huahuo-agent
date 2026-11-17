import { setTimeout as delay } from 'node:timers/promises';
import {traceHeaders} from '../../../../trace.js';
import type { z } from 'zod';
import {
  deepseekFetchInputSchema,
  deepseekFetchOutputSchema,
  deepseekSearchInputSchema,
  deepseekSearchOutputSchema,
  type DeepSeekFetchInput,
  type DeepSeekFetchOutput,
  type DeepSeekSearchInput,
  type DeepSeekSearchOutput,
} from './schemas.js';

const DEEPSEEK_TOOLS_URL = 'https://api.deepseek.com/v1/tools';
const REQUEST_TIMEOUT_MS = 60_000;
const MAX_RETRY_DELAY_MS = 5_000;

const httpErrorMessages: Record<number, string> = {
  400: 'Invalid Search or Fetch request.',
  401: 'Check the server-side DEEPSEEK_API_KEY.',
  402: 'The DeepSeek account has insufficient balance.',
  403: 'DeepSeek rejected the page under its security policy.',
  404: 'No usable page content could be fetched.',
  408: 'The request timed out. Try again later.',
  429: 'The Search or Fetch rate limit was exceeded. Try again later.',
  500: 'DeepSeek is temporarily unavailable. Try again later.',
  502: 'DeepSeek is temporarily unavailable. Try again later.',
  503: 'DeepSeek is temporarily unavailable. Try again later.',
  504: 'DeepSeek timed out while retrieving content. Try again later.',
};

export class DeepSeekWebError extends Error {
  constructor(message: string, readonly code: string, readonly status?: number) {
    super(message);
    this.name = 'DeepSeekWebError';
  }
}

export interface DeepSeekWebClientOptions {
  apiKey?: string;
  fetchImpl?: typeof globalThis.fetch;
  timeoutMs?: number;
}

export class DeepSeekWebClient {
  constructor(private readonly options: DeepSeekWebClientOptions = {}) {}

  search(input: DeepSeekSearchInput, abortSignal?: AbortSignal): Promise<DeepSeekSearchOutput> {
    return this.request('search', deepseekSearchInputSchema.parse(input), deepseekSearchOutputSchema, abortSignal);
  }

  fetchPage(input: DeepSeekFetchInput, abortSignal?: AbortSignal): Promise<DeepSeekFetchOutput> {
    return this.request('fetch', deepseekFetchInputSchema.parse(input), deepseekFetchOutputSchema, abortSignal);
  }

  private async request<T>(operation: 'search' | 'fetch', input: unknown, schema: z.ZodType<T>, abortSignal?: AbortSignal): Promise<T> {
    // Read credentials at invocation time; importing tools does not require a key.
    const apiKey = (this.options.apiKey ?? process.env.DEEPSEEK_API_KEY ?? '').trim();
    if (!apiKey) throw new DeepSeekWebError('DEEPSEEK_API_KEY is required to use web search and fetch.', 'DEEPSEEK_API_KEY_REQUIRED');

    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? REQUEST_TIMEOUT_MS);
    const signal = abortSignal ? AbortSignal.any([abortSignal, timeout]) : timeout;
    const headers=traceHeaders({authorization:`Bearer ${apiKey}`,'content-type':'application/json'});
    const post = () => (this.options.fetchImpl ?? globalThis.fetch)(`${DEEPSEEK_TOOLS_URL}/${operation}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(input),
      redirect: 'error',
      signal,
    });

    try {
      signal.throwIfAborted();
      let response = await post();
      // Retry one explicit transient HTTP failure. Ambiguous network failures
      // and timeouts aren't replayed automatically because calls are billable.
      if (response.status === 408 || response.status === 429 || response.status >= 500) {
        const header = response.headers.get('retry-after');
        const retryDelay = header === null ? 250 : Math.max(250,
          /^\d+(?:\.\d+)?$/u.test(header) ? Number(header) * 1_000 : Date.parse(header) - Date.now());
        if (Number.isFinite(retryDelay) && retryDelay <= MAX_RETRY_DELAY_MS) {
          await response.body?.cancel();
          await delay(retryDelay, undefined, { signal });
          response = await post();
        }
      }
      if (!response.ok) {
        await response.body?.cancel();
        // Never echo upstream bodies, headers, or errors: they can contain keys
        // and other request data. Only safe status-specific guidance is exposed.
        throw new DeepSeekWebError(`DeepSeek ${operation} failed (HTTP ${response.status}). ${httpErrorMessages[response.status] ?? 'Please try again later.'}`,
          `DEEPSEEK_HTTP_${response.status}`, response.status);
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new DeepSeekWebError(`DeepSeek ${operation} returned invalid JSON.`, 'DEEPSEEK_INVALID_RESPONSE');
      }
      const result = schema.safeParse(body);
      if (!result.success) throw new DeepSeekWebError(`DeepSeek ${operation} returned an invalid response.`, 'DEEPSEEK_INVALID_RESPONSE');
      return result.data;
    } catch (error) {
      if (signal.aborted) {
        if (abortSignal?.aborted) throw new DeepSeekWebError(`DeepSeek ${operation} was cancelled.`, 'DEEPSEEK_ABORTED');
        throw new DeepSeekWebError(`DeepSeek ${operation} timed out.`, 'DEEPSEEK_TIMEOUT');
      }
      if (error instanceof DeepSeekWebError) throw error;
      throw new DeepSeekWebError(`DeepSeek ${operation} could not connect. Please try again later.`, 'DEEPSEEK_NETWORK_ERROR');
    }
  }
}
