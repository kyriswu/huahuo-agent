import { createRequire } from 'node:module';
import { Script } from 'node:vm';
import { RequestContext, MASTRA_AUTH_TOKEN_KEY, MASTRA_RESOURCE_ID_KEY } from '@mastra/core/request-context';
import type { ContextWithMastra, Handler, MiddlewareHandler } from '@mastra/core/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStudioGateway } from '../src/studio/gateway.js';
import { StudioIdentityClient } from '../src/studio/identity-client.js';
import { StudioTokenBridge, tokenCookies } from '../src/studio/token-bridge.js';
import { loadStudioLoginConfig } from '../src/studio/config.js';
import { loginPage } from '../src/studio/pages.js';
import { HuahuoServerClient } from '../src/server/huahuo-server-client.js';
import type { AuthenticatedHuahuoUser } from '../src/auth/jwt.js';

// Exercise the same Hono HTTP implementation already supplied by the Mastra CLI.
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
const requestId = 'c0000000-0000-4000-8000-000000000003';
const smsRequestId = 'd0000000-0000-4000-8000-000000000004';
const config = { enabled: true, agreementVersion: '2026-08-20', privacyVersion: '2026-08-20' };
const principal = (token: string): AuthenticatedHuahuoUser => ({
  id: token.startsWith('bob') ? bob : alice, userId: token.startsWith('bob') ? bob : alice, accessToken: token,
  claims: {
    sub: token.startsWith('bob') ? bob : alice, iss: 'huahuo-server', aud: ['huahuo-server', 'huahuo-agent'],
    iat: Date.now() / 1_000, exp: Date.now() / 1_000 + (token.includes('old') ? 10 : 900), jti: token,
  },
});
const verify = async (token: string) => {
  if (!/^(alice|bob)\.(jwt|old|fresh)$/u.test(token)) throw new Error('USER_JWT_INVALID');
  return principal(token);
};
const json = (body: unknown) => ({
  method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(body),
});
const cookies = (response: Response) => response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

async function fixture() {
  const requests: Array<{ path: string; body: Record<string, unknown>; headers: Headers }> = [];
  vi.stubEnv('HUAHUO_SERVER_BASE_URL', 'http://business.test');
  vi.stubEnv('HUAHUO_AGENT_TO_SERVER_API_KEY', 'fixture-service-key');
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    const headers = new Headers(init.headers);
    const body = init.body ? JSON.parse(String(init.body)) : {};
    requests.push({ path, body, headers });
    if (path === '/api/v1/auth/sms-code') return Response.json({ success: true, data: { smsRequestId, cooldownSeconds: 60, providerMode: 'mock', testCode: '123456' } });
    if (path === '/api/v1/auth/login') {
      const isBob = body.phone === '13900000002';
      return Response.json({ success: true, data: {
        accessToken: isBob ? 'bob.jwt' : 'alice.jwt', refreshToken: isBob ? 'bob-refresh' : 'alice-refresh',
        user: { userId: isBob ? bob : alice, displayName: isBob ? 'Bob' : 'Alice', phoneMasked: '138****0001' },
      } });
    }
    if (path === '/api/v1/auth/refresh') return Response.json({ success: true, data: { accessToken: 'alice.fresh', refreshToken: 'alice-refresh-next' } });
    if (path === '/api/v1/auth/logout') return Response.json({ success: true, data: { revoked: true } });
    if (path === '/internal/v1/rag/query') return Response.json({ evidence: [], owner: headers.get('authorization') === 'Bearer bob.jwt' ? bob : alice });
    throw new Error('Unexpected HTTP destination in isolated test');
  }));
  const gateway = createStudioGateway(config, new StudioIdentityClient('http://business.test'), verify);
  const app = new Hono();
  app.use('*', async (c, next) => { c.set('requestContext', new RequestContext()); await next(); });
  for (const route of gateway.routes) {
    if ('handler' in route && route.handler) app.on(route.method, route.path, route.handler as Handler);
  }
  app.use('*', gateway.middleware);
  app.on('GET', '/', c => c.html('<html><title>Mastra Studio fixture</title></html>'));
  app.on('GET', '/api/context', c => {
    const context = (c as ContextWithMastra).get('requestContext');
    return c.json({ userId: context.get('huahuoUserId'), resourceId: context.get(MASTRA_RESOURCE_ID_KEY) });
  });
  app.on('POST', '/api/fixture/rag', async c => {
    const context = (c as ContextWithMastra).get('requestContext');
    // A UI-supplied value must not replace the verified HTTP identity.
    context.set('huahuoUserJwt', 'forged-client-value');
    return c.json(await new HuahuoServerClient({ requestContext: context }).ragQuery({ query: 'test' }));
  });
  return { app, requests };
}

