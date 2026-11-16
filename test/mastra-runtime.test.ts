import { Mastra } from '@mastra/core';
import { MastraEditor } from '@mastra/editor';
import { RequestContext } from '@mastra/core/request-context';
import { InMemoryStore } from '@mastra/core/storage';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyTrustedIdentity, readTrustedIdentity } from '../src/auth/trusted-identity.js';

type ChatMessage = {
  role: string;
  content?: unknown;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
};

type ChatRequest = {
  model: string;
  stream?: boolean;
  messages: ChatMessage[];
  tools?: Array<{ type: string; function: { name: string } }>;
};

function chatResponse(request: ChatRequest, message: ChatMessage, finishReason: string): Response {
  const common = { id: 'local-completion', created: 1, model: request.model };
  if (!request.stream) {
    return Response.json({
      ...common,
      object: 'chat.completion',
      choices: [{ index: 0, message, finish_reason: finishReason }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
  }

  const delta = {
    ...message,
    ...(message.tool_calls ? { tool_calls: message.tool_calls.map((call, index) => ({ ...call, index })) } : {}),
  };
  const chunks = [
    { ...common, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: null }] },
    {
      ...common,
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    },
  ];
  return new Response(`${chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`, {
    headers: { 'content-type': 'text/event-stream' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('Mastra runtime compatibility', () => {
  it('runs HuoX through the custom gateway and RAG tool, and recalls persisted conversation history', async () => {
    const modelBaseUrl = 'http://127.0.0.1:44111/v1';
    const serverBaseUrl = 'http://127.0.0.1:44112';
    vi.stubEnv('APP_ENV', 'test');
    vi.stubEnv('MODEL_PROVIDER', 'cliproxy');
    vi.stubEnv('CLIPROXY_BASE_URL', modelBaseUrl);
    vi.stubEnv('CLIPROXY_API_KEY', 'local-model-key');
    vi.stubEnv('CLIPROXY_MODEL', 'local-runtime-model');
    vi.stubEnv('HUAHUO_SERVER_BASE_URL', serverBaseUrl);
    vi.stubEnv('MASTRA_MEMORY_GENERATE_TITLE', 'false');

    const modelRequests: Array<{ headers: Headers; body: ChatRequest }> = [];
    const ragRequests: Array<{ headers: Headers; body: unknown; signal: AbortSignal }> = [];
    const evidence = { evidence: [{ id: 'upgrade-doc', text: 'Mastra upgrade evidence from the local fixture.' }] };
    const answer = 'The local knowledge evidence confirms the upgrade.';

    // Every outbound request is intercepted; unknown destinations fail without using the network.
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      if (request.url === `${modelBaseUrl}/chat/completions`) {
        const body = await request.json() as ChatRequest;
        modelRequests.push({ headers: request.headers, body });
        const toolAlreadyReturned = body.messages.some(message => message.role === 'tool');
        if (toolAlreadyReturned) return chatResponse(body, { role: 'assistant', content: answer }, 'stop');
        return chatResponse(body, {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'rag-call',
            type: 'function',
            function: { name: 'huahuoRagQueryTool', arguments: JSON.stringify({ query: 'Mastra upgrade' }) },
          }],
        }, 'tool_calls');
      }
      if (request.url === `${serverBaseUrl}/internal/v1/rag/query`) {
        ragRequests.push({ headers: request.headers, body: await request.json(), signal: request.signal });
        return Response.json(evidence);
      }
      throw new Error(`Unexpected outbound request in runtime regression: ${request.url}`);
    }));

    const { huoxAgent } = await import('../src/mastra/agents/huox.ts');
    const { chatgptOpenAIGateway } = await import('../src/mastra/gateways/chatgpt-openai-gateway.ts');
    const storage = new InMemoryStore({ id: 'runtime-regression' });
    const mastra = new Mastra({
      agents: { huoxAgent },
      editor: new MastraEditor(),
      gateways: { chatgptOpenAI: chatgptOpenAIGateway },
      storage,
      logger: false,
    });

    try {
      const requestContext = new RequestContext();
      const userId = 'a0000000-0000-4000-8000-000000000001';
      const sessionId = 'b0000000-0000-4000-8000-000000000002';
      applyTrustedIdentity(requestContext, readTrustedIdentity({
        'x-huahuo-user-id': userId, 'x-huahuo-session-id': sessionId,
        'x-huahuo-auth-method': 'bearer', 'x-trace-id': 'runtime-regression',
      }));
      const memory = { thread: 'upgrade-thread', resource: userId };
      const firstPrompt = 'Find the evidence for the Mastra upgrade.';
      const result = await huoxAgent.generate(firstPrompt, {
        requestContext,
        memory,
        maxSteps: 3,
        modelSettings: { maxRetries: 0 },
      });

      expect(result.text).toBe(answer);
      expect(modelRequests).toHaveLength(2);
      expect(modelRequests[0].headers.get('authorization')).toBe('Bearer local-model-key');
      expect(modelRequests[0].body.model).toBe('local-runtime-model');
      expect(modelRequests[0].body.tools?.some(tool => tool.function.name === 'huahuoRagQueryTool')).toBe(true);
      expect(JSON.stringify(modelRequests[1].body.messages)).toContain('upgrade-doc');
      expect(ragRequests).toHaveLength(1);
      expect(ragRequests[0].headers.get('authorization')).toBeNull();
      expect(ragRequests[0].headers.get('x-huahuo-service-key')).toBeNull();
      expect(ragRequests[0].headers.get('x-huahuo-user-id')).toBe(userId);
      expect(ragRequests[0].headers.get('x-huahuo-session-id')).toBe(sessionId);
      expect(ragRequests[0].body).toEqual({ query: 'Mastra upgrade', mode: 'hybrid', topK: 10 });
      expect(ragRequests[0].signal.aborted).toBe(false);

      const agentMemory = await huoxAgent.getMemory();
      expect(agentMemory).toBeDefined();
      expect(await agentMemory!.getThreadById({ threadId: memory.thread }))
        .toMatchObject({ id: memory.thread, resourceId: memory.resource });
      const recalled = await agentMemory!.recall({ threadId: memory.thread, resourceId: memory.resource, perPage: false });
      expect(recalled.messages.some(message => message.role === 'user')).toBe(true);
      expect(JSON.stringify(recalled.messages)).toContain(answer);

      const followup = await huoxAgent.generate('What evidence did you just find?', {
        requestContext,
        memory,
        maxSteps: 1,
        modelSettings: { maxRetries: 0 },
      });
      expect(followup.text).toBe(answer);
      expect(modelRequests).toHaveLength(3);
      expect(JSON.stringify(modelRequests[2].body.messages)).toContain(firstPrompt);
      expect(JSON.stringify(modelRequests[2].body.messages)).toContain(answer);
      expect(ragRequests).toHaveLength(1);
    } finally {
      await mastra.shutdown();
    }
  }, 20_000);

  it('runs HuoX through Search, Fetch, and a final answer across a complete tool-call loop', async () => {
    const modelBaseUrl = 'http://127.0.0.1:44111/v1';
    vi.stubEnv('APP_ENV', 'test');
    vi.stubEnv('MODEL_PROVIDER', 'cliproxy');
    vi.stubEnv('CLIPROXY_BASE_URL', modelBaseUrl);
    vi.stubEnv('CLIPROXY_API_KEY', 'local-model-key');
    vi.stubEnv('CLIPROXY_MODEL', 'local-runtime-model');
    vi.stubEnv('DEEPSEEK_API_KEY', 'local-web-key');
    vi.stubEnv('MASTRA_MEMORY_GENERATE_TITLE', 'false');
    const modelRequests: ChatRequest[] = [];
    const webRequests: Array<{ url: string; body: unknown; authorization: string | null }> = [];
    const sourceUrl = 'https://example.org/source';
    const page = { title: 'Web evidence', content: '# Evidence\n\nSearch and Fetch can be reused by project agents.' };

    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      if (request.url === `${modelBaseUrl}/chat/completions`) {
        const body = await request.json() as ChatRequest;
        modelRequests.push(body);
        const toolMessages = body.messages.filter(message => message.role === 'tool');
        if (toolMessages.length >= 2) return chatResponse(body, { role: 'assistant', content: `The evidence is at ${sourceUrl}.` }, 'stop');
        const search = toolMessages.length === 0;
        return chatResponse(body, {
          role: 'assistant', content: null,
          tool_calls: [{
            id: search ? 'search-call' : 'fetch-call', type: 'function',
            function: {
              name: search ? 'onlineSearch' : 'urlFetch',
              arguments: JSON.stringify(search ? { query: 'Reusable Mastra tools', count: 1 } : { url: sourceUrl }),
            },
          }],
        }, 'tool_calls');
      }
      if (request.url.startsWith('https://api.deepseek.com/v1/tools/')) {
        webRequests.push({ url: request.url, body: await request.json(), authorization: request.headers.get('authorization') });
        return request.url.endsWith('/fetch') ? Response.json(page) : Response.json({ results: [{
          rerank_score: 2.8, title: page.title, url: sourceUrl, snippet: 'Reusable tools', summary: 'Read this source.',
          content: '', site_name: 'Example', site_icon: null, date: null, authority: 3,
        }] });
      }
      throw new Error(`Unexpected outbound request in web-tool regression: ${request.url}`);
    }));

    const { huoxAgent } = await import('../src/mastra/agents/huox.ts');
    const { chatgptOpenAIGateway } = await import('../src/mastra/gateways/chatgpt-openai-gateway.ts');
    const mastra = new Mastra({
      agents: { huoxAgent },
      gateways: { chatgptOpenAI: chatgptOpenAIGateway },
      storage: new InMemoryStore({ id: 'huox-web-regression' }),
      logger: false,
    });
    try {
      const result = await huoxAgent.generate('Find and read evidence.', {
        memory: { thread: 'web-thread', resource: 'web-user' },
        maxSteps: 3,
        modelSettings: { maxRetries: 0 },
      });
      expect(result.text).toContain(sourceUrl);
      expect(modelRequests).toHaveLength(3);
      expect(modelRequests[0].tools?.map(tool => tool.function.name)).toEqual(expect.arrayContaining([
        'huahuoRagQueryTool', 'onlineSearch', 'urlFetch',
      ]));
      expect(JSON.stringify(modelRequests[2].messages)).toContain('Search and Fetch can be reused');
      expect(webRequests).toEqual([
        { url: 'https://api.deepseek.com/v1/tools/search', body: { query: 'Reusable Mastra tools', count: 1, localization: '', need_content: false }, authorization: 'Bearer local-web-key' },
        { url: 'https://api.deepseek.com/v1/tools/fetch', body: { url: sourceUrl }, authorization: 'Bearer local-web-key' },
      ]);
      expect(Object.keys(mastra.listMCPServers() ?? {})).toEqual([]);
    } finally {
      await mastra.shutdown();
    }
  }, 20_000);

  it('runs the existing deterministic weather workflow without a model or database', async () => {
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('The weather workflow must not make network requests'); }));
    const { weatherWorkflow } = await import('../src/mastra/workflows/weather-workflow.ts');
    const mastra = new Mastra({
      workflows: { weatherWorkflow },
      storage: new InMemoryStore({ id: 'weather-regression' }),
      logger: false,
    });
    try {
      const run = await weatherWorkflow.createRun();
      const result = await run.start({ inputData: { city: 'Shanghai' } });
      expect(result.status).toBe('success');
      if (result.status !== 'success') throw new Error(`Unexpected workflow status: ${result.status}`);
      expect(result.result).toEqual({ message: 'The example forecast for Shanghai is sunny and 21°C.' });
      expect(globalThis.fetch).not.toHaveBeenCalled();
    } finally {
      await mastra.shutdown();
    }
  });
});
