const localHosts = new Set(['localhost', '127.0.0.1', '[::1]']);

export function resolveHuahuoServerBaseUrl(
  explicitUrl?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const raw = explicitUrl?.trim() || env.HUAHUO_SERVER_BASE_URL?.trim();
  if (!raw) {
    if (env.APP_ENV === 'production') throw new Error('HUAHUO_SERVER_BASE_URL_REQUIRED');
    return 'http://localhost:3000';
  }

  let parsed: URL;
  try {
    parsed = new URL(raw.replace(/\/+$/, ''));
  } catch {
    throw new Error('HUAHUO_SERVER_BASE_URL_INVALID');
  }

  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error('HUAHUO_SERVER_BASE_URL_INVALID');
  }
  if (env.APP_ENV === 'production' && localHosts.has(parsed.hostname.toLowerCase())) {
    throw new Error('HUAHUO_SERVER_BASE_URL_PRODUCTION_INVALID');
  }

  return raw.replace(/\/+$/, '');
}