const loginBody = (phone = '13800000001') => ({
  phone, smsRequestId, smsCode: '123456', clientId: requestId, requestId,
  agreementAccepted: true, timeZone: 'Asia/Shanghai',
});

describe('test Studio phone login', () => {
  it('reuses the Server SMS and login contracts and supplies the verified JWT to tools', async () => {
    const { app, requests } = await fixture();
    expect((await app.request('/')).status).toBe(302);
    expect((await app.request('/api/context')).status).toBe(401);
    const sms = await app.request('/studio-auth/sms-code', json({ phone: '13800000001', requestId }));
    expect(await sms.json()).toEqual({ smsRequestId, cooldownSeconds: 60 });
    expect(requests[0].body).toEqual({ phone: '13800000001', purpose: 'sign_in' });
    expect(requests[0].headers.get('x-idempotency-key')).toBe(requestId);
    const login = await app.request('/studio-auth/login', json(loginBody()));
    expect(login.status).toBe(200);
    expect(await login.text()).not.toMatch(/accessToken|refreshToken|alice\.jwt/u);
    expect(login.headers.getSetCookie()).toHaveLength(2);
    expect(login.headers.getSetCookie().every(value => value.includes('HttpOnly') && value.includes('SameSite=Lax'))).toBe(true);
    const cookie = cookies(login);
    const context = await app.request('/api/context', { headers: { cookie } });
    expect(await context.json()).toEqual({ userId: alice, resourceId: alice });
    expect((await app.request('/', { headers: { cookie } })).status).toBe(200);
    const rag = await app.request('/api/fixture/rag', { ...json({}), headers: { ...json({}).headers, cookie } });
    expect(rag.status).toBe(200);
    const forwarded = requests.find(item => item.path === '/internal/v1/rag/query')!;
    expect(forwarded.headers.get('authorization')).toBe('Bearer alice.jwt');
    expect(forwarded.headers.get('x-huahuo-service-key')).toBe('fixture-service-key');
    expect(requests.find(item => item.path === '/api/v1/auth/login')!.body).toMatchObject({
      clientType: 'web', agreementVersion: '2026-08-20', privacyVersion: '2026-08-20', clientVersion: 'huahuo-studio/0.1.0',
    });
  });

  it('isolates concurrent users and gives an explicit API bearer token precedence over cookies', async () => {
    const { app } = await fixture();
    const [first, second] = await Promise.all(['13800000001', '13900000002'].map(phone => app.request('/studio-auth/login', json(loginBody(phone)))));
    const [a, b] = await Promise.all([cookies(first), cookies(second)].map(cookie => app.request('/api/context', { headers: { cookie } }).then(r => r.json())));
    expect(a).toEqual({ userId: alice, resourceId: alice }); expect(b).toEqual({ userId: bob, resourceId: bob });
    const api = await app.request('/api/context', { headers: { cookie: cookies(first), authorization: 'Bearer bob.jwt' } });
    expect(await api.json()).toEqual({ userId: bob, resourceId: bob });
    expect((await app.request('/api/context', { headers: { cookie: cookies(first), authorization: 'invalid' } })).status).toBe(401);
  });

  it('refreshes an expiring token once for simultaneous requests, then forwards the new token', async () => {
    const { app, requests } = await fixture();
    const cookie = 'huahuo-studio-access=alice.old; huahuo-studio-refresh=alice-refresh';
    const results = await Promise.all(Array.from({ length: 5 }, () => app.request('/api/context', { headers: { cookie } })));
    expect(results.every(result => result.status === 200)).toBe(true);
    expect(requests.filter(item => item.path === '/api/v1/auth/refresh')).toHaveLength(1);
    const replacement = cookies(results[0]);
    expect(replacement).toContain('alice.fresh'); expect(replacement).toContain('alice-refresh-next');
    expect(requests.find(item => item.path === '/api/v1/auth/refresh')!.headers.has('x-idempotency-key')).toBe(false);
  });

  it('logs out through the Server and expires both cookies', async () => {
    const { app, requests } = await fixture();
    const login = await app.request('/studio-auth/login', json(loginBody()));
    const result = await app.request('/studio-auth/logout', { ...json({}), headers: { ...json({}).headers, cookie: cookies(login) } });
    expect(result.status).toBe(200);
    expect(result.headers.getSetCookie().every(value => value.includes('Max-Age=0'))).toBe(true);
    expect(requests.find(item => item.path === '/api/v1/auth/logout')!.headers.get('authorization')).toBe('Bearer alice.jwt');
  });

  it('rejects cross-origin SMS requests, invalid phones, and unaccepted agreements before contacting the Server', async () => {
    const { app, requests } = await fixture();
    expect((await app.request('/studio-auth/sms-code', { ...json({ phone: '13800000001', requestId }), headers: { 'content-type': 'application/json', origin: 'https://other.test' } })).status).toBe(403);
    expect((await app.request('/studio-auth/sms-code', json({ phone: '123', requestId }))).status).toBe(400);
    expect((await app.request('/studio-auth/login', json({ ...loginBody(), agreementAccepted: false }))).status).toBe(400);
    expect(requests).toHaveLength(0);
  });

  it('serves a simple login page and the existing legal documents without exposing credentials', async () => {
    const { app } = await fixture();
    const response = await app.request('/studio-login');
    const html = await response.text();
    expect(html).toContain('获取验证码'); expect(html).toContain('autocomplete="one-time-code"');
    expect(html).not.toMatch(/业务负责人|RequestContext|JWT|checkbox[^>]*checked/u);
    const nonce = /nonce="([^"]+)"/u.exec(html)![1];
    expect(response.headers.get('content-security-policy')).toContain(`script-src 'nonce-${nonce}'`);
    new Script(/<script[^>]*>([\s\S]*?)<\/script>/u.exec(html)![1]);
    expect((await (await app.request('/studio-auth/legal/agreement')).text())).toContain('2026年08月20日');
    expect((await app.request('/studio-auth/legal/constructor')).status).toBe(404);
  });
});

