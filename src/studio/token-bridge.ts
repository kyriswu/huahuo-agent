import { createHash } from 'node:crypto';
import type { AuthenticatedHuahuoUser } from '../auth/jwt.js';
import { verifyHuahuoUserJwt } from '../auth/jwt.js';
import { StudioIdentityClient, StudioLoginError, type StudioTokens } from './identity-client.js';

export const STUDIO_ACCESS_COOKIE = 'huahuo-studio-access';
export const STUDIO_REFRESH_COOKIE = 'huahuo-studio-refresh';

export function cookieValue(header: string | undefined, name: string): string | undefined {
  const value = header?.split(';').map(part => part.trim()).find(part => part.startsWith(`${name}=`))?.slice(name.length + 1);
  if (!value || value.length > 12_000) return undefined;
  try { return decodeURIComponent(value); } catch { return undefined; }
}

export function tokenCookies(tokens: StudioTokens | undefined, secure: boolean, expiresAt = 0): string[] {
  const options = `; Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
  return [
    `${STUDIO_ACCESS_COOKIE}=${encodeURIComponent(tokens?.accessToken ?? '')}${options}; Max-Age=${tokens ? Math.max(1, Math.floor(expiresAt - Date.now() / 1_000)) : 0}`,
    `${STUDIO_REFRESH_COOKIE}=${encodeURIComponent(tokens?.refreshToken ?? '')}${options}; Max-Age=${tokens ? 30 * 24 * 60 * 60 : 0}`,
  ];
}

/** Only deduplicates concurrent refreshes; the Server remains the session/token authority. */
export class StudioTokenBridge {
  private readonly refreshes = new Map<string, { expiresAt: number; result: Promise<{ principal: AuthenticatedHuahuoUser; tokens: StudioTokens }> }>();

  constructor(
    private readonly identity: Pick<StudioIdentityClient, 'refresh'>,
    private readonly verify = verifyHuahuoUserJwt,
  ) {}

  async authenticate(authorization?: string, cookies?: string) {
    if (authorization !== undefined) {
      const match = /^Bearer\s+(\S+)$/iu.exec(authorization);
      if (!match) throw new StudioLoginError('USER_JWT_INVALID');
      return { principal: await this.verify(match[1]) };
    }
    const token = cookieValue(cookies, STUDIO_ACCESS_COOKIE);
    const refreshToken = cookieValue(cookies, STUDIO_REFRESH_COOKIE);
    if (token) {
      try {
        const principal = await this.verify(token);
        if (!refreshToken || principal.claims.exp * 1_000 - Date.now() > 45_000) return { principal };
      } catch { /* Refresh expired access tokens through the existing Server endpoint. */ }
    }
    if (!refreshToken) throw new StudioLoginError('STUDIO_LOGIN_REQUIRED');
    const key = createHash('sha256').update(refreshToken).digest('hex');
    for (const [id, item] of this.refreshes) if (item.expiresAt <= Date.now()) this.refreshes.delete(id);
    const pending = this.refreshes.get(key);
    if (pending) return pending.result;
    const result = (async () => {
      try {
        const tokens = await this.identity.refresh(refreshToken);
        return { tokens, principal: await this.verify(tokens.accessToken) };
      } catch { throw new StudioLoginError('STUDIO_LOGIN_EXPIRED'); }
    })();
    this.refreshes.set(key, { expiresAt: Date.now() + 60_000, result });
    return result;
  }

  clear(cookies?: string): void {
    const refresh = cookieValue(cookies, STUDIO_REFRESH_COOKIE);
    if (refresh) this.refreshes.delete(createHash('sha256').update(refresh).digest('hex'));
  }
}
