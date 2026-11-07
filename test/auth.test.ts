import { createServer } from 'node:http';
import { generateKeyPair, SignJWT, exportJWK } from 'jose';
import { afterEach, describe, expect, it } from 'vitest';
import { createHuahuoJwtVerifier, loadHuahuoJwtConfig } from '../src/auth/jwt.js';
import { validateAgentServiceAuthConfig, verifyServerToAgentServiceKey } from '../src/auth/service-key.js';
import { HuahuoServerClient } from '../src/server/huahuo-server-client.js';
import { resolveHuahuoServerBaseUrl } from '../src/server/base-url.js';
import { RequestContext } from '@mastra/core/request-context';
import { huahuoAuth } from '../src/auth/mastra-auth.js';

const servers: Array<ReturnType<typeof createServer>> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});

async function jwksUrl() {
  const { publicKey, privateKey } = await generateKeyPair('EdDSA');
  const { publicKey: previousPublicKey, privateKey: previousPrivateKey } = await generateKeyPair('EdDSA');
  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = 'server-current';
  publicJwk.alg = 'EdDSA';
  publicJwk.use = 'sig';
  const previousJwk = await exportJWK(previousPublicKey);
  previousJwk.kid = 'server-previous';
  previousJwk.alg = 'EdDSA';
  previousJwk.use = 'sig';
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ keys: [publicJwk, previousJwk] }));
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('JWKS server did not bind');
  return { url: `http://127.0.0.1:${address.port}/.well-known/jwks.json`, privateKey, previousPrivateKey };
}

async function sign(privateKey: CryptoKey, overrides: Record<string, unknown> = {}, kid = 'server-current') {
  return new SignJWT({
    sub: 'user-123',
    iss: 'huahuo-server',
    aud: ['huahuo-server', 'huahuo-agent'],
    jti: 'token-123',
    ...overrides,
  })
    .setProtectedHeader({ alg: 'EdDSA', typ: 'JWT', kid })
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);
}

describe('Agent JWT verification', () => {
  it('protects every Agent API route in every environment', () => {
    expect(huahuoAuth.protected).toContain('/api/*');
  });

  it('rejects localhost JWKS configuration in production', () => {
    const base = { APP_ENV: 'production', HUAHUO_SERVER_BASE_URL: 'https://api.example.test' };
    expect(() => loadHuahuoJwtConfig({ ...base, APP_JWT_JWKS_URL: 'http://localhost:3000/.well-known/jwks.json' })).toThrow('APP_JWT_JWKS_URL_PRODUCTION_INVALID');
    expect(loadHuahuoJwtConfig({ ...base, APP_JWT_JWKS_URL: 'http://api-server:3000/.well-known/jwks.json' }).jwksUrl).toContain('api-server');
    expect(() => loadHuahuoJwtConfig({ APP_ENV: 'production', APP_JWT_JWKS_URL: 'https://api.example.test/.well-known/jwks.json' })).toThrow('HUAHUO_SERVER_BASE_URL_REQUIRED');
  });

  it('normalizes the Server base URL and rejects unsafe production defaults', () => {
    expect(resolveHuahuoServerBaseUrl('http://api-server:3000///', { APP_ENV: 'production' })).toBe('http://api-server:3000');
    expect(() => resolveHuahuoServerBaseUrl(undefined, { APP_ENV: 'production' })).toThrow('HUAHUO_SERVER_BASE_URL_REQUIRED');
    expect(() => resolveHuahuoServerBaseUrl('http://localhost:3000', { APP_ENV: 'production' })).toThrow('HUAHUO_SERVER_BASE_URL_PRODUCTION_INVALID');
  });

  it('verifies the shared Ed25519 JWT and exposes sub as userId', async () => {
    const { url, privateKey } = await jwksUrl();
    const user = await createHuahuoJwtVerifier({ jwksUrl: url, issuer: 'huahuo-server', audience: 'huahuo-agent' })(await sign(privateKey));
    expect(user.userId).toBe('user-123');
    expect(user.claims.jti).toBe('token-123');
  });

  it('accepts a token signed by the previous rotation key', async () => {
    const { url, previousPrivateKey } = await jwksUrl();
    const user = await createHuahuoJwtVerifier({ jwksUrl: url, issuer: 'huahuo-server', audience: 'huahuo-agent' })(await sign(previousPrivateKey, {}, 'server-previous'));
    expect(user.userId).toBe('user-123');
  });

  it('refreshes JWKS when a previously unknown kid appears', async () => {
    const { publicKey: firstPublicKey } = await generateKeyPair('EdDSA');
    const { publicKey: nextPublicKey, privateKey: nextPrivateKey } = await generateKeyPair('EdDSA');
    const firstJwk = await exportJWK(firstPublicKey);
    firstJwk.kid = 'server-current';
    firstJwk.alg = 'EdDSA';
    firstJwk.use = 'sig';
    const nextJwk = await exportJWK(nextPublicKey);
    nextJwk.kid = 'server-next';
    nextJwk.alg = 'EdDSA';
    nextJwk.use = 'sig';
    let requests = 0;
    const server = createServer((_request, response) => {
      requests += 1;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ keys: requests === 1 ? [firstJwk] : [firstJwk, nextJwk] }));
    });
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('JWKS server did not bind');
    const verifier = createHuahuoJwtVerifier({
      jwksUrl: `http://127.0.0.1:${address.port}/.well-known/jwks.json`,
      issuer: 'huahuo-server',
      audience: 'huahuo-agent',
    });
    await expect(verifier(await sign(nextPrivateKey, {}, 'server-next'))).resolves.toMatchObject({ userId: 'user-123' });
    expect(requests).toBe(2);
  });

  it.each([
    ['wrong issuer', { iss: 'other' }],
    ['wrong audience', { aud: ['other-service'] }],
    ['missing jti', { jti: undefined }],
  ])('rejects %s', async (_label, overrides) => {
    const { url, privateKey } = await jwksUrl();
    const token = await sign(privateKey, overrides);
    await expect(createHuahuoJwtVerifier({ jwksUrl: url, issuer: 'huahuo-server', audience: 'huahuo-agent' })(token)).rejects.toThrow('USER_JWT_INVALID');
  });

  it('rejects an invalid header', async () => {
    const { url } = await jwksUrl();
    await expect(createHuahuoJwtVerifier({ jwksUrl: url, issuer: 'huahuo-server', audience: 'huahuo-agent' })('not-a-jwt')).rejects.toThrow('USER_JWT_INVALID');
  });

  it('rejects an expired token and a bad signature', async () => {
    const { url, privateKey } = await jwksUrl();
    const verifier = createHuahuoJwtVerifier({ jwksUrl: url, issuer: 'huahuo-server', audience: 'huahuo-agent' });
    const expired = await new SignJWT({ sub: 'user-123', iss: 'huahuo-server', aud: 'huahuo-agent', jti: 'expired' })
      .setProtectedHeader({ alg: 'EdDSA', typ: 'JWT', kid: 'server-current' })
      .setIssuedAt(1)
      .setExpirationTime(1)
      .sign(privateKey);
    await expect(verifier(expired)).rejects.toThrow('USER_JWT_INVALID');
    const valid = await sign(privateKey);
    const [header, payload, signature] = valid.split('.');
    const tampered = `${header}.${payload}.${signature[0] === 'a' ? 'b' : 'a'}${signature.slice(1)}`;
    await expect(verifier(tampered)).rejects.toThrow('USER_JWT_INVALID');
  });
});

