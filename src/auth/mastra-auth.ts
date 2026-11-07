import type { Middleware, MastraAuthConfig } from '@mastra/core/server';
import type { RequestContext } from '@mastra/core/request-context';
import { createHuahuoJwtVerifier, type AuthenticatedHuahuoUser } from './jwt.js';
import { serviceKeyHeader, verifyServerToAgentServiceKey } from './service-key.js';

export const HUAHUO_SUBJECT_CONTEXT_KEY = 'huahuoUserId';
export const HUAHUO_USER_JWT_CONTEXT_KEY = 'huahuoUserJwt';

const verifier = createHuahuoJwtVerifier();
// Local Studio can be opened without putting a user JWT in the URL. A
// user-scoped RAG run still supplies its JWT through RequestContext, while
// production keeps every Agent API route protected.
const localAuthBypassEnvironments = new Set(['development', 'test']);
export const huahuoApiAuthRequired = !localAuthBypassEnvironments.has(process.env.APP_ENV ?? '');
const protectedAgentApiRoutes = huahuoApiAuthRequired ? ['/api/*'] : [];
const publicAgentApiRoutes = huahuoApiAuthRequired
  ? ['/api', '/api/health', '/api/status']
  : ['/api', '/api/*', '/api/health', '/api/status'];

export const huahuoAuth: MastraAuthConfig<AuthenticatedHuahuoUser> = {
  protected: protectedAgentApiRoutes,
  public: publicAgentApiRoutes,
  authenticateToken: async token => verifier(token),
  mapUserToResourceId: user => user.userId,
};

export const huahuoAuthMiddleware: Middleware = async (context, next) => {
  const requestContext = context.get('requestContext') as RequestContext;
  const user = requestContext.get('user') as AuthenticatedHuahuoUser | undefined;
  if (user) {
    requestContext.set(HUAHUO_SUBJECT_CONTEXT_KEY, user.userId);
    requestContext.set(HUAHUO_USER_JWT_CONTEXT_KEY, user.accessToken);
  }
  return next();
};

export const huahuoServiceAuthMiddleware: Middleware = async (context, next) => {
  // Stored configurations are shared Agent administration, not App-user CRUD.
  // Local Studio retains its existing development workflow. Production also
  // requires the trusted Server service credential for Editor management.
  try {
    const path = decodeURIComponent(context.req.path);
    const editorManagement = /^\/api\/(?:stored|editor)(?:\/|$)/u.test(path);
    if (!path.startsWith('/internal/') && !(huahuoApiAuthRequired && editorManagement)) return next();
    verifyServerToAgentServiceKey(context.req.header(serviceKeyHeader));
  } catch {
    return new Response(JSON.stringify({ error: { code: 'UNAUTHORIZED' } }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  }
  return next();
};
