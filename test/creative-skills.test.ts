import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { Mastra } from '@mastra/core';
import { MASTRA_RESOURCE_ID_KEY, RequestContext } from '@mastra/core/request-context';
import { validateSkillContent } from '@mastra/core/skills';
import { InMemoryStore } from '@mastra/core/storage';
import { afterEach, describe, expect, it, vi } from 'vitest';

const creativeSkills = [
  {
    name: 'an-opening-design',
    title: '开头处理',
    method: 'references/开头处理方法.md',
    references: ['audience-context.md', 'full-workflow-handoff.md', '开头执行规则.md', '开头处理方法.md'],
  },
  {
    name: 'an-content-uplift',
    title: '内容升华',
    method: 'references/rational-uplift.md',
    references: ['audience-context.md', 'student-context.md', 'rational-uplift.md', 'emotional-lines.md', 'sources.md'],
  },
  {
    name: 'an-situation-design',
    title: '情境设计',
    method: 'references/four-situations.md',
    references: ['情境设计方法.md', 'student-project.md', 'situation-card.md', 'four-situations.md',
      'language-style-handoff.md', 'validation.md', 'sources.md', 'profile-updates.md', 'positioning-report-views.md'],
  },
  {
    name: 'an-prop-design',
    title: '道具设计',
    method: 'references/道具设计方法.md',
    references: ['audience-context.md', '道具设计方法.md'],
  },
] as const;

// Digests of professional methodology from the supplied package, before migration.
// Runtime adapters are deliberately excluded. This guards against losing or shortening
// the source methods; it is not evidence that an LLM follows them or produces good copy.
const sourceMethodDigests = [
  ['an-opening-design', 'references/开头处理方法.md', '2629181752c7f3a923dcb69297ae1addf73dd6dfcb5481ace654114020a6e811'],
  ['an-opening-design', 'references/开头执行规则.md', '75423db97a281a25bc7839636b2fb3c9adad31896f96bb707d7b22f260a963e1'],
  ['an-opening-design', 'references/full-workflow-handoff.md', '46f7c05f42267607576aaa378a3aaa5595c096c296b2b53ffe9926c8c9f91975'],
  ['an-content-uplift', 'references/rational-uplift.md', 'e91e0c87a4f85c1a9cbc2402fd9eada5313b1d5c31e9343fb6fe336fb887eee0'],
  ['an-content-uplift', 'references/emotional-lines.md', 'bb1045ee603c2f2880139345651419b9e242e98138b7d7c48284e9adb71ba735'],
  ['an-content-uplift', '示例.md', '32c8f40423c452a3e86f2e2e8ca64753107e1eb52a20cc2e291c90ebfd4b3aba'],
  ['an-situation-design', 'references/situation-card.md', '1543111a6c17e138fbe3a9e44ee20c32912c9251a66bcec0017f0a6acb97b3ab'],
  ['an-prop-design', 'references/道具设计方法.md', 'ec271a809ddd230e2c904eecca59c26c948fc8cceec3337337254d67cdaee19c'],
] as const;

type ChatMessage = { role: string; content?: unknown; tool_calls?: unknown[] };
type ChatRequest = {
  model: string;
  stream?: boolean;
  messages: ChatMessage[];
  tools?: Array<{ function: { name: string } }>;
};
type ModelToolCall = { name: string; input: unknown };

function completion(request: ChatRequest, call: ModelToolCall | undefined, sequence: number): Response {
  const common = { id: `creative-skill-fixture-${sequence}`, created: 1, model: request.model };
  const message = call ? {
    role: 'assistant',
    content: null,
    tool_calls: [{
      id: `creative-call-${sequence}`,
      type: 'function',
      function: { name: call.name, arguments: JSON.stringify(call.input) },
    }],
  } : { role: 'assistant', content: '创作工具接入测试完成。' };
  const finishReason = call ? 'tool_calls' : 'stop';
  const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
  if (!request.stream) return Response.json({
    ...common,
    object: 'chat.completion',
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage,
  });
  const delta = call ? {
    ...message,
    tool_calls: message.tool_calls!.map((value, index) => ({ ...value, index })),
  } : message;
  const chunks = [
    { ...common, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: null }] },
    { ...common, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: finishReason }], usage },
  ];
  return new Response(`${chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`, {
    headers: { 'content-type': 'text/event-stream' },
  });
}

function messageText(request: ChatRequest): string {
  return request.messages.map(message => typeof message.content === 'string'
    ? message.content : JSON.stringify(message.content)).join('\n');
}

async function files(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map(entry => entry.isDirectory()
    ? files(join(directory, entry.name)) : [join(directory, entry.name)]))).flat();
}