describe('Agent service key verification', () => {
  it('accepts only the configured raw service key', () => {
    expect(() => verifyServerToAgentServiceKey('secret-key', 'secret-key')).not.toThrow();
    expect(() => verifyServerToAgentServiceKey('Bearer secret-key', 'secret-key')).toThrow('AGENT_SERVICE_UNAUTHORIZED');
    expect(() => verifyServerToAgentServiceKey(undefined, 'secret-key')).toThrow('AGENT_SERVICE_UNAUTHORIZED');
  });

  it('fails closed for missing production service keys', () => {
    expect(() => validateAgentServiceAuthConfig({ APP_ENV: 'production' })).toThrow('AGENT_SERVICE_AUTH_CONFIG_REQUIRED');
    expect(() => validateAgentServiceAuthConfig({ APP_ENV: 'production', HUAHUO_SERVER_BASE_URL: 'https://api.example.test', HUAHUO_SERVER_TO_AGENT_API_KEY: 'a'.repeat(43), HUAHUO_AGENT_TO_SERVER_API_KEY: 'b'.repeat(43) })).not.toThrow();
    expect(() => validateAgentServiceAuthConfig({ APP_ENV: 'production', HUAHUO_SERVER_BASE_URL: 'https://api.example.test', HUAHUO_SERVER_TO_AGENT_API_KEY: 'a'.repeat(43), HUAHUO_AGENT_TO_SERVER_API_KEY: 'a'.repeat(43) })).toThrow('AGENT_SERVICE_AUTH_CONFIG_IDENTICAL_KEYS');
  });

  it('sends the user JWT and directional service key separately', async () => {
    const originalFetch = globalThis.fetch;
    let received: HeadersInit | undefined;
    globalThis.fetch = (async (_input, init) => {
      received = init?.headers;
      return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    try {
      const requestContext = new RequestContext();
      requestContext.set('huahuoUserJwt', 'user.jwt');
      await new HuahuoServerClient({ baseUrl: 'http://server.test', serviceKey: 'service-secret', requestContext }).ragQuery({ query: 'hello' });
      const headers = new Headers(received);
      expect(headers.get('authorization')).toBe('Bearer user.jwt');
      expect(headers.get('x-huahuo-service-key')).toBe('service-secret');
      expect(headers.get(['x', 'huahuo', 'user', 'id'].join('-'))).toBeNull();
      received = undefined;
      await new HuahuoServerClient({ baseUrl: 'http://server.test', serviceKey: 'service-secret' }).serviceRequest('/internal/v1/system', { task: 'ping' });
      const systemHeaders = new Headers(received);
      expect(systemHeaders.get('x-huahuo-service-key')).toBe('service-secret');
      expect(systemHeaders.get('authorization')).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('keeps concurrent request contexts isolated', async () => {
    const originalFetch = globalThis.fetch;
    const received: string[] = [];
    globalThis.fetch = (async (_input, init) => {
      received.push(new Headers(init?.headers).get('authorization') ?? '');
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }) as typeof fetch;
    try {
      const firstContext = new RequestContext();
      firstContext.set('huahuoUserJwt', 'first.jwt');
      const secondContext = new RequestContext();
      secondContext.set('huahuoUserJwt', 'second.jwt');
      await Promise.all([
        new HuahuoServerClient({ baseUrl: 'http://server.test', serviceKey: 'service-secret', requestContext: firstContext }).ragQuery({ query: 'one' }),
        new HuahuoServerClient({ baseUrl: 'http://server.test', serviceKey: 'service-secret', requestContext: secondContext }).ragQuery({ query: 'two' }),
      ]);
      expect(received.sort()).toEqual(['Bearer first.jwt', 'Bearer second.jwt']);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
