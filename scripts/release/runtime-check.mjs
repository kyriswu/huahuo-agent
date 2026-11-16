import { pathToFileURL } from 'node:url';
import { smoke } from './smoke.mjs';

/** Fixed local checks; the protected request must stop before resource access. */
export async function runtimeCheck(fetchImpl = fetch, port = '4111') {
  await smoke(fetchImpl, port);
  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}/api/agents`, {
      method: 'GET', redirect: 'error', signal: AbortSignal.timeout(4000),
    });
    await response.body?.cancel();
    if (response.status !== 401) throw Error();
    return { check: 'agent-runtime', status: 'passed', scope: 'http-health-and-anonymous-denial' };
  } catch { throw Error('AGENT_RUNTIME_CHECK_FAILED'); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(await runtimeCheck(fetch, process.env.PORT ?? '4111'))); }
  catch { console.error('AGENT_RUNTIME_CHECK_FAILED'); process.exitCode = 1; }
}