describe('test login boundaries', () => {
  it('leaves internal service-to-service authentication on its existing path', async () => {
    const gateway = createStudioGateway(config, new StudioIdentityClient('http://business.test'), verify);
    const next = vi.fn(async () => undefined);
    await gateway.middleware({ req: { path: '/internal/v1/status' } } as ContextWithMastra, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it('is opt-in and cannot be enabled for production', () => {
    expect(loadStudioLoginConfig({ APP_ENV: 'test' }).enabled).toBe(false);
    expect(() => loadStudioLoginConfig({ APP_ENV: 'production', HUAHUO_STUDIO_AUTH_ENABLED: 'true' })).toThrow('TEST_ENVIRONMENT');
    expect(() => loadStudioLoginConfig({ APP_ENV: 'test', HUAHUO_STUDIO_AUTH_ENABLED: 'yes' })).toThrow('INVALID');
  });

  it('clears expired refresh sessions and never falls back from an invalid explicit bearer token', async () => {
    const refresh = vi.fn(async () => { throw new Error('private upstream details'); });
    const bridge = new StudioTokenBridge({ refresh }, verify);
    await expect(bridge.authenticate('Bearer invalid', 'huahuo-studio-refresh=alice-refresh')).rejects.toThrow('USER_JWT_INVALID');
    expect(refresh).not.toHaveBeenCalled();
    await expect(bridge.authenticate(undefined, 'huahuo-studio-refresh=alice-refresh')).rejects.toThrow('STUDIO_LOGIN_EXPIRED');
    expect(tokenCookies(undefined, true).every(cookie => cookie.includes('Max-Age=0') && cookie.includes('Secure'))).toBe(true);
  });

  it('does not leak upstream error bodies or retry stateful authentication calls', async () => {
    const fetcher = vi.fn(async () => Response.json({ error: { code: 'SMS_RATE_LIMITED', message: 'private details' } }, { status: 429 }));
    vi.stubGlobal('fetch', fetcher);
    await expect(new StudioIdentityClient('https://business.test').sendCode('13800000001', requestId)).rejects.toMatchObject({ code: 'SMS_RATE_LIMITED', status: 429 });
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
