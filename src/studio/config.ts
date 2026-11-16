export interface StudioLoginConfig {
  enabled: boolean;
  origin?: string;
  agreementVersion: string;
  privacyVersion: string;
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
    origin,
    agreementVersion: env.HUAHUO_STUDIO_AGREEMENT_VERSION?.trim() || '2026-08-20',
    privacyVersion: env.HUAHUO_STUDIO_PRIVACY_VERSION?.trim() || '2026-08-20',
  };
}
