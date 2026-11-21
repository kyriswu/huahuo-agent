import type { Middleware, MastraAuthConfig } from '@mastra/core/server';
import { MASTRA_AUTH_TOKEN_KEY, MASTRA_NORMALIZED_USER_KEY, MASTRA_RESOURCE_ID_KEY, type RequestContext } from '@mastra/core/request-context';
import { readTrustedIdentity, trustedIdentityHeaders, type TrustedHuahuoIdentity } from './trusted-identity.js';

// Mastra reserves this native provider key and drops it on durable restore.
const MASTRA_PROVIDER_USER_KEY = 'mastra__user';

/** Set native reserved identity keys so body-supplied resource IDs cannot win. */
export function applyTrustedIdentity(requestContext: RequestContext, identity: TrustedHuahuoIdentity): void {
  const validated = readTrustedIdentity(trustedIdentityHeaders(identity));
  requestContext.set(MASTRA_PROVIDER_USER_KEY, validated);
  requestContext.set('user', validated);
  requestContext.set(MASTRA_NORMALIZED_USER_KEY, { id: validated.userId });
  requestContext.set(MASTRA_RESOURCE_ID_KEY, validated.userId);
  requestContext.delete(MASTRA_AUTH_TOKEN_KEY);
}

/** Read the verified provider user from the native Mastra context. */
export function getTrustedIdentity(requestContext: RequestContext | undefined): TrustedHuahuoIdentity {
  const value = requestContext?.get(MASTRA_PROVIDER_USER_KEY);
  if (!value || typeof value !== 'object') throw new Error('TRUSTED_IDENTITY_REQUIRED');
  return readTrustedIdentity(trustedIdentityHeaders(value as TrustedHuahuoIdentity));
}

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
