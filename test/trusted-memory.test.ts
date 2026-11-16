import { Mastra } from '@mastra/core';
import { RequestContext } from '@mastra/core/request-context';
import { InMemoryStore } from '@mastra/core/storage';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { coreAuthMiddleware } from '@mastra/server/auth';
import { GET_THREAD_BY_ID_ROUTE, LIST_THREADS_ROUTE } from '@mastra/server/handlers/memory';
import { GET_WORKFLOW_RUN_BY_ID_ROUTE } from '@mastra/server/handlers/workflows';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { huahuoAuth } from '../src/auth/mastra-auth.js';
import { readTrustedIdentity, trustedIdentityHeaders } from '../src/auth/trusted-identity.js';

const alice = 'a0000000-0000-4000-8000-000000000001';
const bob = 'b0000000-0000-4000-8000-000000000002';

async function authenticate(mastra: Mastra, userId: string) {
  const identity = readTrustedIdentity({
    'x-huahuo-user-id': userId, 'x-huahuo-session-id': 'c0000000-0000-4000-8000-000000000003',
    'x-huahuo-auth-method': 'cookie', 'x-trace-id': 'memory-fixture',
  });
  const request = new Request('http://agent.test/api/memory/threads', { headers: trustedIdentityHeaders(identity) });
  const requestContext = new RequestContext();
  const result = await coreAuthMiddleware({
    path: '/api/memory/threads', method: 'GET', getHeader: name => request.headers.get(name) ?? undefined,
    mastra, authConfig: huahuoAuth, requestContext, rawRequest: request, token: null,
    buildAuthorizeContext: () => ({}),
  });
  expect(result.action).toBe('next');
  return { mastra, requestContext, abortSignal: new AbortController().signal };
}

describe('native Mastra ownership with gateway identity', () => {
  it('rejects another user’s thread and ignores a forged resourceId on listing', async () => {
    const storage = new InMemoryStore({ id: 'trusted-memory-fixture' });
    const mastra = new Mastra({ storage, server: { auth: huahuoAuth }, logger: false });
    try {
      const memory = await storage.getStore('memory');
      for (const userId of [alice, bob]) {
        await memory!.saveThread({ thread: { id: `thread-${userId}`, resourceId: userId, createdAt: new Date(), updatedAt: new Date() } });
      }
      const context = await authenticate(mastra, alice);
      await expect(GET_THREAD_BY_ID_ROUTE.handler({ ...context, threadId: `thread-${alice}` })).resolves.toMatchObject({ resourceId: alice });
      await expect(GET_THREAD_BY_ID_ROUTE.handler({ ...context, threadId: `thread-${bob}`, resourceId: bob })).rejects.toMatchObject({ status: 403 });
      const listed = await LIST_THREADS_ROUTE.handler({ ...context, resourceId: bob });
      expect(listed.threads.map(thread => thread.resourceId)).toEqual([alice]);
    } finally { await mastra.shutdown(); }
  });

  it('rejects another user’s workflow run and ownerless runs', async () => {
    const schema = z.object({ value: z.string() });
    const workflow = createWorkflow({ id: 'ownership-fixture', inputSchema: schema, outputSchema: schema })
      .then(createStep({ id: 'echo', inputSchema: schema, outputSchema: schema, execute: async ({ inputData }) => inputData }))
      .commit();
    const storage = new InMemoryStore({ id: 'trusted-workflow-fixture' });
    const mastra = new Mastra({ storage, workflows: { workflow }, server: { auth: huahuoAuth }, logger: false });
    try {
      for (const [runId, resourceId] of [['alice-run', alice], ['bob-run', bob], ['ownerless-run', undefined]] as const) {
        const run = await workflow.createRun({ runId, resourceId });
        await run.start({ inputData: { value: runId } });
      }
      const context = await authenticate(mastra, alice);
      await expect(GET_WORKFLOW_RUN_BY_ID_ROUTE.handler({ ...context, workflowId: 'workflow', runId: 'alice-run' })).resolves.toMatchObject({ resourceId: alice });
      for (const runId of ['bob-run', 'ownerless-run']) {
        await expect(GET_WORKFLOW_RUN_BY_ID_ROUTE.handler({ ...context, workflowId: 'workflow', runId })).rejects.toMatchObject({ status: 403 });
      }
    } finally { await mastra.shutdown(); }
  });
});
