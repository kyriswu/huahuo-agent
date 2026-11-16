export interface StudioLoginConfig {
  enabled: boolean;
  publicPath: string;
  origin?: string;
  agreementVersion: string;
  privacyVersion: string;
}

/** Public browser prefix; internal business API routes remain /api. */
export function agentPublicPath(env: NodeJS.ProcessEnv = process.env): string {
  const path = (env.HUAHUO_AGENT_PUBLIC_PATH?.trim() || '/agent').replace(/\/$/u, '');
  if (!/^\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/u.test(path)) throw new Error('HUAHUO_AGENT_PUBLIC_PATH_INVALID');
  return path;
}

export function loadStudioLoginConfig(env: NodeJS.ProcessEnv = process.env): StudioLoginConfig {
  const value = env.HUAHUO_STUDIO_AUTH_ENABLED?.trim();
  if (value && value !== 'true' && value !== 'false') throw new Error('HUAHUO_STUDIO_AUTH_ENABLED_INVALID');
  const enabled = value === 'true';
  if (enabled && !['development', 'test'].includes(env.APP_ENV ?? '')) {
    throw new Error('STUDIO_PHONE_LOGIN_REQUIRES_TEST_ENVIRONMENT');
  }
  let origin: string | undefined;
  if (env.HUAHUO_STUDIO_ORIGIN?.trim()) {
    const url = new URL(env.HUAHUO_STUDIO_ORIGIN.trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      throw new Error('HUAHUO_STUDIO_ORIGIN_INVALID');
    }
    origin = url.origin;
  }
  return {
    enabled,
    publicPath: agentPublicPath(env),
    origin,
    agreementVersion: env.HUAHUO_STUDIO_AGREEMENT_VERSION?.trim() || '2026-08-20',
    privacyVersion: env.HUAHUO_STUDIO_PRIVACY_VERSION?.trim() || '2026-08-20',
  };
}
