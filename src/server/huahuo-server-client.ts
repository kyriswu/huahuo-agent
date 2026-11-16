import { MASTRA_AUTH_TOKEN_KEY, type RequestContext } from '@mastra/core/request-context';
import { HUAHUO_USER_JWT_CONTEXT_KEY } from '../auth/mastra-auth.js';
import { resolveHuahuoServerBaseUrl } from './base-url.js';

export type ServerAuthStrategy = 'public' | 'user' | 'user+service' | 'service';

export interface HuahuoServerClientOptions {
  baseUrl?: string;
  serviceKey?: string;
  requestContext?: RequestContext;
}

export class HuahuoServerClient {
  private readonly baseUrl: string;
  private readonly serviceKey: string;
  private readonly requestContext?: RequestContext;

  constructor(options: HuahuoServerClientOptions = {}) {
    this.baseUrl = resolveHuahuoServerBaseUrl(options.baseUrl);
    this.serviceKey = (options.serviceKey ?? process.env.HUAHUO_AGENT_TO_SERVER_API_KEY ?? '').trim();
    this.requestContext = options.requestContext;
  }

  async ragQuery(input: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.requestJson('/internal/v1/rag/query', input, 'user+service', signal);
  }

  async serviceRequest(path: string, input: Record<string, unknown> = {}, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.requestJson(path, input, 'service', signal);
  }

  private currentUserJwt(): string {
    const value = this.requestContext?.get(MASTRA_AUTH_TOKEN_KEY)
      ?? this.requestContext?.get(HUAHUO_USER_JWT_CONTEXT_KEY);
    if (typeof value !== 'string' || value.trim().length === 0) throw new Error('USER_JWT_REQUIRED');
    return value.trim();
  }

  private async requestJson(path: string, input: Record<string, unknown>, strategy: ServerAuthStrategy, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (strategy === 'user' || strategy === 'user+service') headers.authorization = `Bearer ${this.currentUserJwt()}`;
    if (strategy === 'service' || strategy === 'user+service') {
      if (!this.serviceKey) throw new Error('HUAHUO_AGENT_TO_SERVER_API_KEY is required.');
      headers['x-huahuo-service-key'] = this.serviceKey;
    }
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(input),
      signal,
    });
    const rawBody = await response.text();
    let body: unknown;
    try { body = rawBody ? JSON.parse(rawBody) : {}; } catch { body = { message: rawBody.slice(0, 1_000) }; }
    if (!response.ok) {
      const detail = typeof body === 'object' && body !== null && 'error' in body
        ? String((body as { error?: { code?: unknown } }).error?.code ?? '')
        : `HTTP ${response.status}`;
      throw new Error(`Huahuo Server request failed (${response.status}): ${detail.slice(0, 200)}`);
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new Error('Huahuo Server returned invalid JSON.');
    return body as Record<string, unknown>;
  }
}
