import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { readTrustedIdentity } from '../src/auth/trusted-identity.js';
import { ServerHttpClient, ServerRequestError } from '../src/server/http-client.js';
import { withTraceId } from '../src/trace.js';

const dataSchema = z.object({ value: z.string() });
const envelope = (data: unknown = { value: 'ok' }) => ({ success: true, data, traceId: 'server-trace' });
const anonymous = { authentication: 'none' as const };
const userId = 'a0000000-0000-4000-8000-000000000001';
const sessionId = 'c0000000-0000-4000-8000-000000000003';

function identity() {
  return readTrustedIdentity({
    'x-huahuo-user-id': userId,
    'x-huahuo-session-id': sessionId,
    'x-huahuo-auth-method': 'bearer',
    'x-trace-id': 'trusted-trace',
  });
}

function client(fetchImpl: typeof fetch) {
  return new ServerHttpClient({ baseUrl: 'http://server.test', fetchImpl });
}

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('shared Server HTTP transport', () => {
  it('unwraps validated data and sends only trusted identity headers', async () => {
    const request = vi.fn<typeof fetch>(async () => Response.json(envelope()));
    await expect(client(request).post('/internal/v1/rag/query', { query: 'hello' }, dataSchema, { identity: identity() })).resolves.toEqual({ value: 'ok' });
    expect(request).toHaveBeenCalledOnce();
    const [url, init] = request.mock.calls[0];
    expect(url).toBe('http://server.test/internal/v1/rag/query');
    expect(init).toMatchObject({ method: 'POST', body: '{"query":"hello"}', redirect: 'error' });
    const headers = new Headers(init?.headers);
    expect(headers.get('x-huahuo-user-id')).toBe(userId);
    expect(headers.get('x-huahuo-session-id')).toBe(sessionId);
    expect(headers.get('x-huahuo-auth-method')).toBe('bearer');
    expect(headers.get('x-trace-id')).toBe('trusted-trace');
    expect(headers.has('authorization')).toBe(false);
    expect(headers.has('x-huahuo-service-key')).toBe(false);
  });

  it('requires verified identity before invoking the transport', async () => {
    const request = vi.fn<typeof fetch>();
    await expect(client(request).post('/internal/v1/rag/query', {}, dataSchema)).rejects.toThrow('TRUSTED_IDENTITY_REQUIRED');
    await expect(client(request).post('/internal/v1/rag/query', {}, dataSchema, {
      identity: { ...identity(), sessionId: 'invalid' },
    })).rejects.toThrow('TRUSTED_IDENTITY_INVALID');
    expect(request).not.toHaveBeenCalled();
  });

  it('shares trace handling with explicitly anonymous login calls and preserves idempotency', async () => {
    const request = vi.fn<typeof fetch>(async () => Response.json(envelope()));
    await withTraceId('login-trace', () => client(request).post('/api/v1/auth/sms-code', { phone: '13800000001' }, dataSchema, {
      ...anonymous, idempotencyKey: 'login-request-id',
    }));
    const headers = new Headers(request.mock.calls[0][1]?.headers);
    expect(headers.get('x-trace-id')).toBe('login-trace');
    expect(headers.get('x-idempotency-key')).toBe('login-request-id');
    expect(headers.has('x-huahuo-user-id')).toBe(false);
  });

  it.each([
    ['invalid JSON', '<html>private upstream failure</html>'],
    ['missing success flag', { data: { value: 'ok' }, traceId: 'server-trace' }],
    ['missing trace', { success: true, data: { value: 'ok' } }],
    ['missing data', { success: true, traceId: 'server-trace' }],
    ['invalid data shape', envelope({ value: 42 })],
  ])('rejects a successful HTTP response with %s', async (_name, body) => {
    const request = vi.fn<typeof fetch>(async () => typeof body === 'string' ? new Response(body) : Response.json(body));
    await expect(client(request).post('/internal/v1/rag/query', {}, dataSchema, anonymous)).rejects.toMatchObject({
      kind: 'response', code: 'SERVER_RESPONSE_INVALID', status: 200,
    });
    expect(request).toHaveBeenCalledOnce();
  });

  it('preserves HTTP status, business code, trace and retry metadata without exposing Server details', async () => {
    const request = vi.fn<typeof fetch>(async () => Response.json({
      success: false, traceId: 'server-trace',
      error: { code: 'RAG_SEARCH_UNAVAILABLE', retryable: true, message: 'private database connection', userMessageKey: 'error.rag' },
    }, { status: 503 }));
    const error = await client(request).post('/internal/v1/rag/query', {}, dataSchema, anonymous).catch(error => error);
    expect(error).toBeInstanceOf(ServerRequestError);
    expect(error).toMatchObject({ kind: 'http', status: 503, code: 'RAG_SEARCH_UNAVAILABLE', traceId: 'server-trace', retryable: true });
    expect(error.message).not.toContain('private database connection');
    expect(request).toHaveBeenCalledOnce();
  });

  it('rejects success:false even when Server returns HTTP 200', async () => {
    const request = vi.fn<typeof fetch>(async () => Response.json({ success: false, error: { code: 'RAG_QUERY_INVALID' }, traceId: 'server-trace' }));
    await expect(client(request).post('/internal/v1/rag/query', {}, dataSchema, anonymous)).rejects.toMatchObject({
      kind: 'business', status: 200, code: 'RAG_QUERY_INVALID', traceId: 'server-trace',
    });
    expect(request).toHaveBeenCalledOnce();
  });

  it.each([
    ['a non-JSON gateway response', '<html>private gateway detail</html>'],
    ['an unsafe error code', { success: false, error: { code: 'private\nvalue' }, traceId: 'server-trace' }],
  ])('keeps the HTTP status for %s', async (_name, body) => {
    const request = vi.fn<typeof fetch>(async () => typeof body === 'string'
      ? new Response(body, { status: 502 }) : Response.json(body, { status: 502 }));
    await expect(client(request).post('/api/v1/auth/login', {}, dataSchema, anonymous)).rejects.toMatchObject({
      kind: 'http', status: 502, code: 'SERVER_REQUEST_FAILED',
    });
    expect(request).toHaveBeenCalledOnce();
  });

  it('converts network failures once without leaking transport details or replaying mutations', async () => {
    const request = vi.fn<typeof fetch>(async () => { throw new Error('private host or credentials'); });
    const error = await client(request).post('/api/v1/auth/sms-code', {}, dataSchema, anonymous).catch(error => error);
    expect(error).toMatchObject({ kind: 'network', code: 'SERVER_UNAVAILABLE' });
    expect(error.message).not.toContain('private host or credentials');
    expect(request).toHaveBeenCalledOnce();
  });

  it('does not start a request whose caller is already cancelled', async () => {
    const request = vi.fn<typeof fetch>();
    const controller = new AbortController();
    controller.abort();
    await expect(client(request).post('/internal/v1/rag/query', {}, dataSchema, { ...anonymous, signal: controller.signal })).rejects.toMatchObject({
      kind: 'cancelled', code: 'SERVER_REQUEST_CANCELLED',
    });
    expect(request).not.toHaveBeenCalled();
  });
});

