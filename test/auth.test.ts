import { createRequire } from 'node:module';
import { Mastra } from '@mastra/core';
import { MASTRA_AUTH_TOKEN_KEY, MASTRA_RESOURCE_ID_KEY, RequestContext, withoutLiveRequestKeys } from '@mastra/core/request-context';
import type { Handler, MiddlewareHandler } from '@mastra/core/server';
import { coreAuthMiddleware } from '@mastra/server/auth';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { huahuoAuth, huahuoAuthMiddleware } from '../src/auth/mastra-auth.js';
import { applyTrustedIdentity, getTrustedIdentity, readTrustedIdentity, trustedIdentityHeaders } from '../src/auth/trusted-identity.js';
import { resolveHuahuoServerBaseUrl } from '../src/server/base-url.js';
import { HuahuoServerClient } from '../src/server/huahuo-server-client.js';

const alice = 'a0000000-0000-4000-8000-000000000001';
const bob = 'b0000000-0000-4000-8000-000000000002';
const sessionId = 'c0000000-0000-4000-8000-000000000003';
const identity = (userId = alice) => readTrustedIdentity({
  'x-huahuo-user-id': userId, 'x-huahuo-session-id': sessionId,
  'x-huahuo-auth-method': 'bearer', 'x-trace-id': 'fixture-trace',
});
const requestContext = (userId = alice) => {
  const context = new RequestContext();
  applyTrustedIdentity(context, identity(userId));
  return context;
};

