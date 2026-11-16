// Local assertions only; no network, database, filesystem writes or secret output.
const env = process.env;
const required = ['MASTRA_POSTGRES_PASSWORD', 'DEEPSEEK_API_KEY', 'HUAHUO_SERVER_BASE_URL',
  'APP_JWT_JWKS_URL', 'APP_JWT_ISSUER', 'APP_JWT_AUDIENCE'];
const keys = ['HUAHUO_SERVER_TO_AGENT_API_KEY', 'HUAHUO_AGENT_TO_SERVER_API_KEY'];
if (env.APP_ENV !== 'test' || env.HUAHUO_STUDIO_AUTH_ENABLED !== 'true'
  || (env.MODEL_PROVIDER ?? 'deepseek') !== 'deepseek'
  || required.some(key => !env[key]?.trim()) || keys.some(key => (env[key]?.trim().length ?? 0) < 43)
  || env[keys[0]] === env[keys[1]]) process.exitCode = 1;