async function slowBodyServer() {
  let started!: () => void;
  const bodyStarted = new Promise<void>(resolve => { started = resolve; });
  let requests = 0;
  const server = createServer((_request, response) => {
    requests++;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.write('{"success":true,"data":');
    started();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { server, baseUrl, bodyStarted, requests: () => requests };
}

async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

describe('Server HTTP response body lifetime', () => {
  it('applies its timeout while reading the response body', async () => {
    const fixture = await slowBodyServer();
    try {
      const pending = new ServerHttpClient({ baseUrl: fixture.baseUrl }).post('/api/v1/auth/login', {}, dataSchema, { ...anonymous, timeoutMs: 100 });
      await expect(pending).rejects.toMatchObject({ kind: 'timeout', code: 'SERVER_TIMEOUT' });
      expect(fixture.requests()).toBe(1);
    } finally { await close(fixture.server); }
  });

  it('cancels response reading when the caller aborts', async () => {
    const fixture = await slowBodyServer();
    const controller = new AbortController();
    try {
      const pending = new ServerHttpClient({ baseUrl: fixture.baseUrl }).post('/internal/v1/rag/query', {}, dataSchema, { ...anonymous, signal: controller.signal });
      const rejected = expect(pending).rejects.toMatchObject({ kind: 'cancelled', code: 'SERVER_REQUEST_CANCELLED' });
      await fixture.bodyStarted;
      controller.abort();
      await rejected;
      expect(fixture.requests()).toBe(1);
    } finally { await close(fixture.server); }
  });
});
