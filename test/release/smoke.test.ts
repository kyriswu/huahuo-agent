import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error Release tooling uses standalone JavaScript.
import { smoke } from '../../scripts/release/smoke.mjs';

describe('Agent fixed health smoke', () => {
  it('checks the bounded local health response without calling a provider', async () => {
    const request = vi.fn(async () => Response.json({ success: true }));
    await expect(smoke(request)).resolves.toMatchObject({ status: 'passed', scope: 'http-process-only' });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]).toMatchObject(['http://127.0.0.1:4111/health', { method: 'GET', redirect: 'error' }]);
  });
  it.each([Response.json({ success: false }), Response.json({ success: true }, { status: 503 }), new Response('x'.repeat(4097))])('refuses failed or invalid health', async response => {
    await expect(smoke(async () => response)).rejects.toThrow('AGENT_HEALTH_FAILED');
  });
  it('rejects arbitrary destinations before fetching', async () => {
    const request = vi.fn(); await expect(smoke(request, '4111/private')).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
});