const cliRequire = createRequire(createRequire(import.meta.url).resolve('mastra'));
interface TestApp {
  use(path: string, handler: MiddlewareHandler): void;
  on(method: string, path: string, handler: Handler): void;
  request(path: string, init?: RequestInit): Promise<Response>;
}
const Hono = cliRequire('hono').Hono as new () => TestApp;

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('trusted Agent identity', () => {
  it('accepts a complete identity and supplies a missing trace ID', () => {
    expect(identity()).toMatchObject({ id: alice, userId: alice, sessionId, authMethod: 'bearer' });
    const headers = trustedIdentityHeaders(identity());
    delete headers['x-trace-id'];
    expect(readTrustedIdentity(new Headers(headers)).traceId).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it.each(['x-huahuo-user-id', 'x-huahuo-session-id', 'x-huahuo-auth-method'])('rejects missing or malformed %s without JWT fallback', name => {
    const headers: Record<string, string | string[] | undefined> = { ...trustedIdentityHeaders(identity()), authorization: 'Bearer old.jwt.value' };
    delete headers[name];
    expect(() => readTrustedIdentity(headers)).toThrow('TRUSTED_IDENTITY_INVALID');
    headers[name] = 'invalid';
    expect(() => readTrustedIdentity(headers)).toThrow('TRUSTED_IDENTITY_INVALID');
    headers[name] = [trustedIdentityHeaders(identity())[name]];
    expect(() => readTrustedIdentity(headers)).toThrow('TRUSTED_IDENTITY_INVALID');
  });

  it('rejects duplicate identities and replaces invalid trace metadata', () => {
    expect(() => readTrustedIdentity({ ...trustedIdentityHeaders(identity()), 'X-Huahuo-User-Id': bob })).toThrow('TRUSTED_IDENTITY_INVALID');
    const headers = new Headers(trustedIdentityHeaders(identity()));
    headers.append('x-huahuo-user-id', bob);
    expect(() => readTrustedIdentity(headers)).toThrow('TRUSTED_IDENTITY_INVALID');
    expect(readTrustedIdentity({ ...trustedIdentityHeaders(identity()), 'x-trace-id': 'bad,trace' }).traceId).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it.each(['production', 'test', 'development'])('requires trusted identity on business APIs in %s', async appEnv => {
    vi.stubEnv('APP_ENV', appEnv);
    const app = new Hono();
    app.use('*', async (c, next) => { c.set('requestContext', new RequestContext()); await next(); });
    app.use('*', huahuoAuthMiddleware as MiddlewareHandler);
    app.on('GET', '/api/agents', c => c.json(getTrustedIdentity(c.get('requestContext'))));
    app.on('GET', '/api/health', c => c.json({ healthy: true }));
    expect((await app.request('/api/agents')).status).toBe(401);
    expect((await app.request('/api/agents', { headers: { authorization: 'Bearer old.jwt.value' } })).status).toBe(401);
    expect((await app.request('/api/health')).status).toBe(200);
    const response = await app.request('/api/agents', { headers: trustedIdentityHeaders(identity()) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ userId: alice, sessionId });
  });

  it('uses native Mastra authentication without a Bearer and enforces its resource mapping', async () => {
    const mastra = new Mastra({ server: { auth: huahuoAuth }, logger: false });
    const context = new RequestContext();
    context.set(MASTRA_RESOURCE_ID_KEY, bob);
    const request = new Request('http://agent.test/api/agents', { headers: trustedIdentityHeaders(identity()) });
    const result = await coreAuthMiddleware({
      path: '/api/agents', method: 'GET', getHeader: name => request.headers.get(name) ?? undefined,
      mastra, authConfig: huahuoAuth, requestContext: context, rawRequest: request, token: null,
      buildAuthorizeContext: () => ({}),
    });
    expect(result.action).toBe('next');
    expect(context.get(MASTRA_RESOURCE_ID_KEY)).toBe(alice);
    expect(getTrustedIdentity(context).userId).toBe(alice);
    expect(context.get(MASTRA_AUTH_TOKEN_KEY)).toBeUndefined();
    const rejected = await coreAuthMiddleware({
      path: '/api/agents', method: 'GET', getHeader: () => undefined,
      mastra, authConfig: huahuoAuth, requestContext: new RequestContext(),
      rawRequest: new Request('http://agent.test/api/agents'), token: 'old.jwt.value', buildAuthorizeContext: () => ({}),
    });
    expect(rejected).toMatchObject({ action: 'error', status: 401 });
  });

  it('ignores ordinary context identity fields and drops identity on durable restore', () => {
    const context = new RequestContext();
    context.set('user', identity(bob));
    context.set('huahuoUserId', bob);
    context.set('huahuoUserJwt', 'old.jwt.value');
    expect(() => getTrustedIdentity(context)).toThrow('TRUSTED_IDENTITY_REQUIRED');
    applyTrustedIdentity(context, identity());
    context.set('user', identity(bob));
    expect(getTrustedIdentity(context).userId).toBe(alice);
    const restored = new RequestContext<unknown>(Object.entries(withoutLiveRequestKeys(context.toJSON())));
    expect(() => getTrustedIdentity(restored)).toThrow('TRUSTED_IDENTITY_REQUIRED');
  });
});

describe('direct Server client', () => {
  it('sends trusted user context without JWT or ServiceKey', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ data: [] }));
    vi.stubGlobal('fetch', fetchMock);
    const context = requestContext();
    context.set('user', identity(bob));
    context.set('huahuoUserJwt', 'forged.jwt.value');
    await new HuahuoServerClient({ baseUrl: 'http://api-server:3000', requestContext: context }).ragQuery({ query: 'hello', userId: bob });
    expect(fetchMock.mock.calls[0][0]).toBe('http://api-server:3000/internal/v1/rag/query');
    const headers = new Headers(fetchMock.mock.calls[0][1]?.headers);
    expect(headers.get('x-huahuo-user-id')).toBe(alice);
    expect(headers.get('x-huahuo-session-id')).toBe(sessionId);
    expect(headers.get('x-huahuo-auth-method')).toBe('bearer');
    expect(headers.get('x-trace-id')).toBe('fixture-trace');
    expect(headers.get('authorization')).toBeNull();
    expect(headers.get('x-huahuo-service-key')).toBeNull();
  });

  it('fails before requesting a user API without trusted context', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
    await expect(new HuahuoServerClient({ baseUrl: 'http://api-server:3000' }).ragQuery({ query: 'test' })).rejects.toThrow('TRUSTED_IDENTITY_REQUIRED');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps concurrent callers isolated', async () => {
    const received: Array<string | null> = [];
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (_input, init) => {
      received.push(new Headers(init?.headers).get('x-huahuo-user-id'));
      return Response.json({ data: [] });
    }));
    await Promise.all([alice, bob].map(userId => new HuahuoServerClient({ baseUrl: 'http://api-server:3000', requestContext: requestContext(userId) }).ragQuery({ query: userId })));
    expect(received.sort()).toEqual([alice, bob]);
  });

  it('allows background calls only on internal paths and does not invent a user', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ success: true }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new HuahuoServerClient({ baseUrl: 'http://api-server:3000' });
    await client.serviceRequest('/internal/v1/system', { task: 'ping' });
    const headers = new Headers(fetchMock.mock.calls[0][1]?.headers);
    expect(headers.get('authorization')).toBeNull();
    expect(headers.get('x-huahuo-service-key')).toBeNull();
    expect(headers.get('x-huahuo-user-id')).toBeNull();
    await expect(client.serviceRequest('/api/v1/me/status')).rejects.toThrow('INTERNAL_SERVICE_PATH_REQUIRED');
    await expect(client.serviceRequest('/internal/v1/../api')).rejects.toThrow('INTERNAL_SERVICE_PATH_REQUIRED');
  });

  it('retains explicit Server base URL validation', () => {
    expect(resolveHuahuoServerBaseUrl('http://api-server:3000///', { APP_ENV: 'production' })).toBe('http://api-server:3000');
    expect(resolveHuahuoServerBaseUrl('http://10.0.0.8:13001', { APP_ENV: 'test' })).toBe('http://10.0.0.8:13001');
    for (const value of ['https://server.test/agent', 'https://server.test/api/v1', 'https://server.test?token=fixture', 'https://server.test#fragment']) {
      expect(() => resolveHuahuoServerBaseUrl(value)).toThrow('HUAHUO_SERVER_BASE_URL_INVALID');
    }
    expect(() => resolveHuahuoServerBaseUrl('http://[::1]:13001', { APP_ENV: 'production' })).toThrow('HUAHUO_SERVER_BASE_URL_PRODUCTION_INVALID');
    expect(() => resolveHuahuoServerBaseUrl(undefined, { APP_ENV: 'production' })).toThrow('HUAHUO_SERVER_BASE_URL_REQUIRED');
    expect(() => resolveHuahuoServerBaseUrl('http://localhost:3000', { APP_ENV: 'production' })).toThrow('HUAHUO_SERVER_BASE_URL_PRODUCTION_INVALID');
  });
});
