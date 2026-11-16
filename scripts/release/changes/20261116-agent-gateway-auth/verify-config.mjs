// Local assertions only: no secret output, network or persistent writes.
const env = process.env;
const path = env.HUAHUO_AGENT_PUBLIC_PATH?.trim();
let valid = !!path && /^\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/u.test(path);
try {
  const server = new URL(env.HUAHUO_SERVER_BASE_URL ?? '');
  valid &&= ['http:', 'https:'].includes(server.protocol) && !server.username && !server.password && server.pathname === '/' && !server.search && !server.hash;
  if (env.HUAHUO_STUDIO_AUTH_ENABLED === 'true') {
    const origin = new URL(env.HUAHUO_STUDIO_ORIGIN ?? '');
    valid &&= ['development', 'test'].includes(env.APP_ENV ?? '') && ['http:', 'https:'].includes(origin.protocol) && !origin.username && !origin.password && origin.pathname === '/' && !origin.search && !origin.hash;
  }
} catch { valid = false; }
if (!valid) process.exitCode = 1;
