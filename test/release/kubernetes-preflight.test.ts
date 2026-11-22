import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error Container preflight is dependency-free JavaScript.
import { kubernetesPreflight } from '../../scripts/release/kubernetes-preflight.mjs';

const env = {
  APP_ENV: 'test',
  HUAHUO_SERVER_BASE_URL: 'http://huahuo-api:3000',
  MASTRA_POSTGRES_HOST: 'postgres.test',
  MASTRA_POSTGRES_DATABASE: 'fixture',
  MASTRA_POSTGRES_USER: 'fixture-user',
  MASTRA_POSTGRES_PASSWORD: 'fixture-password',
};

describe('Kubernetes startup preflight', () => {
  it.each(Object.keys(env))('refuses missing %s before calling Server', async key => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(kubernetesPreflight({ ...env, [key]: ' ' }, fetchImpl)).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses to skip storage initialization', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(kubernetesPreflight({ ...env, MASTRA_DISABLE_STORAGE_INIT: 'true' }, fetchImpl))
      .rejects.toThrow('AGENT_K8S_STORAGE_INIT_DISABLED');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('checks the private Server contract using the existing anonymous requests', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ success: true, data: { service: 'api-server', status: 'ready' } }))
      .mockResolvedValueOnce(Response.json({ success: false, error: { code: 'UNAUTHORIZED' } }, { status: 401 }));
    await expect(kubernetesPreflight(env, fetchImpl)).resolves.toMatchObject({ status: 'passed' });
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      'http://huahuo-api:3000/health/ready',
      'http://huahuo-api:3000/internal/v1/gateway/auth',
    ]);
  });
});
