import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import {
  MastraModelGateway,
  type GatewayLanguageModel,
  type ProviderConfig,
} from '@mastra/core/llm';

export const CLIPROXY_DEFAULT_BASE_URL = 'https://cli-proxy-api.devtool.uk/v1';
export const CLIPROXY_DEFAULT_MODEL = 'gpt-6.1-sol';

type Environment = Record<string, string | undefined>;

function getBaseUrl(envVars: Environment = process.env) {
  return envVars.CLIPROXY_BASE_URL?.trim() || CLIPROXY_DEFAULT_BASE_URL;
}

export function getCliProxyModelId(envVars: Environment = process.env) {
  return envVars.CLIPROXY_MODEL?.trim() || CLIPROXY_DEFAULT_MODEL;
}

/**
 * Routes the ChatGPT/OpenAI provider group through the CLIProxy API.
 * Models are addressed as `chatgpt/openai/<model>` in Mastra.
 */
export class ChatGPTOpenAIGateway extends MastraModelGateway {
  readonly id = 'chatgpt';
  readonly name = 'ChatGPT / OpenAI';

  async fetchProviders(): Promise<Record<string, ProviderConfig>> {
    return {
      openai: {
        name: 'OpenAI',
        models: [getCliProxyModelId()],
        apiKeyEnvVar: 'CLIPROXY_API_KEY',
        gateway: this.id,
        url: getBaseUrl(),
      },
    };
  }

  buildUrl(_modelId: string, envVars: Record<string, string>) {
    return getBaseUrl(envVars);
  }

  async getApiKey() {
    const apiKey = process.env.CLIPROXY_API_KEY?.trim();
    if (!apiKey) {
      throw new Error('CLIPROXY_API_KEY is not set');
    }
    return apiKey;
  }

  resolveLanguageModel({
    modelId,
    providerId,
    apiKey,
    headers,
  }: {
    modelId: string;
    providerId: string;
    apiKey: string;
    headers?: Record<string, string>;
  }): GatewayLanguageModel {
    const provider = createOpenAICompatible({
      name: `${this.id}/${providerId}`,
      apiKey,
      baseURL: getBaseUrl(),
      headers,
      supportsStructuredOutputs: true,
    });

    return provider.chatModel(modelId);
  }
}

export const chatgptOpenAIGateway = new ChatGPTOpenAIGateway();
export const chatgptOpenAIModel = `chatgpt/openai/${getCliProxyModelId()}`;
