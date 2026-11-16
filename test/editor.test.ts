import { Agent } from '@mastra/core/agent';
import { Mastra } from '@mastra/core/mastra';
import { InMemoryStore } from '@mastra/core/storage';
import { MastraEditor } from '@mastra/editor';
import { RequestContext } from '@mastra/core/request-context';
import { huahuoAuthMiddleware } from '../src/auth/mastra-auth.js';
import { readTrustedIdentity, trustedIdentityHeaders } from '../src/auth/trusted-identity.js';
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

describe('Editor management trusted identity', () => {
  async function invoke(environment: string, path: string, headers: HeadersInit = {}) {
    vi.stubEnv('APP_ENV', environment);
    const next = vi.fn(async () => undefined);
    const handler = typeof huahuoAuthMiddleware === 'function' ? huahuoAuthMiddleware : huahuoAuthMiddleware.handler;
    const context = {
      req: { path, raw: new Request(`http://agent.test${path}`, { headers }) },
      get: () => new RequestContext(),
    } as unknown as Parameters<typeof handler>[0];
    const response = await handler(context, next);
    return { response: response as Response | undefined, next };
  }
  const identity = readTrustedIdentity({
    'x-huahuo-user-id': 'a0000000-0000-4000-8000-000000000001',
    'x-huahuo-session-id': 'b0000000-0000-4000-8000-000000000002',
    'x-huahuo-auth-method': 'bearer',
  });

  it.each(['/api/stored/agents', '/api/stored/agents/huox/versions', '/api/stored/prompt-blocks', '/api/editor/builder/settings', '/api/%73tored/agents'])('requires trusted identity on management requests: %s', async path => {
    const result = await invoke('production', path);
    expect(result.response?.status).toBe(401); expect(result.next).not.toHaveBeenCalled();
  });
  it('accepts an internal trusted caller without a ServiceKey', async () => {
    // The gateway keeps production management routes off the external router.
    const result = await invoke('production', '/api/stored/agents', trustedIdentityHeaders(identity));
    expect(result.next).toHaveBeenCalledOnce(); expect(result.response).toBeUndefined();
  });
  it.each(['test', 'development'])('requires identity for local Studio management in %s', async environment => {
    expect((await invoke(environment, '/api/stored/agents')).response?.status).toBe(401);
    expect((await invoke(environment, '/api/stored/agents', trustedIdentityHeaders(identity))).next).toHaveBeenCalledOnce();
  });
  it('requires the same user context for ordinary and internal Agent requests', async () => {
    for (const path of ['/api/agents/huox/stream', '/internal/v1/status']) {
      expect((await invoke('development', path)).response?.status).toBe(401);
      expect((await invoke('development', path, trustedIdentityHeaders(identity))).next).toHaveBeenCalledOnce();
    }
  });
});
