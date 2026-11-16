import { getCliProxyModelId } from './gateways/chatgpt-openai-gateway.ts';

export const OPENAI_DEFAULT_MODEL = 'gpt-6.1-sol';
export const DEEPSEEK_DEFAULT_MODEL = 'deepseek-v4-flash';

/** Keep each provider's credentials separate and use DeepSeek for ordinary Agent runs. */
export function resolveAgentModel(env: Record<string, string | undefined> = process.env): string {
  const provider = env.MODEL_PROVIDER?.trim() || 'deepseek';
  if (provider === 'deepseek') return `deepseek/${env.DEEPSEEK_MODEL?.trim() || DEEPSEEK_DEFAULT_MODEL}`;
  if (provider === 'openai') return `openai/${env.OPENAI_MODEL?.trim() || OPENAI_DEFAULT_MODEL}`;
  if (provider === 'cliproxy') return `chatgpt/openai/${getCliProxyModelId(env)}`;
  throw new Error('MODEL_PROVIDER must be deepseek, openai, or cliproxy');
}

export const agentModel = resolveAgentModel();
