import type { RequestContext } from '@mastra/core/request-context';
import { z } from 'zod';
import { getTrustedIdentity, trustedIdentityHeaders } from '../auth/trusted-identity.js';
import { traceHeaders, validTraceId } from '../trace.js';
import { resolveHuahuoServerBaseUrl } from './base-url.js';

export interface ServerHttpClientOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export interface ServerRequestOptions {
  requestContext?: RequestContext;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Only unauthenticated login/SMS endpoints opt out of trusted identity. */
  authentication?: 'trusted-context' | 'none';
  idempotencyKey?: string;
}

type ServerErrorKind = 'http' | 'business' | 'network' | 'timeout' | 'cancelled' | 'response';

export class ServerRequestError extends Error {
  constructor(
    readonly code: string,
    readonly kind: ServerErrorKind,
    readonly traceId: string,
    readonly status?: number,
    readonly retryable?: boolean,
  ) {
    // Upstream messages/bodies can contain private details. Keep diagnostics to
    // the safe code, HTTP status and correlation ID instead.
    super(`${code}${status === undefined ? '' : ` (HTTP ${status})`} [traceId=${traceId}]`);
    this.name = 'ServerRequestError';
  }
}

const traceIdSchema = z.string().refine(validTraceId);
const successSchema = z.object({ success: z.literal(true), data: z.unknown(), traceId: traceIdSchema });
const failureSchema = z.object({
  success: z.literal(false),
  error: z.object({ code: z.string().regex(/^[A-Z][A-Z0-9_]{0,79}$/u), retryable: z.boolean().optional() }),
  traceId: traceIdSchema,
});

/** Shared Server transport. Native fetch uses Node's shared connection pool;
 * clients never create a per-call dispatcher or replay failed requests.
 */
export class ServerHttpClient {
  private readonly baseUrl: string;

  constructor(private readonly options: ServerHttpClientOptions = {}) {
    this.baseUrl = resolveHuahuoServerBaseUrl(options.baseUrl);
  }

  async post<T>(path: string, input: unknown, schema: z.ZodType<T>, options: ServerRequestOptions = {}): Promise<T> {
    if (!/^\/(?!\/)[A-Za-z0-9/_-]+$/u.test(path)) throw new Error('SERVER_REQUEST_PATH_INVALID');
    const headers = traceHeaders({ 'content-type': 'application/json' });
    if (options.authentication !== 'none') {
      for (const [name, value] of Object.entries(trustedIdentityHeaders(getTrustedIdentity(options.requestContext)))) {
        headers.set(name, value);
      }
    }
    if (options.idempotencyKey) headers.set('x-idempotency-key', options.idempotencyKey);
    const requestTraceId = headers.get('x-trace-id')!;
    const timeoutMs = options.timeoutMs ?? 20_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error('SERVER_REQUEST_TIMEOUT_INVALID');
    const timeout = new AbortController();
    const timeoutReason = new DOMException('Server request timed out', 'TimeoutError');
    const timer = setTimeout(() => timeout.abort(timeoutReason), timeoutMs);
    timer.unref();
    const signal = options.signal ? AbortSignal.any([options.signal, timeout.signal]) : timeout.signal;
    let status: number | undefined;
    let responseTraceId = requestTraceId;
    try {
      signal.throwIfAborted();
      const response = await (this.options.fetchImpl ?? globalThis.fetch)(`${this.baseUrl}${path}`, {
        method: 'POST', headers, body: JSON.stringify(input), signal, redirect: 'error',
      });
      status = response.status;
      const headerTraceId = response.headers.get('x-trace-id');
      if (validTraceId(headerTraceId)) responseTraceId = headerTraceId;
      // Keep the timeout/cancellation active until the entire body is consumed.
      const rawBody = await response.text();
      signal.throwIfAborted();
      let body: unknown;
      try { body = JSON.parse(rawBody); } catch { body = undefined; }
      if (body && typeof body === 'object' && 'traceId' in body && validTraceId(body.traceId)) {
        responseTraceId = body.traceId;
      }
      const failure = failureSchema.safeParse(body);
      if (!response.ok || failure.success) {
        throw new ServerRequestError(
          failure.success ? failure.data.error.code : 'SERVER_REQUEST_FAILED',
          response.ok ? 'business' : 'http', responseTraceId, status,
          failure.success ? failure.data.error.retryable : undefined,
        );
      }
      const envelope = successSchema.safeParse(body);
      // z.unknown() also accepts undefined; require the data member explicitly.
      if (!envelope.success || !Object.hasOwn(envelope.data, 'data')) {
        throw new ServerRequestError('SERVER_RESPONSE_INVALID', 'response', responseTraceId, status);
      }
      const data = schema.safeParse(envelope.data.data);
      if (!data.success) throw new ServerRequestError('SERVER_RESPONSE_INVALID', 'response', responseTraceId, status);
      return data.data;
    } catch (error) {
      if (error instanceof ServerRequestError) throw error;
      if (signal.aborted) {
        const timedOut = signal.reason === timeoutReason;
        throw new ServerRequestError(timedOut ? 'SERVER_TIMEOUT' : 'SERVER_REQUEST_CANCELLED', timedOut ? 'timeout' : 'cancelled', responseTraceId, status);
      }
      throw new ServerRequestError('SERVER_UNAVAILABLE', 'network', responseTraceId, status);
    } finally {
      clearTimeout(timer);
    }
  }
}
