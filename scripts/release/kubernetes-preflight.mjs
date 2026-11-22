import { pathToFileURL } from 'node:url';
import { serverPreflight } from './server-preflight.mjs';

export async function kubernetesPreflight(env = process.env, fetchImpl = fetch) {
  if (!['test', 'production'].includes(env.APP_ENV)) throw Error('AGENT_K8S_ENV_INVALID');
  if (env.MASTRA_DISABLE_STORAGE_INIT === 'true') throw Error('AGENT_K8S_STORAGE_INIT_DISABLED');

  const required = [
    'MASTRA_POSTGRES_HOST',
    'MASTRA_POSTGRES_DATABASE',
    'MASTRA_POSTGRES_USER',
    'MASTRA_POSTGRES_PASSWORD',
    'HUAHUO_SERVER_BASE_URL',
  ];
  for (const key of required) {
    if (!env[key]?.trim()) throw Error(`AGENT_K8S_ENV_MISSING: ${key}`);
  }
  return serverPreflight(env.HUAHUO_SERVER_BASE_URL, fetchImpl);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    console.log(JSON.stringify(await kubernetesPreflight()));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
