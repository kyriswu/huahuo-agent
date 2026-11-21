import { createRequire } from 'node:module';
import { Script } from 'node:vm';
import { RequestContext, MASTRA_RESOURCE_ID_KEY } from '@mastra/core/request-context';
import type { ContextWithMastra, Handler, MiddlewareHandler } from '@mastra/core/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getTrustedIdentity } from '../src/auth/mastra-auth.js';
import { createStudioGateway } from '../src/studio/gateway.js';
import { StudioIdentityClient } from '../src/studio/identity-client.js';
import { tokenCookies } from '../src/studio/token-bridge.js';
import { loadStudioLoginConfig } from '../src/studio/config.js';
import { RagClient } from '../src/server/rag-client.js';

const cliRequire = createRequire(createRequire(import.meta.url).resolve('mastra'));
interface TestApp {
  use(path: string, handler: MiddlewareHandler): void;
  on(method: string, path: string, handler: Handler): void;
  request(path: string, init?: RequestInit): Promise<Response>;
}
const Hono = cliRequire('hono').Hono as new () => TestApp;
const origin = 'http://localhost';
const alice = 'a0000000-0000-4000-8000-000000000001';
const bob = 'b0000000-0000-4000-8000-000000000002';
const sessionId = 'c0000000-0000-4000-8000-000000000003';
const smsRequestId = 'd0000000-0000-4000-8000-000000000004';
const config = { enabled: true, publicPath: '/agent', agreementVersion: '2026-08-20', privacyVersion: '2026-08-20' };
const identityHeaders = (user = alice) => ({ 'x-huahuo-user-id': user, 'x-huahuo-session-id': sessionId, 'x-huahuo-auth-method': 'cookie', 'x-trace-id': 'studio-test' });
const json = (body: unknown, headers = {}) => ({ method: 'POST', headers: { 'content-type': 'application/json', origin, ...headers }, body: JSON.stringify(body) });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

async function fixture(enabled = true) {
  const requests: Array<{ path: string; body: Record<string, unknown>; headers: Headers }> = [];
  vi.stubEnv('HUAHUO_SERVER_BASE_URL', 'http://business.test');
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname, headers = new Headers(init.headers);
    const body = init.body ? JSON.parse(String(init.body)) : {};
    requests.push({ path, body, headers });
    if (path === '/api/v1/auth/sms-code') return Response.json({ success: true, data: { smsRequestId, cooldownSeconds: 60, testCode: '123456' }, traceId: 'studio-test' });
    if (path === '/api/v1/auth/login') return Response.json({ success: true, data: {
      accessToken: 'opaque-server-issued-access', refreshToken: 'opaque-server-issued-refresh',
      accessTokenExpiresAt: new Date(Date.now() + 900_000).toISOString(),
      user: { userId: alice, displayName: 'Alice', phoneMasked: '138****0001' },
    }, traceId: 'studio-test' });
    if (path === '/internal/v1/rag/query') return Response.json({ success: true, data: { mode: 'hybrid', query: 'test', results: [{ owner: headers.get('x-huahuo-user-id') }] }, traceId: 'studio-test' });
    throw new Error('Unexpected isolated destination');
  }));
  const gateway = createStudioGateway({ ...config, enabled }, new StudioIdentityClient({ baseUrl: 'http://business.test' }));
  const app = new Hono();
  app.use('*', async (c, next) => { c.set('requestContext', new RequestContext()); await next(); });
  app.use('*', gateway.middleware);
  for (const route of gateway.routes) if ('handler' in route && route.handler) app.on(route.method, route.path, route.handler as Handler);
  app.on('GET', '/agent/', c => c.html('<html><title>Studio fixture</title></html>'));
  app.on('GET', '/api/auth/capabilities', c => c.json({ enabled: true, login: null }));
  app.on('GET', '/api/context', c => {
    const context = (c as ContextWithMastra).get('requestContext');
    return c.json({ resourceId: context.get(MASTRA_RESOURCE_ID_KEY) });
  });
  app.on('POST', '/api/fixture/rag', async c => {
    const context = (c as ContextWithMastra).get('requestContext');
    context.set('huahuoUserId', bob);
    context.set('huahuoUserJwt', 'forged-client-value');
    return c.json(await new RagClient({ identity: getTrustedIdentity(context) }).query({ query: 'test' }));
  });
  return { app, requests };
}
const loginBody = () => ({ phone: '13800000001', smsRequestId, smsCode: '123456', clientId: sessionId, requestId: sessionId, agreementAccepted: true, timeZone: 'Asia/Shanghai' });

