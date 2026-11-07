import { createRemoteJWKSet, decodeProtectedHeader, jwtVerify, type JWTPayload } from 'jose';
import { resolveHuahuoServerBaseUrl } from '../server/base-url.js';

export interface HuahuoJwtClaims extends JWTPayload {
  sub: string;
  iss: string;
  aud: string | string[];
  iat: number;
  exp: number;
  jti: string;
}

export interface AuthenticatedHuahuoUser {
  id: string;
  userId: string;
  accessToken: string;
  claims: HuahuoJwtClaims;
}

export interface HuahuoJwtConfig {
  jwksUrl: string;
  issuer: string;
  audience: string;
}

const requiredString = (value: unknown, name: string): string => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${name} is required.`);
  }
  return value.trim();
};

export const loadHuahuoJwtConfig = (env: NodeJS.ProcessEnv = process.env): HuahuoJwtConfig => {
  const serverUrl = resolveHuahuoServerBaseUrl(undefined, env);
  const jwksUrl = requiredString(env.APP_JWT_JWKS_URL ?? `${serverUrl}/.well-known/jwks.json`, 'APP_JWT_JWKS_URL');
  if (env.APP_ENV === 'production') {
    const host = new URL(jwksUrl).hostname.toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') throw new Error('APP_JWT_JWKS_URL_PRODUCTION_INVALID');
  }
  return {
    jwksUrl,
    issuer: requiredString(env.APP_JWT_ISSUER ?? 'huahuo-server', 'APP_JWT_ISSUER'),
    audience: requiredString(env.APP_JWT_AUDIENCE ?? 'huahuo-agent', 'APP_JWT_AUDIENCE'),
  };
};

export const createHuahuoJwtVerifier = (config: HuahuoJwtConfig = loadHuahuoJwtConfig()) => {
  const jwks = createRemoteJWKSet(new URL(config.jwksUrl), {
    timeoutDuration: 5_000,
    // Refresh immediately when a token references a newly rotated kid while
    // retaining the normal cacheMaxAge for known keys.
    cooldownDuration: 0,
    cacheMaxAge: 10 * 60_000,
  });

  return async (token: string): Promise<AuthenticatedHuahuoUser> => {
    const normalizedToken = token.trim();
    if (!normalizedToken) throw new Error('USER_JWT_REQUIRED');

    let protectedHeader: ReturnType<typeof decodeProtectedHeader>;
    try {
      protectedHeader = decodeProtectedHeader(normalizedToken);
    } catch {
      throw new Error('USER_JWT_INVALID');
    }

    if (protectedHeader.alg !== 'EdDSA' || typeof protectedHeader.kid !== 'string' || protectedHeader.kid.length === 0) {
      throw new Error('USER_JWT_INVALID');
    }

    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(normalizedToken, jwks, {
        algorithms: ['EdDSA'],
        issuer: config.issuer,
        audience: config.audience,
        requiredClaims: ['sub', 'iss', 'aud', 'iat', 'exp', 'jti'],
      }));
    } catch {
      throw new Error('USER_JWT_INVALID');
    }

    if (
      typeof payload.sub !== 'string' || payload.sub.trim().length === 0 ||
      payload.iss !== config.issuer ||
      (typeof payload.aud !== 'string' && !Array.isArray(payload.aud)) ||
      !payload.aud || (Array.isArray(payload.aud) && !payload.aud.includes(config.audience)) ||
      typeof payload.iat !== 'number' || !Number.isFinite(payload.iat) ||
      typeof payload.exp !== 'number' || !Number.isFinite(payload.exp) ||
      typeof payload.jti !== 'string' || payload.jti.trim().length === 0
    ) {
      throw new Error('USER_JWT_INVALID');
    }

    return {
      id: payload.sub,
      userId: payload.sub,
      accessToken: normalizedToken,
      claims: payload as HuahuoJwtClaims,
    };
  };
};

export const verifyHuahuoUserJwt = createHuahuoJwtVerifier();
