import { readFile } from 'node:fs/promises';
export const REPOSITORY = 'kyriswu/huahuo-agent';
export const CI_PATH = '.github/workflows/agent-ci.yml';
export const isSha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
export function verifyCiTrigger(context, branch) {
  const run = context.trigger;
  if (!['main', 'test'].includes(branch) || context.repository !== REPOSITORY || context.eventName !== 'workflow_run'
    || context.ref !== 'refs/heads/main' || !isSha(context.controlSha) || !Number.isSafeInteger(run?.id) || run.id < 1
    || run.path !== CI_PATH || run.event !== 'push' || run.head_branch !== branch || run.status !== 'completed'
    || run.conclusion !== 'success' || run.head_repository?.full_name !== REPOSITORY || !isSha(run.head_sha)) {
    throw Error('RELEASE_CI_EVENT_NOT_VERIFIED');
  }
  return run;
}
export async function readReleaseEventContext(env = process.env) {
  const context = { repository: env.GITHUB_REPOSITORY, eventName: env.GITHUB_EVENT_NAME,
    ref: env.GITHUB_REF, controlSha: env.GITHUB_SHA, expectedTargetSha: env.TEST_RELEASE_SHA };
  if (context.eventName === 'workflow_run') {
    const raw = await readFile(env.GITHUB_EVENT_PATH, 'utf8');
    if (Buffer.byteLength(raw) > 1024 * 1024) throw Error('RELEASE_CI_EVENT_NOT_VERIFIED');
    context.trigger = JSON.parse(raw).workflow_run;
    context.expectedTargetSha ??= context.trigger?.head_sha;
  }
  return context;
}
export function githubReader(token, fetchImpl = fetch) {
  if (typeof token !== 'string' || !token || /[\r\n]/.test(token)) throw Error('RELEASE_GITHUB_READ_FAILED');
  return async resource => {
    const response = await fetchImpl(`https://api.github.com/repos/${REPOSITORY}${resource}`, {
      headers: { accept: 'application/vnd.github+json', authorization: 'Bearer ' + token },
      signal: AbortSignal.timeout(10000), redirect: 'error',
    });
    if (!response.ok) throw Error('RELEASE_GITHUB_READ_FAILED');
    return response.json();
  };
}
