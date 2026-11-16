import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error Standalone image release tooling.
import { serverPreflight } from '../../scripts/release/server-preflight.mjs';
// @ts-expect-error Standalone image release tooling.
import { runtimeCheck } from '../../scripts/release/runtime-check.mjs';

const ready = () => Response.json({ success: true, data: { service: 'api-server', status: 'ready' } });
const denied = () => Response.json({ success: false, error: { code: 'UNAUTHORIZED' } }, { status: 401 });
describe('release dependency contract', () => {
  it('accepts an independently deployed Server by contract, without tokens or version coupling', async () => {
    const request = vi.fn<typeof fetch>(async url => String(url).endsWith('/health/ready') ? ready() : denied());
    await expect(serverPreflight('http://internal.test:13001', request)).resolves.toMatchObject({ status: 'passed' });
    expect(request.mock.calls.map(([url]) => url)).toEqual(['http://internal.test:13001/health/ready', 'http://internal.test:13001/internal/v1/gateway/auth']);
    for (const [, init] of request.mock.calls) {
      expect(init).toMatchObject({ method: 'GET', redirect: 'error' });
      expect(new Headers(init?.headers).has('authorization')).toBe(false);
    }
  });
  it.each([404, 200, 503])('blocks old, open or unavailable auth endpoints (%s)', async status => {
    const request = vi.fn<typeof fetch>(async url => String(url).endsWith('/health/ready') ? ready() : Response.json({ success: true }, { status }));
    await expect(serverPreflight('http://internal.test', request)).rejects.toThrow('AGENT_SERVER_PREFLIGHT_FAILED');
  });
  it('blocks unreachable dependencies, redirects, oversized or semantically wrong responses', async () => {
    for (const response of [new Response('x'.repeat(4097)), Response.json({ success: true, data: { service: 'admin', status: 'ready' } }), denied()]) {
      await expect(serverPreflight('http://internal.test', async () => response)).rejects.toThrow('AGENT_SERVER_PREFLIGHT_FAILED');
    }
    await expect(serverPreflight('http://internal.test', async () => { throw Error('private failure'); })).rejects.toThrow('AGENT_SERVER_PREFLIGHT_FAILED');
  });
  it.each(['http://internal.test/api', 'http://user:secret@internal.test', 'ftp://internal.test', 'http://internal.test?token=secret'])('rejects invalid origins before connecting', async url => {
    const request = vi.fn(); await expect(serverPreflight(url, request)).rejects.toThrow('AGENT_SERVER_PREFLIGHT_FAILED');
    expect(request).not.toHaveBeenCalled();
  });
});
describe('candidate local runtime', () => {
  it('checks health and fails if Agent APIs accidentally become anonymous', async () => {
    for (const status of [401, 200, 503]) {
      const request = vi.fn<typeof fetch>(async url => String(url).endsWith('/health') ? Response.json({ success: true }) : new Response('', { status }));
      if (status === 401) await expect(runtimeCheck(request)).resolves.toMatchObject({ status: 'passed' });
      else await expect(runtimeCheck(request)).rejects.toThrow('AGENT_RUNTIME_CHECK_FAILED');
      expect(request.mock.calls.map(([url]) => url)).toEqual(['http://127.0.0.1:4111/health', 'http://127.0.0.1:4111/api/agents']);
    }
  });
});
