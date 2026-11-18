import { describe, expect, it, vi } from 'vitest';

import { createAiTemplateRoute } from '../src/mastra/routes/ai-templates.js';

const identity = {
  'x-huahuo-user-id': '00000000-0000-4000-8000-000000000001',
  'x-huahuo-session-id': '00000000-0000-4000-8000-000000000002',
  'x-huahuo-auth-method': 'bearer',
};
const input = { prompt: '整理纲要', text: '原文', stream: false };

async function call(route: ReturnType<typeof createAiTemplateRoute>, json: object, authenticated = true): Promise<Response> {
  const request = new Request('http://agent.test/internal/v1/ai-template-runs', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(authenticated ? identity : {}) },
    body: JSON.stringify(json),
  });
  if (!('handler' in route) || !route.handler) throw new Error('Missing test route handler');
  const response = await route.handler(
    { req: { raw: request, header: (name: string) => request.headers.get(name), text: () => request.text() } } as unknown as Parameters<typeof route.handler>[0],
    async () => undefined,
  );
  if (!(response instanceof Response)) throw new Error('Template route did not return a response');
  return response;
}

describe('internal AI template text adapter', () => {
  it('requires trusted identity and accepts only the execution contract', async () => {
    const generate = vi.fn(async function* () { yield 'generated'; });
    const route = createAiTemplateRoute(generate);
    expect(route.requiresAuth).toBe(true);
    expect((await call(route, input, false)).status).toBe(401);
    expect((await call(route, { ...input, model: 'client-model' })).status).toBe(400);
    expect((await call(route, { ...input, text: ' ' })).status).toBe(400);
    expect(generate).not.toHaveBeenCalled();
  });

  it('returns the complete text or pulls incremental text and a single terminal result', async () => {
    const route = createAiTemplateRoute(async function* (_context, received) {
      expect(received).toMatchObject({ prompt: input.prompt, text: input.text });
      yield '第一段';
      yield '和第二段';
    });
    const json = await call(route, input);
    expect(await json.json()).toEqual({ text: '第一段和第二段' });

    const streaming = await call(route, { ...input, stream: true });
    expect(streaming.headers.get('content-type')).toContain('application/x-ndjson');
    const events = (await streaming.text()).trim().split('\n').map(line => JSON.parse(line));
    expect(events).toEqual([
      { type: 'delta', text: '第一段' },
      { type: 'delta', text: '和第二段' },
      { type: 'result', text: '第一段和第二段' },
    ]);
  });

  it('terminates a failed stream without exposing provider errors', async () => {
    const route = createAiTemplateRoute(async function* () {
      yield 'partial';
      throw new Error('private provider detail');
    });
    const json = await call(route, input);
    expect(json.status).toBe(502);
    expect(await json.json()).toEqual({ error: { code: 'AI_TEMPLATE_GENERATION_FAILED' } });
    const streaming = await call(route, { ...input, stream: true });
    expect((await streaming.text()).trim().split('\n').map(line => JSON.parse(line))).toEqual([
      { type: 'delta', text: 'partial' }, { type: 'error', code: 'AI_TEMPLATE_GENERATION_FAILED' },
    ]);
  });
});
