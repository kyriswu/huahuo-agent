import { pathToFileURL } from 'node:url';

// Only the configured internal origin and these fixed, body-less GETs are used.
// No JWT, customer identity, session refresh, models or paid providers.
const paths = ['/health/ready', '/internal/v1/gateway/auth'];
export async function serverPreflight(baseUrl, fetchImpl = fetch) {
  try {
    const url = new URL(baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
      || url.pathname !== '/' || url.search || url.hash) throw Error();
    const signal = AbortSignal.timeout(8000);
    for (const path of paths) {
      const response = await fetchImpl(url.origin + path, {
        method: 'GET', redirect: 'error', signal,
        headers: { accept: 'application/json', 'cache-control': 'no-cache' },
      });
      const reader = response.body?.getReader();
      if (!reader) throw Error();
      const chunks = []; let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read(); if (done) break;
          size += value.length; if (size > 4096) throw Error(); chunks.push(value);
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      const body = JSON.parse(Buffer.concat(chunks).toString());
      if (path === '/health/ready') {
        if (response.status !== 200 || body.success !== true || body.data?.service !== 'api-server' || body.data?.status !== 'ready') throw Error();
      } else if (response.status !== 401 || body.success !== false || body.error?.code !== 'UNAUTHORIZED') throw Error();
    }
    return { check: 'server-admission', status: 'passed', scope: 'readiness-and-anonymous-auth-contract' };
  } catch { throw Error('AGENT_SERVER_PREFLIGHT_FAILED'); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(await serverPreflight(process.env.HUAHUO_SERVER_BASE_URL))); }
  catch { console.error('AGENT_SERVER_PREFLIGHT_FAILED'); process.exitCode = 1; }
}
