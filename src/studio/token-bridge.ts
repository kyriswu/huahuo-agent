import type { StudioTokens } from './identity-client.js';

export const STUDIO_ACCESS_COOKIE = 'huahuo-studio-access';
export const STUDIO_REFRESH_COOKIE = 'huahuo-studio-refresh';

/** Login writes Server-issued tokens. Verification/refresh belongs to ForwardAuth. */
export function tokenCookies(tokens: StudioTokens | undefined, secure: boolean, publicPath = '/agent'): string[] {
  const options = `; Path=${publicPath}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
  const accessAge = tokens ? Math.max(0, Math.floor((Date.parse(tokens.accessTokenExpiresAt) - Date.now()) / 1_000)) : 0;
  const result = [
    `${STUDIO_ACCESS_COOKIE}=${encodeURIComponent(tokens?.accessToken ?? '')}${options}; Max-Age=${accessAge}`,
    `${STUDIO_REFRESH_COOKIE}=${encodeURIComponent(tokens?.refreshToken ?? '')}${options}; Max-Age=${tokens ? 30 * 24 * 60 * 60 : 0}`,
  ];
  // Remove cookies issued by the former root-hosted Studio during migration.
  for (const name of [STUDIO_ACCESS_COOKIE, STUDIO_REFRESH_COOKIE]) {
    result.push(`${name}=; Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}; Max-Age=0`);
  }
  return result;
}
