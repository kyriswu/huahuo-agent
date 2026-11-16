import { readFile, readdir, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { Mastra } from '@mastra/core';
import { MASTRA_RESOURCE_ID_KEY, RequestContext } from '@mastra/core/request-context';
import { validateSkillContent } from '@mastra/core/skills';
import { InMemoryStore } from '@mastra/core/storage';
import { afterEach, describe, expect, it, vi } from 'vitest';

type ChatMessage = {
  role: string;
  content?: unknown;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
};

type ChatRequest = {
  model: string;
  stream?: boolean;
  messages: ChatMessage[];
  tools?: Array<{
    type: string;
    function: { name: string; parameters: Record<string, unknown> };
  }>;
};

function completion(request: ChatRequest, message: ChatMessage, finishReason: string): Response {
  const common = { id: 'positioning-memory-fixture', created: 1, model: request.model };
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

function messageText(messages: ChatMessage[]): string {
  return messages.map(message => typeof message.content === 'string'
    ? message.content
    : JSON.stringify(message.content)).join('\n');
}

function contentLine(text: string): string {
  const line = text.split('\n').find(value => value.trim().length > 25);
  if (!line) throw new Error('Expected a meaningful line in the skill content');
  return line;
}

function userContext(resourceId: string): RequestContext {
  const context = new RequestContext();
  context.set(MASTRA_RESOURCE_ID_KEY, resourceId);
  return context;
}

async function markdownFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? markdownFiles(path) : Promise.resolve(entry.name.endsWith('.md') ? [path] : []);
  }));
  return nested.flat();
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('HuoX positioning skill and user memory', () => {
  it('loads the native skill and references, merges profile fields, and isolates users across threads', async () => {
    const modelBaseUrl = 'http://127.0.0.1:44113/v1';
    vi.stubEnv('APP_ENV', 'test');
    vi.stubEnv('MODEL_PROVIDER', 'cliproxy');
    vi.stubEnv('CLIPROXY_BASE_URL', modelBaseUrl);
    vi.stubEnv('CLIPROXY_API_KEY', 'local-positioning-model-key');
    vi.stubEnv('CLIPROXY_MODEL', 'local-positioning-model');
    vi.stubEnv('MASTRA_MEMORY_GENERATE_TITLE', 'false');

    const skillName = 'an-deep-positioning';
    const referencePath = 'references/mastra-memory.md';
    const alicePositioning = 'ALICE_ONLY_POSITIONING_7e94：真实生活中的母婴知识分享';
    const aliceAudience = '初次育儿的年轻父母';
    const revisedAudience = '正在学习科学育儿的双职工家庭';
    const requests: ChatRequest[] = [];
    const toolCalls: Array<{ name: string; input: unknown }> = [
      { name: 'skill_search', input: { query: '深度定位', skillNames: [skillName], topK: 3 } },
      { name: 'skill', input: { name: skillName } },
      { name: 'skill_read', input: { skillName, path: referencePath } },
      {
        name: 'updateWorkingMemory',
        input: { memory: { positioningReport: { corePositioning: alicePositioning, coreAudience: aliceAudience } } },
      },
    ];

    // These are model responses only. Skill discovery/read tools and memory writes run for real.
    // Every outbound request is intercepted, so this test cannot use cloud storage or a supplier API.
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      if (request.url !== `${modelBaseUrl}/chat/completions`) {
        throw new Error(`Unexpected outbound request in positioning regression: ${request.url}`);
      }
      const body = await request.json() as ChatRequest;
      requests.push(body);
      const call = toolCalls.shift();
      if (!call) return completion(body, { role: 'assistant', content: '定位资料已处理。' }, 'stop');
      return completion(body, {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: `positioning-call-${requests.length}`,
          type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.input) },
        }],
      }, 'tool_calls');
    }));

    const { huoxAgent } = await import('../src/mastra/agents/huox.ts');
    const { chatgptOpenAIGateway } = await import('../src/mastra/gateways/chatgpt-openai-gateway.ts');
    const storage = new InMemoryStore({ id: 'positioning-memory-regression' });
    const mastra = new Mastra({
      agents: { huoxAgent },
      gateways: { chatgptOpenAI: chatgptOpenAIGateway },
      storage,
      logger: false,
    });

    try {
      const skill = await huoxAgent.getSkill(skillName);
      expect(skill).not.toBeNull();
      if (!skill) throw new Error('The positioning skill must be configured on HuoX');
      const reference = await readFile(join(skill.path, referencePath), 'utf8');
      const chineseAsset = skill.assets.find(path => /\p{Script=Han}/u.test(path));
      expect(chineseAsset).toBeDefined();
      const assetPath = `assets/${chineseAsset}`;
      const asset = await readFile(join(skill.path, assetPath), 'utf8');
      toolCalls.splice(3, 0, { name: 'skill_read', input: { skillName, path: assetPath } });

      const first = await huoxAgent.generate('请做深度定位，并保存我确认的定位结论。', {
        memory: { thread: 'positioning-alice-one', resource: 'positioning-alice' },
        requestContext: userContext('positioning-alice'),
        maxSteps: 7,
        modelSettings: { maxRetries: 0 },
      });
      expect(first.text).toBe('定位资料已处理。');
      expect(toolCalls).toHaveLength(0);
      expect(requests).toHaveLength(6);
      expect(requests[0].tools?.map(tool => tool.function.name)).toEqual(expect.arrayContaining([
        'skill_search', 'skill', 'skill_read', 'updateWorkingMemory',
      ]));
      expect(messageText(requests[1].messages)).toContain(`[${skillName}]`);
      expect(messageText(requests[2].messages)).toContain(contentLine(skill.instructions));
      expect(messageText(requests[3].messages)).toContain(contentLine(reference));
      expect(messageText(requests[4].messages)).toContain(contentLine(asset));
      expect(requests[0].tools?.find(tool => tool.function.name === 'updateWorkingMemory')?.function.parameters)
        .toMatchObject({ type: 'object', properties: { memory: { type: 'object' } }, required: ['memory'] });

      const memory = await huoxAgent.getMemory();
      if (!memory) throw new Error('HuoX memory must be configured');
      const memoryStore = await storage.getStore('memory');
      if (!memoryStore) throw new Error('The isolated memory store must be available');
      const firstResource = await memoryStore.getResourceById({ resourceId: 'positioning-alice' });
      expect(JSON.parse(firstResource?.workingMemory ?? '{}')).toMatchObject({
        positioningReport: { corePositioning: alicePositioning, coreAudience: aliceAudience },
      });

      toolCalls.push({
        name: 'updateWorkingMemory',
        input: { memory: { positioningReport: { coreAudience: revisedAudience } } },
      });
      await huoxAgent.generate('只修改核心受众，保留已经确认的核心定位。', {
        memory: { thread: 'positioning-alice-one', resource: 'positioning-alice' },
        requestContext: userContext('positioning-alice'),
        maxSteps: 3,
        modelSettings: { maxRetries: 0 },
      });
      expect(toolCalls).toHaveLength(0);
      const revisedResource = await memoryStore.getResourceById({ resourceId: 'positioning-alice' });
      expect(JSON.parse(revisedResource?.workingMemory ?? '{}')).toMatchObject({
        positioningReport: { corePositioning: alicePositioning, coreAudience: revisedAudience },
      });

      await huoxAgent.generate('这是新聊天，请使用我已有的定位。', {
        memory: { thread: 'positioning-alice-two', resource: 'positioning-alice' },
        requestContext: userContext('positioning-alice'),
        maxSteps: 1,
        modelSettings: { maxRetries: 0 },
      });
      expect(messageText(requests.at(-1)!.messages)).toContain(alicePositioning);
      expect(messageText(requests.at(-1)!.messages)).toContain(revisedAudience);

      await huoxAgent.generate('这是另一位用户的新聊天。', {
        memory: { thread: 'positioning-bob-one', resource: 'positioning-bob' },
        requestContext: userContext('positioning-bob'),
        maxSteps: 1,
        modelSettings: { maxRetries: 0 },
      });
      expect(messageText(requests.at(-1)!.messages)).not.toContain(alicePositioning);
      expect(messageText(requests.at(-1)!.messages)).not.toContain(revisedAudience);
      expect(await memoryStore.getResourceById({ resourceId: 'positioning-bob' })).toBeNull();

      // The native tool above uses its fallback merge path. In-memory results are not evidence
      // that PostgreSQL's row-locked, cross-process atomic merge has been exercised.
      expect(await memory.supportsAtomicWorkingMemoryMerge()).toBe(false);

      // Exercise the framework's actual HTTP route handler without opening a socket or bypassing
      // ownership checks. Resolve it through the installed CLI's dependency, not an application shim.
      const require = createRequire(import.meta.url);
      const routePath = require.resolve('@mastra/server/handlers/memory', { paths: [require.resolve('mastra')] });
      const { UPDATE_WORKING_MEMORY_ROUTE } = require(routePath) as {
        UPDATE_WORKING_MEMORY_ROUTE: { handler(input: {
          mastra: Mastra;
          agentId: string;
          threadId: string;
          resourceId: string;
          requestContext: RequestContext;
          workingMemory: string;
          mode: 'merge' | 'replace';
        }): Promise<{ success: boolean }> };
      };
      const routeParams = {
        mastra,
        agentId: huoxAgent.id,
        threadId: 'positioning-alice-one',
        resourceId: 'positioning-alice',
        requestContext: userContext('positioning-alice'),
      };
      const modelCallsBeforeApi = requests.length;
      const originalMemory = (await memoryStore.getResourceById({ resourceId: 'positioning-alice' }))!.workingMemory;
      await expect(UPDATE_WORKING_MEMORY_ROUTE.handler({
        ...routeParams,
        requestContext: userContext('positioning-bob'),
        // A caller-supplied Alice resourceId must not override Bob's trusted context.
        workingMemory: JSON.stringify({ positioningReport: { corePositioning: 'forged Bob update' } }),
        mode: 'replace',
      })).rejects.toMatchObject({ status: 403 });
      expect((await memoryStore.getResourceById({ resourceId: 'positioning-alice' }))!.workingMemory)
        .toBe(originalMemory);

      await expect(UPDATE_WORKING_MEMORY_ROUTE.handler({
        ...routeParams,
        workingMemory: JSON.stringify({ positioningReport: { coreAudience: 'unsupported atomic patch' } }),
        mode: 'merge',
      })).rejects.toMatchObject({ status: 400 });

      const replacement = { positioningReport: { corePositioning: alicePositioning, coreAudience: '业务 API 更新的受众' } };
      await expect(UPDATE_WORKING_MEMORY_ROUTE.handler({
        ...routeParams,
        workingMemory: JSON.stringify(replacement),
        mode: 'replace',
      })).resolves.toEqual({ success: true });
      expect(JSON.parse((await memoryStore.getResourceById({ resourceId: 'positioning-alice' }))!.workingMemory!))
        .toEqual(replacement);
      expect(requests).toHaveLength(modelCallsBeforeApi);
    } finally {
      await mastra.shutdown();
    }
  }, 20_000);

  it('supports partial positioning updates without admitting unrelated memory fields', async () => {
    const { huoxWorkingMemorySchema } = await import('../src/mastra/memory/positioning-schema.ts');
    expect(huoxWorkingMemorySchema.safeParse({
      positioningReport: { coreAudience: '用户已确认的新受众' },
    }).success).toBe(true);

    const unrelated = huoxWorkingMemorySchema.safeParse({ learningSummary: 'unrelated report' });
    if (unrelated.success) expect(unrelated.data).not.toHaveProperty('learningSummary');
    else expect(unrelated.error.issues.length).toBeGreaterThan(0);
  });

  it('discovers valid skill content and resolves every local Markdown link', async () => {
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Skill file checks must not make network requests'); }));
    const { huoxAgent } = await import('../src/mastra/agents/huox.ts');
    const skills = await huoxAgent.listSkills();
    expect(skills.map(skill => skill.name)).toContain('an-deep-positioning');
    const skill = await huoxAgent.getSkill('an-deep-positioning');
    if (!skill) throw new Error('The positioning skill must be discoverable');
    const root = resolve(skill.path);
    const main = await readFile(join(root, 'SKILL.md'), 'utf8');
    expect(validateSkillContent({ content: main, directoryName: basename(root) }).valid).toBe(true);
    await expect(stat(join(root, '使用说明.md'))).resolves.toMatchObject({});

    for (const markdown of await markdownFiles(root)) {
      const source = await readFile(markdown, 'utf8');
      for (const link of source.matchAll(/\[[^\]]*\]\((?:<([^>]+)>|([^\s)]+))(?:\s+"[^"]*")?\)/g)) {
        const target = link[1] ?? link[2];
        if (!target || target.startsWith('#') || /^(?:[a-z][a-z\d+.-]*:|\/\/)/iu.test(target)) continue;
        const path = decodeURIComponent(target.split(/[?#]/u)[0]);
        if (!path) continue;
        const destination = resolve(dirname(markdown), path);
        expect(relative(root, destination), `Skill link escapes its package: ${relative(root, markdown)} -> ${target}`)
          .not.toMatch(/^\.\.(?:[/\\]|$)/u);
        expect((await stat(destination)).isFile(), `Missing skill reference: ${relative(root, markdown)} -> ${target}`)
          .toBe(true);
      }
    }
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
