import type { Middleware, MastraAuthConfig } from '@mastra/core/server';
import type { RequestContext } from '@mastra/core/request-context';
import { applyTrustedIdentity, readTrustedIdentity, type TrustedHuahuoIdentity } from './trusted-identity.js';

export const huahuoAuth = {
  protected: ['/api/*', '/internal/*'],
  public: ['/api', '/api/health', '/api/status'],
  // Mastra calls this hook even without a Bearer token. Keep native auth and
  // resource mapping so its thread/workflow ownership checks remain active.
  authenticateToken: async (_token, request) => {
    return readTrustedIdentity(request.headers ?? ('raw' in request ? request.raw?.headers : undefined) ?? {});
  },
  mapUserToResourceId: user => user.userId,
} satisfies MastraAuthConfig<TrustedHuahuoIdentity>;

export const huahuoAuthMiddleware: Middleware = async (context, next) => {
  const path = context.req.path;
  const protectedApi = (path.startsWith('/api/') && !['/api/health', '/api/status'].includes(path))
    || path.startsWith('/internal/');
  const headers = context.req.raw.headers;
  const hasIdentity = headers.has('x-huahuo-user-id') || headers.has('x-huahuo-session-id') || headers.has('x-huahuo-auth-method');
  if (protectedApi || hasIdentity) {
    try {
      applyTrustedIdentity(context.get('requestContext') as RequestContext, readTrustedIdentity(headers));
    } catch {
      return Response.json({ error: { code: 'UNAUTHORIZED' } }, { status: 401 });
    }
  }
  return next();
};
