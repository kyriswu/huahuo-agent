// Local assertions only: no secret output, network or persistent writes.
const env = process.env;
const appEnv = env.APP_ENV;
const studioEnabled = env.HUAHUO_STUDIO_AUTH_ENABLED?.trim();
const localHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
let valid = ['development', 'test', 'production'].includes(appEnv)
  && env.HUAHUO_AGENT_PUBLIC_PATH?.trim() === '/agent'
  && ['true', 'false'].includes(studioEnabled)
  && !(appEnv === 'production' && studioEnabled === 'true');

function origin(value, normalizeTrailingSlashes = false) {
  const raw = value?.trim() ?? '';
  const url = new URL(normalizeTrailingSlashes ? raw.replace(/\/+$/, '') : raw);
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw Error('INVALID_ORIGIN');
  return url;
}

try {
  const server = origin(env.HUAHUO_SERVER_BASE_URL, true);
  valid &&= !(appEnv === 'production' && localHosts.has(server.hostname.toLowerCase()));
  // This release moves test Studio to the API origin. URL syntax alone would
  // still accept the old Agent origin, causing same-origin login to fail.
  const studio = origin(env.HUAHUO_STUDIO_ORIGIN);
  if (appEnv === 'test') valid &&= studioEnabled === 'true' && studio.origin === 'https://test-api.chuda.cc';
} catch { valid = false; }
if (!valid) process.exitCode = 1;
