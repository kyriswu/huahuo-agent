import { randomBytes } from 'node:crypto';
import { registerApiRoute, type ContextWithMastra, type Middleware } from '@mastra/core/server';
import { z } from 'zod';
import { readTrustedIdentity, applyTrustedIdentity } from '../auth/trusted-identity.js';
import { loadStudioLoginConfig, type StudioLoginConfig } from './config.js';
import { StudioIdentityClient, StudioLoginError } from './identity-client.js';
import { tokenCookies } from './token-bridge.js';
import { legalPage, loginPage } from './pages.js';
import { studioLegalDocuments } from './legal.js';

const phone = z.string().trim().regex(/^(?:\+86)?1[3-9]\d{9}$/u);
const smsInput = z.object({ phone, requestId: z.string().uuid() }).strict();
const loginInput = z.object({
  phone, smsRequestId: z.string().uuid(), smsCode: z.string().regex(/^\d{6}$/u),
  clientId: z.string().uuid(), agreementAccepted: z.literal(true), timeZone: z.string().min(1).max(64),
  requestId: z.string().uuid(),
}).strict();

function origin(c: ContextWithMastra, config: StudioLoginConfig): string {
  if (config.origin) return config.origin;
  const url = new URL(c.req.url);
  if (c.req.header('x-forwarded-proto')?.split(',')[0]?.trim() === 'https') url.protocol = 'https:';
  return url.origin;
}

function assertSameOrigin(c: ContextWithMastra, config: StudioLoginConfig): void {
  if (c.req.header('origin') !== origin(c, config)) throw new StudioLoginError('ORIGIN_INVALID', 403);
}

function failure(error: unknown): Response {
  const known = error instanceof StudioLoginError;
  return Response.json({ error: { code: known ? error.code : 'TRUSTED_IDENTITY_REQUIRED' } }, {
    status: known ? error.status : 401,
    headers: { 'cache-control': 'no-store' },
  });
}

function page(body: (nonce: string) => string): Response {
  const nonce = randomBytes(18).toString('base64url');
  return new Response(body(nonce), { headers: {
    'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
    'referrer-policy': 'same-origin', 'x-content-type-options': 'nosniff',
    'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'self'`,
  } });
}

async function jsonBody<T>(c: ContextWithMastra, schema: z.ZodType<T>): Promise<T> {
  if (!c.req.header('content-type')?.startsWith('application/json')) throw new StudioLoginError('REQUEST_INVALID', 400);
  const raw = await c.req.text();
  if (raw.length > 4_096) throw new StudioLoginError('REQUEST_INVALID', 400);
  try { return schema.parse(JSON.parse(raw)); } catch { throw new StudioLoginError('REQUEST_INVALID', 400); }
}

export function createStudioGateway(
  config = loadStudioLoginConfig(),
  identity = new StudioIdentityClient(),
) {
  const setCookies = (c: ContextWithMastra, tokens: Parameters<typeof tokenCookies>[0]) => {
    for (const value of tokenCookies(tokens, origin(c, config).startsWith('https:'), config.publicPath)) c.header('Set-Cookie', value, { append: true });
  };
  const authenticate = (c: ContextWithMastra) => readTrustedIdentity(c.req.raw.headers);
  const middleware: Middleware = async (c, next) => {
    const path = c.req.path;
    const publicRoute = (c.req.method === 'GET' && (path === '/studio-login' || /^\/studio-auth\/legal\/(agreement|privacy)$/u.test(path)))
      || (c.req.method === 'POST' && ['/studio-auth/login', '/studio-auth/sms-code'].includes(path));
    if (publicRoute || path.startsWith('/internal/') || ['/health', '/api', '/api/health', '/api/status'].includes(path)) return next();
    try {
      const user = authenticate(c);
      // Server admission already checks browser-cookie origins. Trusted internal
      // delegation carries identity, not browser Origin/Cookie headers.
      const context = c.get('requestContext');
      if (context) applyTrustedIdentity(context, user);
      return next();
    } catch (error) {
      return failure(error);
    }
  };

  const routes = config.enabled ? [
    registerApiRoute('/studio-login', { method: 'GET', requiresAuth: false, handler: () => page(nonce => loginPage(nonce, config.publicPath)) }),
    registerApiRoute('/studio-auth/legal/:document', {
      method: 'GET', requiresAuth: false, handler: c => {
        const key = c.req.param('document');
        const document = key === 'agreement' || key === 'privacy' ? studioLegalDocuments[key] : undefined;
        return document ? page(nonce => legalPage(nonce, document.title, document.text, config.publicPath)) : new Response('Not found', { status: 404 });
      },
    }),
    registerApiRoute('/studio-auth/sms-code', {
      method: 'POST', requiresAuth: false, handler: async c => {
        try {
          assertSameOrigin(c, config);
          const input = await jsonBody(c, smsInput);
          return c.json(await identity.sendCode(input.phone, input.requestId), 200, { 'cache-control': 'no-store' });
        } catch (error) { return failure(error); }
      },
    }),
    registerApiRoute('/studio-auth/login', {
      method: 'POST', requiresAuth: false, handler: async c => {
        try {
          assertSameOrigin(c, config);
          const { requestId, ...input } = await jsonBody(c, loginInput);
          const result = await identity.login({
            ...input, clientType: 'web', clientVersion: 'huahuo-studio/0.1.0',
            agreementVersion: config.agreementVersion, privacyVersion: config.privacyVersion,
          }, requestId);
          setCookies(c, result);
          return c.json({ user: result.user }, 200, { 'cache-control': 'no-store' });
        } catch (error) { return failure(error); }
      },
    }),
    registerApiRoute('/studio-auth/session', {
      method: 'GET', requiresAuth: false, handler: async c => {
        try {
          const principal = authenticate(c);
          return c.json({ userId: principal.userId }, 200, { 'cache-control': 'no-store' });
        } catch (error) { return failure(error); }
      },
    }),
  ] : [];
  return { enabled: config.enabled, middleware, routes };
}
