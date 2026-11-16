import type { RequestContext } from '@mastra/core/request-context';
import { getTrustedIdentity, trustedIdentityHeaders } from '../auth/trusted-identity.js';
import { resolveHuahuoServerBaseUrl } from './base-url.js';

export interface HuahuoServerClientOptions {
  baseUrl?: string;
  requestContext?: RequestContext;
}

export class HuahuoServerClient {
  private readonly baseUrl: string;
  private readonly requestContext?: RequestContext;

  constructor(options: HuahuoServerClientOptions = {}) {
    this.baseUrl = resolveHuahuoServerBaseUrl(options.baseUrl);
    this.requestContext = options.requestContext;
  }

  async ragQuery(input: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.requestJson('/internal/v1/rag/query', input, true, signal);
  }

  async serviceRequest(path: string, input: Record<string, unknown> = {}, signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (!/^\/internal\/v1\/[A-Za-z0-9/_-]+$/u.test(path)) throw new Error('INTERNAL_SERVICE_PATH_REQUIRED');
    return this.requestJson(path, input, false, signal);
  }

  private async requestJson(path: string, input: Record<string, unknown>, userRequired: boolean, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (userRequired) Object.assign(headers, trustedIdentityHeaders(getTrustedIdentity(this.requestContext)));
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(input),
      signal,
      redirect: 'error',
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