function markdownAnchors(markdown: string): Set<string> {
  const anchors = new Set<string>();
  const counts = new Map<string, number>();
  let fence: string | undefined;
  for (const line of markdown.split('\n')) {
    const delimiter = line.match(/^\s{0,3}(`{3,}|~{3,})/u)?.[1];
    if (delimiter) {
      if (!fence) fence = delimiter[0];
      else if (delimiter[0] === fence) fence = undefined;
      continue;
    }
    if (fence) continue;
    const heading = line.match(/^\s{0,3}#{1,6}\s+(.+?)(?:\s+#+)?\s*$/u)?.[1];
    if (!heading) continue;
    const slug = heading.toLowerCase().replace(/<[^>]*>/gu, '')
      .replace(/[^\p{L}\p{N}\p{M}_\-\s]/gu, '').replace(/\s/gu, '-');
    const count = counts.get(slug) ?? 0;
    anchors.add(count ? `${slug}-${count}` : slug);
    counts.set(slug, count + 1);
  }
  for (const match of markdown.matchAll(/<(?:a|h[1-6])\b[^>]*\bid=["']([^"']+)["']/giu)) anchors.add(match[1]);
  return anchors;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('HuoX creative skill migration', () => {
  it('preserves the original professional methods, candidate counts and selection contracts', async () => {
    for (const [skill, path, digest] of sourceMethodDigests) {
      const content = await readFile(join('skills', skill, path));
      expect(createHash('sha256').update(content).digest('hex'), `${skill}/${path} differs from the supplied methodology`)
        .toBe(digest);
    }
    const opening = await readFile('skills/an-opening-design/references/开头处理方法.md', 'utf8');
    expect([...opening.matchAll(/^### (\d+)\. (.+)$/gmu)].map(match => match[2])).toEqual([
      '不稳定状态登场', '关系补全', '否定性力量', '社会身份敏感', '动物性本能', '围观与热闹', '窥探', '反常',
      '特殊消息', '强节奏', '人间美好', '新奇有趣', '情绪说破', '情感关系', '怀旧与失去', '正义与反击',
    ]);
    expect(opening).toContain('每种三个实质不同的开头，共四十八个候选');
    const situation = await readFile('skills/an-situation-design/references/four-situations.md', 'utf8');
    const professionalStart = situation.indexOf('## 先确定表达关系，再设计事件');
    expect(professionalStart).toBeGreaterThan(0);
    expect(createHash('sha256').update(situation.slice(professionalStart)).digest('hex'))
      .toBe('0f87df334518a4c623f2bf64db91bdfe91903e0a79f43ea6c732dab4f725f65c');
    expect(situation).toContain('固定“2＋2”');
    const prop = await readFile('skills/an-prop-design/references/道具设计方法.md', 'utf8');
    expect(prop).toContain('比喻型三个、载体型三个、准备型三个');
    expect(prop).toContain('同轮交付完整融合稿');
    const uplift = await readFile('skills/an-content-uplift/SKILL.md', 'utf8');
    expect(uplift).toContain('用户确认选择或明确授权按其修改要求整合后');
    expect(uplift).toContain('直接把选定内容融入原文');
  });

  it('discovers all four native skills and resolves every bundled document link and heading', async () => {
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Skill packaging checks cannot access the network'); }));
    const { huoxAgent } = await import('../src/mastra/agents/huox.ts');
    expect((await huoxAgent.listSkills()).map(skill => skill.name))
      .toEqual(expect.arrayContaining(creativeSkills.map(skill => skill.name)));
    for (const expected of creativeSkills) {
      const skill = await huoxAgent.getSkill(expected.name);
      expect(skill, `${expected.name} must be registered on HuoX`).not.toBeNull();
      if (!skill) throw new Error(`Missing skill ${expected.name}`);
      const root = resolve(skill.path);
      const main = await readFile(join(root, 'SKILL.md'), 'utf8');
      expect(validateSkillContent({ content: main, directoryName: basename(root) }).valid).toBe(true);
      expect(skill.scripts).toEqual([]);
      expect(skill.references).toEqual(expect.arrayContaining([...expected.references, 'mastra-runtime.md']));
      expect(main).toContain('references/mastra-runtime.md');
      const packagedFiles = await files(root);
      expect(packagedFiles.some(path => /(?:\.py|\.sh|\.ya?ml|_user_meta\.json|source-map\.json|\.DS_Store)$/u.test(path)))
        .toBe(false);
      for (const path of packagedFiles.filter(path => path.endsWith('.md'))) {
        const markdown = await readFile(path, 'utf8');
        for (const match of markdown.matchAll(/\[[^\]]*\]\((?:<([^>]+)>|([^\s)]+))(?:\s+"[^"]*")?\)/gu)) {
          const target = match[1] ?? match[2];
          if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/iu.test(target)) continue;
          const [fileAndQuery, fragment] = target.split('#');
          const filePath = decodeURIComponent(fileAndQuery.split('?')[0]);
          const destination = filePath ? resolve(dirname(path), filePath) : path;
          const description = `${relative(root, path)} -> ${target}`;
          expect(relative(root, destination), description).not.toMatch(/^\.\.(?:[/\\]|$)/u);
          expect((await stat(destination)).isFile(), description).toBe(true);
          if (fragment && destination.endsWith('.md')) {
            const document = await readFile(destination, 'utf8');
            expect(markdownAnchors(document).has(decodeURIComponent(fragment)), `Missing heading: ${description}`).toBe(true);
          }
        }
      }
    }
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('loads each creative skill through native tools with the current draft and resource memory', async () => {
    vi.stubEnv('APP_ENV', 'test');
    vi.stubEnv('MODEL_PROVIDER', 'cliproxy');
    vi.stubEnv('CLIPROXY_BASE_URL', 'http://127.0.0.1:44114/v1');
    vi.stubEnv('CLIPROXY_API_KEY', 'local-creative-model-key');
    vi.stubEnv('CLIPROXY_MODEL', 'local-creative-model');
    vi.stubEnv('MASTRA_MEMORY_GENERATE_TITLE', 'false');
    vi.resetModules();
    const requests: ChatRequest[] = [];
    const calls: ModelToolCall[] = [];
    // Only model responses are scripted. Native skill search, reads, processors and
    // memory injection execute normally, in isolation. This does NOT validate natural
    // model routing, creative quality, candidate generation or consent decisions.
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      if (request.url !== 'http://127.0.0.1:44114/v1/chat/completions') {
        throw new Error(`Unexpected request in creative skill regression: ${request.url}`);
      }
      const body = await request.json() as ChatRequest;
      requests.push(body);
      return completion(body, calls.shift(), requests.length);
    }));
    const { huoxAgent } = await import('../src/mastra/agents/huox.ts');
    const { chatgptOpenAIGateway } = await import('../src/mastra/gateways/chatgpt-openai-gateway.ts');
    const storage = new InMemoryStore({ id: 'creative-skills-isolated' });
    const mastra = new Mastra({ agents: { huoxAgent }, gateways: { chatgptOpenAI: chatgptOpenAIGateway }, storage, logger: false });
    try {
      const memory = await huoxAgent.getMemory();
      if (!memory) throw new Error('HuoX must expose its native memory');
      const resourceId = 'creative-alice';
      await memory.createThread({ threadId: 'creative-seed', resourceId });
      const audience = 'CREATIVE_ALICE_AUDIENCE_28ac：初次经营社区咖啡店的店主';
      await memory.updateWorkingMemory({ threadId: 'creative-seed', resourceId,
        workingMemory: JSON.stringify({ positioningReport: { coreAudience: audience } }) });
      const memoryStore = await storage.getStore('memory');
      if (!memoryStore) throw new Error('An isolated memory store is required');
      const initial = (await memoryStore.getResourceById({ resourceId }))!.workingMemory;
      for (const [index, skill] of creativeSkills.entries()) {
        const requestStart = requests.length;
        const draft = `CURRENT_DRAFT_${index}_b814：我开了一家小咖啡店，每天认真做好一杯咖啡。`;
        calls.push(
          { name: 'skill_search', input: { query: skill.title, skillNames: [skill.name], topK: 3 } },
          { name: 'skill', input: { name: skill.name } },
          { name: 'skill_read', input: { skillName: skill.name, path: 'references/mastra-runtime.md' } },
          { name: 'skill_read', input: { skillName: skill.name, path: skill.method } },
        );
        const context = new RequestContext();
        context.set(MASTRA_RESOURCE_ID_KEY, resourceId);
        await huoxAgent.generate(`请做${skill.title}。原稿：${draft}`, {
          memory: { thread: `creative-case-${index}`, resource: resourceId },
          requestContext: context,
          maxSteps: 6,
          modelSettings: { maxRetries: 0 },
        });
        expect(calls).toHaveLength(0);
        const runRequests = requests.slice(requestStart);
        expect(runRequests).toHaveLength(5);
        expect(runRequests[0].tools?.map(tool => tool.function.name))
          .toEqual(expect.arrayContaining(['skill_search', 'skill', 'skill_read']));
        expect(messageText(runRequests[1])).toContain(`[${skill.name}]`);
        for (const request of runRequests) {
          expect(messageText(request)).toContain(draft);
          expect(messageText(request)).toContain(audience);
        }
        const runtime = await readFile(join('skills', skill.name, 'references/mastra-runtime.md'), 'utf8');
        const method = await readFile(join('skills', skill.name, skill.method), 'utf8');
        const runtimeLine = runtime.split('\n').find(line => line.trim().length > 25);
        const methodLine = method.split('\n').find(line => line.trim().length > 25);
        expect(runtimeLine).toBeDefined();
        expect(methodLine).toBeDefined();
        expect(messageText(runRequests[3])).toContain(runtimeLine);
        expect(messageText(runRequests[4])).toContain(methodLine);
      }
      // With no update requested by the scripted model, creative reads do not alter
      // positioning memory. This is not a test of an LLM refusing unauthorized saves.
      expect((await memoryStore.getResourceById({ resourceId }))!.workingMemory).toBe(initial);
    } finally {
      await mastra.shutdown();
    }
  }, 30_000);
});
