import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { Mastra } from '@mastra/core';
import { MASTRA_RESOURCE_ID_KEY, RequestContext } from '@mastra/core/request-context';
import { validateSkillContent } from '@mastra/core/skills';
import { InMemoryStore } from '@mastra/core/storage';
import { afterEach, describe, expect, it, vi } from 'vitest';

const skillName = 'an-language-style';

type ChatMessage = { role: string; content?: unknown; tool_calls?: unknown[] };
type ChatRequest = {
  model: string;
  stream?: boolean;
  messages: ChatMessage[];
  tools?: Array<{ function: { name: string } }>;
};
type ModelToolCall = { name: string; input: unknown };

function completion(request: ChatRequest, call: ModelToolCall | undefined, sequence: number): Response {
  const common = { id: `language-style-fixture-${sequence}`, created: 1, model: request.model };
  const message = call ? {
    role: 'assistant',
    content: null,
    tool_calls: [{
      id: `style-call-${sequence}`,
      type: 'function',
      function: { name: call.name, arguments: JSON.stringify(call.input) },
    }],
  } : { role: 'assistant', content: '语言风格接入测试完成。' };
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

function userContext(resourceId: string): RequestContext {
  const context = new RequestContext();
  context.set(MASTRA_RESOURCE_ID_KEY, resourceId);
  return context;
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

describe('HuoX language style skill and resource memory', () => {
  it('preserves the source learning and expression methods and resolves all bundled links', async () => {
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Language-style package checks cannot access the network'); }));
    const { huoxAgent } = await import('../src/mastra/agents/huox.ts');
    expect((await huoxAgent.listSkills()).map(skill => skill.name)).toContain(skillName);
    const skill = await huoxAgent.getSkill(skillName);
    if (!skill) throw new Error('The language style skill must be registered on HuoX');
    const root = resolve(skill.path);
    const main = await readFile(join(root, 'SKILL.md'), 'utf8');
    expect(validateSkillContent({ content: main, directoryName: basename(root) }).valid).toBe(true);
    expect(skill.scripts).toEqual([]);
    expect(skill.references).toEqual(expect.arrayContaining([
      'learning.md', 'application.md', 'storage.md', 'language-style-handoff.md',
      'profile-updates.md', 'positioning-report-views.md', 'validation.md', 'mastra-runtime.md',
    ]));
    expect(main).toContain('references/mastra-runtime.md');
    // Digests are from professional sections of the supplied package, before migration.
    // Host-specific read/save paragraphs are intentionally excluded. Preserved text is
    // not evidence that a real model learns the author's language or respects consent.
    for (const [path, start, end, digest] of [
      ['learning.md', '## 材料及范围', '## 冲突与已有资料', '3156560f0c509a9abfd24d1e5912a143a7055e93e9bddd9372dd6fc3595740d3'],
      ['application.md', '## 起稿与内容职责', '默认交付用户要求的稿件', 'c50fb269e19385f18faecf6cf4d841962c6a6ba6031fb3d82a06c621dea0c5d1'],
    ]) {
      const content = await readFile(join(root, 'references', path), 'utf8');
      const startIndex = content.indexOf(start);
      const endIndex = content.indexOf(end);
      expect(startIndex).toBeGreaterThan(-1);
      expect(endIndex).toBeGreaterThan(startIndex);
      expect(createHash('sha256').update(content.slice(startIndex, endIndex)).digest('hex'), path).toBe(digest);
    }
    const packaged = await files(root);
    expect(packaged.some(path => /(?:\.py|\.sh|\.ya?ml|_user_meta\.json|source-map\.json|\.DS_Store)$/u.test(path)))
      .toBe(false);
    for (const path of packaged.filter(path => path.endsWith('.md'))) {
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
          expect(markdownAnchors(await readFile(destination, 'utf8')).has(decodeURIComponent(fragment)), description).toBe(true);
        }
      }
    }
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('validates source provenance and keeps candidate observations out of the active writing profile', async () => {
    const { languageStyleSourceSchema, languageStyleProfileSchema } = await import('../src/mastra/memory/language-style-schema.ts');
    const { huoxWorkingMemorySchema } = await import('../src/mastra/memory/positioning-schema.ts');
    const source = {
      sourceId: 'style-source-1', scope: '公众口播', sourceNote: '用户明确授权的表达学习材料',
      lineage: 'same-original-draft', originalText: '先弄明白它是怎么运转的。',
    };
    for (const kind of ['author', 'oral', 'correction', 'external', 'preference', 'unknown', 'adopted-ai']) {
      expect(languageStyleSourceSchema.safeParse({
        ...source, kind,
        ...(kind === 'correction' ? { beforeText: '先理解背后的运行机制。' } : {}),
        ...(kind === 'adopted-ai' ? { adoptionNote: '用户明确选择仅此句作为目标表达参考。' } : {}),
      }).success, `Valid source kind ${kind}`).toBe(true);
    }
    expect(languageStyleSourceSchema.safeParse({ ...source, kind: 'invented-kind' }).success).toBe(false);
    expect(languageStyleSourceSchema.safeParse({ ...source, kind: 'correction' }).success).toBe(false);
    expect(languageStyleSourceSchema.safeParse({ ...source, kind: 'author', beforeText: '修改前。' }).success).toBe(false);
    expect(languageStyleSourceSchema.safeParse({ ...source, kind: 'adopted-ai' }).success).toBe(false);
    expect(languageStyleSourceSchema.safeParse({ ...source, kind: 'author', adoptionNote: '错误的认领字段。' }).success).toBe(false);
    expect(languageStyleSourceSchema.safeParse({ ...source, kind: 'author', lineage: '  ' }).success).toBe(false);

    const preference = {
      id: 'wording-1', basis: 'target_preference', type: 'wording', status: 'active',
      expression: '用具体动作解释过程。', scope: '面向公众的说明', sourceIds: [source.sourceId],
    };
    expect(languageStyleProfileSchema.safeParse({ activePreferences: [preference] }).success).toBe(true);
    expect(languageStyleProfileSchema.safeParse({ activePreferences: [{ ...preference, status: 'candidate' }] }).success)
      .toBe(false);
    expect(huoxWorkingMemorySchema.safeParse({ languageStyleProfile: {
      languageWorld: { goals: [{ content: '希望说得更清楚。', sourceIds: [source.sourceId] }] },
    } }).success).toBe(true);
    expect(huoxWorkingMemorySchema.safeParse({ languageStyleLearning: {
      sources: [{ ...source, kind: 'correction' }],
    } }).success).toBe(false);
    expect(huoxWorkingMemorySchema.safeParse({ languageStyleLearning: {
      observations: [{ ...preference, status: 'superseded', reason: '用户已选择替代偏好。' }],
    } }).success).toBe(false);
    expect(huoxWorkingMemorySchema.safeParse({ languageStyleLearning: {
      observations: [{ ...preference, status: 'superseded', reason: '用户已选择替代偏好。', supersededBy: ['wording-2'] }],
    } }).success).toBe(true);
    // These checks establish shape and conditional fields, not the truth of a user
    // claim, explicit consent, automatic source hashing or independent sample counts.
  });

  it('loads the native skill and merges style fields without losing positioning or crossing resources', async () => {
    vi.stubEnv('APP_ENV', 'test');
    vi.stubEnv('MODEL_PROVIDER', 'cliproxy');
    vi.stubEnv('CLIPROXY_BASE_URL', 'http://127.0.0.1:44115/v1');
    vi.stubEnv('CLIPROXY_API_KEY', 'local-language-style-model-key');
    vi.stubEnv('CLIPROXY_MODEL', 'local-language-style-model');
    vi.stubEnv('MASTRA_MEMORY_GENERATE_TITLE', 'false');
    vi.resetModules();
    const requests: ChatRequest[] = [];
    const calls: ModelToolCall[] = [];
    // Only model responses are scripted. Actual native skill discovery, reads,
    // schema validation, fallback merging and resource memory injection run below.
    // This does not prove autonomous style learning, creative quality, authorization
    // decisions, selective context loading or PostgreSQL cross-process concurrency.
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      if (request.url !== 'http://127.0.0.1:44115/v1/chat/completions') {
        throw new Error(`Unexpected request in language-style regression: ${request.url}`);
      }
      const body = await request.json() as ChatRequest;
      requests.push(body);
      return completion(body, calls.shift(), requests.length);
    }));
    const { huoxAgent } = await import('../src/mastra/agents/huox.ts');
    const { chatgptOpenAIGateway } = await import('../src/mastra/gateways/chatgpt-openai-gateway.ts');
    const { huoxWorkingMemorySchema } = await import('../src/mastra/memory/positioning-schema.ts');
    const storage = new InMemoryStore({ id: 'language-style-isolated' });
    const mastra = new Mastra({ agents: { huoxAgent }, gateways: { chatgptOpenAI: chatgptOpenAIGateway }, storage, logger: false });
    try {
      const memory = await huoxAgent.getMemory();
      const store = await storage.getStore('memory');
      if (!memory || !store) throw new Error('The isolated native memory store is required');
      const resourceId = 'language-style-alice';
      const threadId = 'language-style-alice-one';
      const sourceId = 'alice-correction-1';
      const knownBackground = 'ALICE_STYLE_BACKGROUND_a29c：经常向咖啡新手解释制作过程。';
      const positioning = 'ALICE_POSITIONING_c14e：附近想自己冲咖啡的上班族。';
      const sourceMarker = 'ALICE_SOURCE_ORIGINAL_2db8';
      const originalSource = `  ${sourceMarker}：先弄明白它是怎么运转的。\n第二行  保留原有空格。\n`;
      const source = {
        sourceId, kind: 'correction', scope: '公众口播', sourceNote: '用户认领的手改对照，仅学习表达。',
        lineage: 'alice-original-one', originalText: originalSource, beforeText: '先理解背后的运行机制。',
      };
      const rule = {
        id: 'alice-wording-1', basis: 'observed_habit', type: 'wording', status: 'active',
        expression: '用具体动作说明过程。', scope: '面向新手的解释', sourceIds: [sourceId],
      };
      const retiredRule = {
        ...rule, id: 'alice-avoidance-2', type: 'avoidance', expression: '在日常口播里少用不必要的抽象包装。',
      };
      const candidate = {
        ...rule, id: 'alice-candidate-3', status: 'candidate', expression: '可能偏好先说结果再解释过程。',
        reason: '只有一次观察，暂不作为有效规则。',
      };
      const seed = {
        positioningReport: { coreAudience: positioning },
        positioningConsultation: { mode: 'deep', currentSubjectId: 'audience_facts' },
        languageStyleProfile: {
          authorAndScope: '当前用户，面向新手的公众口播。',
          languageWorld: {
            knownBackground: [{ content: knownBackground, sourceIds: [sourceId] }],
            goals: [{ content: '希望解释容易理解。', sourceIds: [sourceId] }],
          },
          activePreferences: [rule, retiredRule],
          scenarioDifferences: [{ scope: '解释必要概念时', instruction: '保留准确术语，再用日常话说明。', sourceIds: [sourceId] }],
          sourceIndex: [{ sourceId, lineage: source.lineage, kind: source.kind, purpose: '局部改稿表达依据' }],
        },
        languageStyleLearning: {
          sources: [source], observations: [candidate],
          learningRecords: [{ id: 'alice-learning-1', authorizationBasis: '用户明确授权学习该次改稿。',
            sourceIds: [sourceId], affectedRuleIds: [rule.id], summary: '只学习表达方式，未迁移样文观点。' }],
        },
      };
      expect(huoxWorkingMemorySchema.safeParse(seed).success).toBe(true);
      await memory.createThread({ threadId, resourceId });
      await memory.updateWorkingMemory({ threadId, resourceId, workingMemory: JSON.stringify(seed) });
      const readResource = async () => JSON.parse((await store.getResourceById({ resourceId }))!.workingMemory!);
      const revisedRule = { ...rule, expression: 'ALICE_ACTIVE_STYLE_9aa3：优先用具体动作讲清怎么运转。' };
      const inactiveRule = { ...retiredRule, status: 'inactive', reason: '用户明确停用这条观察，保留原依据。' };
      calls.push(
        { name: 'skill_search', input: { query: '语言风格', skillNames: [skillName], topK: 3 } },
        { name: 'skill', input: { name: skillName } },
        { name: 'skill_read', input: { skillName, path: 'references/mastra-runtime.md' } },
        { name: 'skill_read', input: { skillName, path: 'references/learning.md' } },
        { name: 'updateWorkingMemory', input: { memory: {
          languageStyleProfile: { activePreferences: [revisedRule] },
          languageStyleLearning: { sources: [source], observations: [candidate, inactiveRule] },
        } } },
      );
      await huoxAgent.generate('请学习这次表达更正并保存。停用旧的避用观察，保留未决候选和原来源。', {
        requestContext: userContext(resourceId), memory: { thread: threadId, resource: resourceId },
        maxSteps: 7, modelSettings: { maxRetries: 0 },
      });
      expect(calls).toHaveLength(0);
      expect(requests).toHaveLength(6);
      expect(requests[0].tools?.map(tool => tool.function.name)).toEqual(expect.arrayContaining([
        'skill_search', 'skill', 'skill_read', 'updateWorkingMemory',
      ]));
      expect(messageText(requests[1])).toContain(`[${skillName}]`);
      expect(messageText(requests[4])).toContain('同一原稿的反复修改使用同一 lineage');
      const saved = await readResource();
      expect(saved.positioningReport).toEqual(seed.positioningReport);
      expect(saved.positioningConsultation).toEqual(seed.positioningConsultation);
      // Arrays are complete replacements, not automatic append/deduplication lists.
      expect(saved.languageStyleProfile.activePreferences).toEqual([revisedRule]);
      expect(saved.languageStyleProfile.languageWorld).toEqual(seed.languageStyleProfile.languageWorld);
      expect(saved.languageStyleProfile.scenarioDifferences).toEqual(seed.languageStyleProfile.scenarioDifferences);
      expect(saved.languageStyleLearning.sources).toEqual([source]);
      expect(saved.languageStyleLearning.sources[0].originalText).toBe(originalSource);
      expect(saved.languageStyleLearning.learningRecords).toEqual(seed.languageStyleLearning.learningRecords);
      expect(saved.languageStyleLearning.observations).toEqual([candidate, inactiveRule]);

      calls.push({ name: 'updateWorkingMemory', input: { memory: {
        languageStyleProfile: { languageWorld: { goals: [{ content: '希望解释简洁但不省略必要条件。', sourceIds: [sourceId] }] } },
      } } });
      await huoxAgent.generate('只更新我刚明确的表达目标，其他风格与定位保持原样。', {
        requestContext: userContext(resourceId), memory: { thread: threadId, resource: resourceId },
        maxSteps: 3, modelSettings: { maxRetries: 0 },
      });
      const partial = await readResource();
      expect(partial.languageStyleProfile.languageWorld.knownBackground)
        .toEqual(seed.languageStyleProfile.languageWorld.knownBackground);
      expect(partial.languageStyleProfile.activePreferences).toEqual([revisedRule]);
      expect(partial.languageStyleLearning).toEqual(saved.languageStyleLearning);
      expect(partial.positioningReport).toEqual(seed.positioningReport);

      // The model tool must apply the source's conditional validation too, not just
      // advertise the JSON shape. Missing correction-before material cannot replace
      // the existing evidence. Direct storage APIs are outside this tool-path check.
      calls.push({ name: 'updateWorkingMemory', input: { memory: {
        languageStyleLearning: { sources: [{ ...source, beforeText: undefined }] },
      } } });
      await huoxAgent.generate('模拟一次缺少修改前文的来源写入，校验失败后保留已有证据。', {
        requestContext: userContext(resourceId), memory: { thread: threadId, resource: resourceId },
        maxSteps: 3, modelSettings: { maxRetries: 0 },
      });
      expect(calls).toHaveLength(0);
      expect(await readResource()).toEqual(partial);

      await huoxAgent.generate('新对话，请按我现有的表达偏好写。', {
        requestContext: userContext(resourceId), memory: { thread: 'language-style-alice-two', resource: resourceId },
        maxSteps: 1, modelSettings: { maxRetries: 0 },
      });
      expect(messageText(requests.at(-1)!)).toContain(revisedRule.expression);
      expect(messageText(requests.at(-1)!)).toContain(knownBackground);
      // Both top-level keys are native working memory and are injected together.
      // Their separate purposes are model instructions, not physical access isolation.
      expect(messageText(requests.at(-1)!)).toContain(sourceMarker);

      await huoxAgent.generate('另一位用户，请查看我的风格。', {
        requestContext: userContext('language-style-bob'),
        memory: { thread: 'language-style-bob-one', resource: 'language-style-bob' },
        maxSteps: 1, modelSettings: { maxRetries: 0 },
      });
      expect(messageText(requests.at(-1)!)).not.toContain(revisedRule.expression);
      expect(messageText(requests.at(-1)!)).not.toContain(sourceMarker);
      expect(messageText(requests.at(-1)!)).not.toContain(positioning);
      expect(await store.getResourceById({ resourceId: 'language-style-bob' })).toBeNull();
      expect(await readResource()).toEqual(partial);
      expect(await memory.supportsAtomicWorkingMemoryMerge()).toBe(false);
    } finally {
      await mastra.shutdown();
    }
  }, 30_000);
});
