import { pathToFileURL } from 'node:url';

// Fixed local process check. No model, SMS, session refresh or customer data.
export async function smoke(fetchImpl = fetch, port = '4111') {
  if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw Error('AGENT_HEALTH_FAILED');
  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}/health`, {
      method: 'GET', redirect: 'error', signal: AbortSignal.timeout(4000),
    });
    if (response.status !== 200) throw Error();
    const reader = response.body?.getReader();
    if (!reader) throw Error();
    const chunks = []; let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.length; if (size > 4096) throw Error(); chunks.push(value);
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    const result = JSON.parse(Buffer.concat(chunks).toString());
    if (result.success !== true) throw Error();
    return { check: 'agent-health', status: 'passed', scope: 'http-process-only' };
  } catch { throw Error('AGENT_HEALTH_FAILED'); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(await smoke(fetch, process.env.PORT ?? '4111'))); }
  catch { console.error('AGENT_HEALTH_FAILED'); process.exitCode = 1; }
}
