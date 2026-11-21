import {resolveTraceId} from '../trace.js';

export interface TrustedHuahuoIdentity {
  readonly id: string;
  readonly userId: string;
  readonly sessionId: string;
  readonly authMethod: 'bearer' | 'cookie';
  readonly traceId: string;
}

export const identityHeaderNames = {
  userId: 'x-huahuo-user-id',
  sessionId: 'x-huahuo-session-id',
  authMethod: 'x-huahuo-auth-method',
  traceId: 'x-trace-id',
} as const;

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
// Match Server's existing requestTrace contract. Trace metadata is optional and
// never determines identity; replace invalid values instead of rejecting auth.
export type TrustedIdentityHeaders = Headers | Record<string, string | string[] | undefined>;

function header(headers: TrustedIdentityHeaders, name: string): string | undefined {
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  const matches = Object.entries(headers).filter(([key]) => key.toLowerCase() === name);
  if (matches.length !== 1 || typeof matches[0][1] !== 'string') return undefined;
  return matches[0][1];
}

/** Read identity asserted by the gateway or an authorized internal caller.
 * JWT verification and session/account validation belong to the Server admission endpoint.
 * Authorization, including memory ownership, still belongs to each service.
 */
export function readTrustedIdentity(headers: TrustedIdentityHeaders): TrustedHuahuoIdentity {
  const userId = header(headers, identityHeaderNames.userId);
  const sessionId = header(headers, identityHeaderNames.sessionId);
  const authMethod = header(headers, identityHeaderNames.authMethod);
  const candidateTrace = header(headers, identityHeaderNames.traceId);
  const traceId = resolveTraceId(candidateTrace);
  if (!userId || !sessionId || !uuid.test(userId) || !uuid.test(sessionId)
    || (authMethod !== 'bearer' && authMethod !== 'cookie')) {
    throw new Error('TRUSTED_IDENTITY_INVALID');
  }
  return Object.freeze({ id: userId.toLowerCase(), userId: userId.toLowerCase(), sessionId: sessionId.toLowerCase(), authMethod, traceId });
}

export function trustedIdentityHeaders(identity: TrustedHuahuoIdentity): Record<string, string> {
  return {
    [identityHeaderNames.userId]: identity.userId,
    [identityHeaderNames.sessionId]: identity.sessionId,
    [identityHeaderNames.authMethod]: identity.authMethod,
    [identityHeaderNames.traceId]: identity.traceId,
  };
}
