import { appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { readReleaseEventContext, verifyCiTrigger } from './release-events.mjs';

const REPOSITORY = 'kyriswu/huahuo-agent';
const WORKFLOW_PATH = '.github/workflows/agent-ci.yml';
const SHA = /^[a-f0-9]{40}$/;
const failed = () => { throw new Error('TEST_RELEASE_SOURCE_NOT_VERIFIED'); };

function validateContext(context) {
  if (context.repository !== REPOSITORY || !['workflow_dispatch', 'workflow_run'].includes(context.eventName)
    || context.ref !== 'refs/heads/main' || !SHA.test(context.controlSha ?? '')
    || (context.expectedTargetSha !== undefined && !SHA.test(context.expectedTargetSha))) failed();
  if (context.eventName === 'workflow_run') {
    try { verifyCiTrigger(context, 'test'); } catch { failed(); }
    if (context.expectedTargetSha !== context.trigger.head_sha) failed();
  }
}

/** main supplies trusted control code; only the tested test SHA is deployed. */
export function selectTestReleaseRevision(context, { mainRef, testRef, ciRuns }) {
  validateContext(context);
  if (mainRef?.ref !== 'refs/heads/main' || mainRef.object?.type !== 'commit' || mainRef.object.sha !== context.controlSha
    || testRef?.ref !== 'refs/heads/test' || testRef.object?.type !== 'commit' || !SHA.test(testRef.object.sha ?? '')
    || (context.expectedTargetSha !== undefined && testRef.object.sha !== context.expectedTargetSha)) failed();
  if (!Array.isArray(ciRuns?.workflow_runs) || !ciRuns.workflow_runs.some(run =>
    run?.head_sha === testRef.object.sha && run.head_branch === 'test' && run.event === 'push'
    && run.status === 'completed' && run.conclusion === 'success' && run.path === WORKFLOW_PATH
    && run.head_repository?.full_name === REPOSITORY
    && (context.eventName !== 'workflow_run' || run.id === context.trigger.id))) failed();
  return { controlSha: context.controlSha, targetSha: testRef.object.sha };
}

/** Signature verification remains the responsibility of Alibaba STS. */
export function verifyTestReleaseOidcClaims(claims, controlSha, eventName = 'workflow_dispatch') {
  if (!['workflow_dispatch', 'workflow_run'].includes(eventName) || !SHA.test(controlSha ?? '') || claims?.iss !== 'https://token.actions.githubusercontent.com'
    || claims.aud !== 'sts.aliyuncs.com'
    || claims.sub !== 'repo:kyriswu@5120703/huahuo-agent@1427064230:environment:test'
    || claims.ref !== 'refs/heads/main' || claims.repository !== REPOSITORY
    || claims.event_name !== eventName || claims.sha !== controlSha) {
    throw new Error('TEST_RELEASE_OIDC_NOT_VERIFIED');
  }
}

export async function resolveTestReleaseRevision(context, token, fetchImpl = fetch) {
  try {
    validateContext(context);
    if (typeof token !== 'string' || !token || /[\r\n]/.test(token)) failed();
    const read = async path => {
      const response = await fetchImpl(`https://api.github.com/repos/${REPOSITORY}${path}`, {
        headers: { accept: 'application/vnd.github+json', authorization: 'Bearer ' + token },
        signal: AbortSignal.timeout(10000), redirect: 'error',
      });
      if (!response.ok) failed();
      return response.json();
    };
    const [mainRef, testRef] = await Promise.all([read('/git/ref/heads/main'), read('/git/ref/heads/test')]);
    // Validate both refs before constructing the CI query, so a ref value can
    // never become an arbitrary URL or request parameter.
    if (mainRef?.ref !== 'refs/heads/main' || mainRef.object?.type !== 'commit' || mainRef.object.sha !== context.controlSha
      || testRef?.ref !== 'refs/heads/test' || testRef.object?.type !== 'commit' || !SHA.test(testRef.object.sha ?? '')) failed();
    const ciRuns = await read(`/actions/workflows/agent-ci.yml/runs?branch=test&event=push&status=success&head_sha=${testRef.object.sha}&per_page=10`);
    return selectTestReleaseRevision(context, { mainRef, testRef, ciRuns });
  } catch { failed(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await resolveTestReleaseRevision(await readReleaseEventContext(), process.env.GH_TOKEN);
    if (!process.env.GITHUB_ENV) failed();
    await appendFile(process.env.GITHUB_ENV, `TEST_RELEASE_SHA=${result.targetSha}\n`);
    console.log('Protected main control and exact tested test revision verified.');
  } catch {
    console.error('::error::TEST_RELEASE_SOURCE_NOT_VERIFIED');
    process.exitCode = 1;
  }
}
