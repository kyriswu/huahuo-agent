import { RequestContext } from '@mastra/core/request-context';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeepSeekWebClient } from '../src/mastra/tools/mcp/deepseek-web/client.ts';
import { onlineSearch, urlFetch } from '../src/mastra/tools/mcp/index.ts';

const searchResult = {
  rerank_score: 2.4,
  title: 'Example source',
  url: 'https://example.org/article',
  snippet: 'A short excerpt.',
  summary: 'Evidence from the example source.',
  content: '',
  site_name: null,
  site_icon: null,
  date: '2026-11-13T00:00:00+00:00',
  authority: -1,
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('DeepSeek Search and Fetch client', () => {
  it('preserves search operators, applies defaults, and authenticates only to DeepSeek', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ results: [searchResult] }));
    const client = new DeepSeekWebClient({ apiKey: ' local-deepseek-key ', fetchImpl });
    const query = 'DeepSeek site:api-docs.deepseek.com "Search & Fetch" -site:example.com';

    await expect(client.search({ query })).resolves.toEqual({ results: [searchResult] });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.deepseek.com/v1/tools/search');
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', headers: {
      authorization: 'Bearer local-deepseek-key', 'content-type': 'application/json',
    } });
    expect(JSON.parse(String(init?.body))).toEqual({ query, count: 10, localization: '', need_content: false });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('supports Unicode character limits and all optional search fields', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ results: [{ ...searchResult, content: 'Full content' }] }));
    const client = new DeepSeekWebClient({ apiKey: 'key', fetchImpl });
    const input = { query: '🌍'.repeat(128), count: 50, ori_question: 'Original question', localization: '2001:db8::1', need_content: true };
    const result = await client.search(input);
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))).toEqual(input);
    expect(result.results[0].content).toBe('Full content');
    expect(() => client.search({ query: '🌍'.repeat(129) })).toThrow();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('accepts empty search results and null optional question without inventing results', async () => {
    const client = new DeepSeekWebClient({ apiKey: 'key', fetchImpl: async () => Response.json({ results: [] }) });
    await expect(client.search({ query: 'no matches', ori_question: null })).resolves.toEqual({ results: [] });
  });

  it.each([
    { query: '   ' }, { query: '' }, { query: 'x', count: 0 }, { query: 'x', count: 51 },
    { query: 'x', count: 1.5 }, { query: 'x', localization: 'not-an-ip' },
  ])('rejects invalid search input before making a request: %j', async input => {
    const fetchImpl = vi.fn<typeof fetch>();
    const client = new DeepSeekWebClient({ apiKey: 'key', fetchImpl });
    expect(() => client.search(input)).toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('fetches a page through the DeepSeek endpoint and preserves Markdown', async () => {
    const page = { title: '', content: '# Source\n\n[Reference](https://example.org/reference)' };
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json(page));
    const client = new DeepSeekWebClient({ apiKey: 'key', fetchImpl });
    await expect(client.fetchPage({ url: searchResult.url })).resolves.toEqual(page);
    expect(fetchImpl.mock.calls[0][0]).toBe('https://api.deepseek.com/v1/tools/fetch');
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))).toEqual({ url: searchResult.url });
  });

  it.each(['not a URL', 'file:///etc/passwd', 'ftp://example.org/a', 'https://user:password@example.org', 'https://:password@example.org', `https://example.org/${'x'.repeat(8192)}`])(
    'rejects invalid or credential-bearing page URLs without a request: %s', url => {
      const fetchImpl = vi.fn<typeof fetch>();
      const client = new DeepSeekWebClient({ apiKey: 'key', fetchImpl });
      expect(() => client.fetchPage({ url })).toThrow();
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it('requires a key only when called, without making an unauthenticated request', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', '');
    const fetchImpl = vi.fn<typeof fetch>();
    const client = new DeepSeekWebClient({ fetchImpl });
    await expect(client.search({ query: 'test' })).rejects.toMatchObject({ code: 'DEEPSEEK_API_KEY_REQUIRED' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([400, 401, 402, 403, 404])('reports HTTP %s safely without retrying it', async status => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ error: { message: 'secret-provider-key' } }, { status }));
    const client = new DeepSeekWebClient({ apiKey: 'secret-provider-key', fetchImpl });
    const error = await client.search({ query: 'test' }).catch(error => error as Error);
    expect(error).toMatchObject({ code: `DEEPSEEK_HTTP_${status}`, status });
    expect(String(error)).not.toContain('secret-provider-key');
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('retries an explicit transient HTTP failure and preserves the request', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ error: 'unavailable' }, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ results: [] }));
    const client = new DeepSeekWebClient({ apiKey: 'key', fetchImpl });
    await expect(client.search({ query: 'test' })).resolves.toEqual({ results: [] });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[1][1]).toEqual(fetchImpl.mock.calls[0][1]);
  });

  it('bounds retries and respects a Retry-After longer than its short retry window', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({}, { status: 429, headers: { 'retry-after': '30' } }));
    const client = new DeepSeekWebClient({ apiKey: 'key', fetchImpl });
    await expect(client.search({ query: 'test' })).rejects.toMatchObject({ status: 429 });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('stops after one retry when a transient failure persists', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({}, { status: 429 }));
    const client = new DeepSeekWebClient({ apiKey: 'key', fetchImpl });
    await expect(client.search({ query: 'test' })).rejects.toMatchObject({ status: 429 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each([
    () => new Response('not JSON: secret-provider-key'),
    () => Response.json({ results: [{ title: 'Incomplete result' }] }),
  ])('rejects malformed successful responses without exposing their bodies', async response => {
    const client = new DeepSeekWebClient({ apiKey: 'key', fetchImpl: async () => response() });
    const error = await client.search({ query: 'test' }).catch(error => error as Error);
    expect(error).toMatchObject({ code: 'DEEPSEEK_INVALID_RESPONSE' });
    expect(String(error)).not.toContain('secret-provider-key');
  });

  it('does not replay ambiguous network failures or leak their details', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => { throw new Error('secret-provider-key'); });
    const client = new DeepSeekWebClient({ apiKey: 'secret-provider-key', fetchImpl });
    const error = await client.search({ query: 'test' }).catch(error => error as Error);
    expect(error).toMatchObject({ code: 'DEEPSEEK_NETWORK_ERROR' });
    expect(String(error)).not.toContain('secret-provider-key');
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  function pendingFetch() {
    return vi.fn<typeof fetch>(async (_input, init) => new Promise<Response>((_resolve, reject) => {
      const signal = init!.signal!;
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
  }

  it('propagates cancellation and never starts an already-cancelled request', async () => {
    const controller = new AbortController();
    const fetchImpl = pendingFetch();
    const client = new DeepSeekWebClient({ apiKey: 'key', fetchImpl });
    const pending = client.search({ query: 'test' }, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'DEEPSEEK_ABORTED' });
    await expect(client.search({ query: 'test' }, controller.signal)).rejects.toMatchObject({ code: 'DEEPSEEK_ABORTED' });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('enforces the deadline without retrying the timed-out request', async () => {
    const fetchImpl = pendingFetch();
    const client = new DeepSeekWebClient({ apiKey: 'key', fetchImpl, timeoutMs: 10 });
    await expect(client.fetchPage({ url: searchResult.url })).rejects.toMatchObject({ code: 'DEEPSEEK_TIMEOUT' });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});

describe('shared in-process web tools', () => {
  it('uses server-side DeepSeek credentials instead of the caller JWT for both tools', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'tool-deepseek-key');
    const fetchImpl = vi.fn<typeof fetch>(async input => String(input).endsWith('/search')
      ? Response.json({ results: [searchResult] })
      : Response.json({ title: searchResult.title, content: '# Fetched evidence' }));
    vi.stubGlobal('fetch', fetchImpl);
    const requestContext = new RequestContext();
    requestContext.set('huahuoUserJwt', 'caller-user-jwt');
    const context = { requestContext, abortSignal: new AbortController().signal };

    await expect(onlineSearch.execute!({ query: 'test', count: 1, localization: '', need_content: false }, context))
      .resolves.toEqual({ results: [searchResult] });
    await expect(urlFetch.execute!({ url: searchResult.url }, context))
      .resolves.toEqual({ title: searchResult.title, content: '# Fetched evidence' });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    for (const [, init] of fetchImpl.mock.calls) {
      expect(init?.headers).toEqual({ authorization: 'Bearer tool-deepseek-key', 'content-type': 'application/json' });
      expect(JSON.stringify(init)).not.toContain('caller-user-jwt');
    }
  });
});
