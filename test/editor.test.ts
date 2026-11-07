import { Agent } from '@mastra/core/agent';
import { Mastra } from '@mastra/core/mastra';
import { InMemoryStore } from '@mastra/core/storage';
import { MastraEditor } from '@mastra/editor';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('Mastra Editor', () => {
  it('reuses Mastra storage and keeps drafts separate from published code-agent overrides', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Editor configuration must not call a model or remote service'); }));
    const agent = new Agent({ id: 'editor-fixture', name: 'Editor fixture', instructions: 'Original code instructions', model: 'openai/no-call-editor-fixture' });
    const storage = new InMemoryStore({ id: 'editor-isolated-test' });
    const editor = new MastraEditor();
    const mastra = new Mastra({ agents: { fixture: agent }, storage, editor, logger: false });
    try {
      expect(mastra.getEditor()).toBe(editor);
      expect(mastra.getStorage()?.id).toBe(storage.id);
      expect(await (await editor.agent.applyStoredOverrides(agent, { status: 'published' })).getInstructions()).toBe('Original code instructions');
      await editor.agent.create({ id: agent.id, name: agent.name, instructions: 'First stored instructions', model: { provider: 'openai', name: 'no-call-editor-fixture' } });
      const before = await (await editor.agent.applyStoredOverrides(agent, { status: 'published' })).getInstructions();
      await editor.agent.update({ id: agent.id, instructions: 'Unpublished draft instructions' });
      expect(await (await editor.agent.applyStoredOverrides(agent, { status: 'draft' })).getInstructions()).toBe('Unpublished draft instructions');
      expect(await (await editor.agent.applyStoredOverrides(agent, { status: 'published' })).getInstructions()).toEqual(before);
      const agents = await storage.getStore('agents');
      const draft = await agents!.getByIdResolved(agent.id, { status: 'draft' });
      expect(draft?.resolvedVersionId).toBeTruthy();
      await editor.agent.update({ id: agent.id, status: 'published', activeVersionId: draft!.resolvedVersionId! });
      expect(await (await editor.agent.applyStoredOverrides(agent, { status: 'published' })).getInstructions()).toBe('Unpublished draft instructions');
      expect(await agent.getInstructions()).toBe('Original code instructions');
      expect(globalThis.fetch).not.toHaveBeenCalled();
    } finally { await mastra.shutdown(); }
  });
});

describe('Editor management service authentication', () => {
  async function invoke(environment: string, path: string, key?: string) {
    vi.stubEnv('APP_ENV', environment);
    vi.stubEnv('HUAHUO_SERVER_BASE_URL', 'https://server.example.test');
    vi.stubEnv('HUAHUO_SERVER_TO_AGENT_API_KEY', 'editor-test-service-key');
    vi.resetModules();
    const { huahuoServiceAuthMiddleware } = await import('../src/auth/mastra-auth.ts');
    const next = vi.fn(async () => undefined);
    const handler = typeof huahuoServiceAuthMiddleware === 'function' ? huahuoServiceAuthMiddleware : huahuoServiceAuthMiddleware.handler;
    const context = { req: { path, header: (name: string) => name.toLowerCase() === 'x-huahuo-service-key' ? key : undefined } } as unknown as Parameters<typeof handler>[0];
    const response = await handler(context, next);
    return { response: response as Response | undefined, next };
  }
  it.each(['/api/stored/agents', '/api/stored/agents/huox/versions', '/api/stored/prompt-blocks', '/api/editor/builder/settings', '/api/%73tored/agents'])('rejects a production management request without the service credential: %s', async path => {
    const result = await invoke('production', path);
    expect(result.response?.status).toBe(401); expect(result.next).not.toHaveBeenCalled();
  });
  it('rejects an incorrect key and accepts the configured service credential', async () => {
    expect((await invoke('production', '/api/stored/agents', 'wrong')).response?.status).toBe(401);
    const result = await invoke('production', '/api/stored/agents', 'editor-test-service-key');
    expect(result.next).toHaveBeenCalledOnce(); expect(result.response).toBeUndefined();
  });
  it('keeps local Studio available without a service credential', async () => {
    const result = await invoke('development', '/api/stored/agents'); expect(result.next).toHaveBeenCalledOnce();
  });
  it('leaves ordinary user Agent endpoints on their existing JWT authentication path', async () => {
    const result = await invoke('production', '/api/agents/huox/stream'); expect(result.next).toHaveBeenCalledOnce();
  });
  it('still requires service credentials on internal endpoints during development', async () => {
    expect((await invoke('development', '/internal/v1/status')).response?.status).toBe(401);
  });
});
