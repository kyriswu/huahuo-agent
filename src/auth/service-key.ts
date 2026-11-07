import { timingSafeEqual } from 'node:crypto';
import { resolveHuahuoServerBaseUrl } from '../server/base-url.js';

export const serviceKeyHeader = 'x-huahuo-service-key';

const equalSecret = (left: string, right: string): boolean => {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
};

export const getConfiguredServerToAgentServiceKey = (env: NodeJS.ProcessEnv = process.env): string => {
  const value = env.HUAHUO_SERVER_TO_AGENT_API_KEY?.trim() ?? '';
  if (!value) throw new Error('AGENT_SERVICE_NOT_CONFIGURED');
  return value;
};

export const verifyServerToAgentServiceKey = (
  presented: string | undefined,
  configured = getConfiguredServerToAgentServiceKey(),
): void => {
  if (!presented || !equalSecret(presented.trim(), configured)) throw new Error('AGENT_SERVICE_UNAUTHORIZED');
};

export const validateAgentServiceAuthConfig = (env: NodeJS.ProcessEnv = process.env): void => {
  const serverToAgent = env.HUAHUO_SERVER_TO_AGENT_API_KEY?.trim() ?? '';
  const agentToServer = env.HUAHUO_AGENT_TO_SERVER_API_KEY?.trim() ?? '';
  if (env.APP_ENV === 'production' && (serverToAgent.length < 43 || agentToServer.length < 43)) {
    throw new Error('AGENT_SERVICE_AUTH_CONFIG_REQUIRED');
  }
  if (env.APP_ENV === 'production' && serverToAgent && agentToServer && serverToAgent === agentToServer) {
    throw new Error('AGENT_SERVICE_AUTH_CONFIG_IDENTICAL_KEYS');
  }
  if (env.APP_ENV === 'production') resolveHuahuoServerBaseUrl(undefined, env);
};