describe('Studio behind unified gateway authentication', () => {
  it('delegates the Studio login prompt to the gateway only for an authenticated browser session', async () => {
    const { app } = await fixture();
    const invalidHeaders: Record<string, string>[] = [{}, { cookie: 'huahuo-studio-access=unverified' }, { ...identityHeaders(), 'x-huahuo-user-id': 'invalid' }];
    for (const headers of invalidHeaders) {
      expect((await app.request('/studio-auth/capabilities', { headers })).status).toBe(401);
    }
    const response=await app.request('/studio-auth/capabilities', { headers: identityHeaders() });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ enabled: false, login: null });
    expect(response.headers.get('cache-control')).toBe('no-store');
    const bearer=await app.request('/studio-auth/capabilities', { headers: { ...identityHeaders(), 'x-huahuo-auth-method': 'bearer' } });
    expect(await bearer.json()).toEqual({ enabled: true, login: null });
    expect((await app.request('/api/context', { headers: identityHeaders() })).status).toBe(200);
    expect((await app.request('/api/context')).status).toBe(401);
    const disabled=await fixture(false);
    expect((await disabled.app.request('/studio-auth/capabilities', { headers: identityHeaders() })).status).toBe(404);
    expect(await (await disabled.app.request('/api/auth/capabilities', { headers: identityHeaders() })).json()).toEqual({ enabled: true, login: null });
  });

  it('keeps SMS/login contracts, writes prefixed cookies without verifying the token in Agent', async () => {
    const { app, requests } = await fixture();
    const sms = await app.request('/studio-auth/sms-code', json({ phone: '13800000001', requestId: sessionId }));
    expect(await sms.json()).toEqual({ smsRequestId, cooldownSeconds: 60 });
    expect(requests[0].headers.get('x-idempotency-key')).toBe(sessionId);
    const login = await app.request('/studio-auth/login', json(loginBody()));
    expect(login.status).toBe(200);
    expect(await login.text()).not.toMatch(/accessToken|refreshToken|opaque-server/u);
    const cookies = login.headers.getSetCookie();
    expect(cookies.filter(c => c.includes('Path=/agent;'))).toHaveLength(2);
    expect(cookies.filter(c => c.includes('Path=/;') && c.includes('Max-Age=0'))).toHaveLength(2);
    expect(cookies.every(c => c.includes('HttpOnly') && c.includes('SameSite=Lax'))).toBe(true);
  });

  it('requires gateway identity even if a JWT or cookie is present and preserves user isolation', async () => {
    const { app, requests } = await fixture();
    const anonymous = await app.request('/agent/');
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get('location')).toBeNull();
    for (const headers of [{}, { authorization: 'Bearer token' }, { cookie: 'huahuo-studio-access=token' }]) {
      expect((await app.request('/api/context', { headers: headers as HeadersInit })).status).toBe(401);
    }
    const contexts = await Promise.all([alice, bob].map(user => app.request('/api/context', { headers: identityHeaders(user) }).then(r => r.json())));
    expect(contexts).toEqual([{ resourceId: alice }, { resourceId: bob }]);
    const result = await app.request('/api/fixture/rag', {
      method: 'POST', headers: { 'content-type': 'application/json', ...identityHeaders() }, body: '{}',
    });
    expect(result.status).toBe(200); expect(await result.json()).toEqual({ mode: 'hybrid', query: 'test', results: [{ owner: alice }] });
    const forwarded = requests.find(r => r.path === '/internal/v1/rag/query')!;
    expect(forwarded.headers.get('x-huahuo-session-id')).toBe(sessionId);
    expect(forwarded.headers.has('authorization')).toBe(false);
    expect(forwarded.headers.has('x-huahuo-service-key')).toBe(false);
  });

  it('has no duplicate logout implementation; the ingress routes logout to Server', async () => {
    const { app, requests } = await fixture();
    const result = await app.request('/studio-auth/logout', json({}, identityHeaders()));
    expect(result.status).toBe(404);
    expect(result.headers.getSetCookie()).toHaveLength(0);
    expect(requests).toHaveLength(0);
  });

  it('keeps cookie same-origin protection and rejects invalid inputs before contacting Server', async () => {
    const { app, requests } = await fixture();
    expect((await app.request('/studio-auth/sms-code', json({ phone: '13800000001', requestId: sessionId }, { origin: 'https://other.test' }))).status).toBe(403);
    expect((await app.request('/studio-auth/sms-code', json({ phone: '123', requestId: sessionId }))).status).toBe(400);
    expect((await app.request('/studio-auth/login', json({ ...loginBody(), agreementAccepted: false }))).status).toBe(400);
    expect(requests).toHaveLength(0);
  });

  it('generates prefixed login requests, links and redirects with valid script and CSP', async () => {
    const { app } = await fixture();
    const response = await app.request('/studio-login'), html = await response.text();
    expect(html).toContain('/agent/studio-auth/legal/agreement');
    expect(html).toContain("fetch('/agent/studio-auth/'");
    expect(html).toContain("location.replace('/agent/')");
    expect(html).not.toMatch(/fetch\('\/studio-auth|location.replace\('\/'/u);
    const nonce = /nonce="([^"]+)"/u.exec(html)![1];
    expect(response.headers.get('content-security-policy')).toContain(`script-src 'nonce-${nonce}'`);
    new Script(/<script[^>]*>([\s\S]*?)<\/script>/u.exec(html)![1]);
    expect((await (await app.request('/studio-auth/legal/agreement')).text())).toContain('2026年08月20日');
    expect((await app.request('/studio-auth/session', { headers: identityHeaders() })).status).toBe(200);
  });

  it('validates public prefix, remains opt-in and cannot enable phone Studio in production', () => {
    expect(loadStudioLoginConfig({ APP_ENV: 'test' })).toMatchObject({ enabled: false, publicPath: '/agent' });
    expect(() => loadStudioLoginConfig({ APP_ENV: 'production', HUAHUO_STUDIO_AUTH_ENABLED: 'true' })).toThrow('TEST_ENVIRONMENT');
    for (const path of ['/a/../b', '//evil', '/a?b', '/a\"']) expect(() => loadStudioLoginConfig({ HUAHUO_AGENT_PUBLIC_PATH: path })).toThrow('PUBLIC_PATH_INVALID');
    const cookies = tokenCookies({ accessToken: 'opaque', refreshToken: 'opaque-refresh', accessTokenExpiresAt: new Date(Date.now() + 60_000).toISOString() }, true);
    expect(cookies.every(c => c.includes('Secure') && c.includes('HttpOnly'))).toBe(true);
  });

  it('does not leak upstream errors or retry stateful authentication requests', async () => {
    const fetcher = vi.fn(async () => Response.json({ success: false, error: { code: 'SMS_RATE_LIMITED', message: 'private details' }, traceId: 'studio-test' }, { status: 429 }));
    vi.stubGlobal('fetch', fetcher);
    await expect(new StudioIdentityClient({ baseUrl: 'https://business.test' }).sendCode('13800000001', sessionId)).rejects.toMatchObject({ code: 'SMS_RATE_LIMITED', status: 429 });
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
