import { appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolveTestReleaseRevision } from './test-release-source.mjs';
import { githubReader, readReleaseEventContext, REPOSITORY, verifyCiTrigger } from './release-events.mjs';
const fail = code => { throw Error(code); };
const controlFiles = new Set([
  '.github/workflows/test-server-release.yml', '.github/workflows/main-release-readiness.yml',
  'scripts/release/release-events.mjs', 'scripts/release/test-release-source.mjs',
  'scripts/release/test-release-trigger.mjs', 'scripts/release/main-release-readiness.mjs',
  'scripts/release/test-publish.mjs', 'test/release/test-publish.test.ts',
  'test/release/test-release-source.test.ts', 'test/release/release-events.test.ts',
  'test/release/test-release-trigger.test.ts', 'test/release/main-release-readiness.test.ts',
]);
const noApplicationChange = path => controlFiles.has(path) || path.startsWith('docs/') || path.startsWith('.agents/skills/')
  || ['.github/CODEOWNERS', '.gitignore', 'AGENTS.md'].includes(path);

/** Read merged-PR changes, including rename sources; never run test code/artifacts. */
export async function testReleaseIntent(context, read) {
  if (context.eventName === 'workflow_dispatch') return { deploy: true, reason: 'explicit-dispatch' };
  const trigger = verifyCiTrigger(context, 'test');
  const target = context.expectedTargetSha;
  if (target !== trigger.head_sha) fail('TEST_RELEASE_SOURCE_NOT_VERIFIED');
  const pulls = await read(`/commits/${target}/pulls?per_page=100`);
  if (!Array.isArray(pulls)) fail('TEST_RELEASE_MERGED_PR_REQUIRED');
  const matches = pulls.filter(pr => Number.isSafeInteger(pr.number) && pr.number > 0
    && pr.base?.ref === 'test' && pr.merge_commit_sha === target && pr.merged_at);
  if (matches.length !== 1) fail('TEST_RELEASE_MERGED_PR_REQUIRED');
  const pr = await read(`/pulls/${matches[0].number}`);
  if (!pr.merged || pr.merge_commit_sha !== target || pr.base?.ref !== 'test' || pr.base.repo?.full_name !== REPOSITORY
    || pr.head?.repo?.full_name !== REPOSITORY || !Number.isSafeInteger(pr.changed_files) || pr.changed_files < 1) fail('TEST_RELEASE_MERGED_PR_REQUIRED');
  const files = [];
  for (let page = 1; page <= 30; page++) {
    const batch = await read(`/pulls/${pr.number}/files?per_page=100&page=${page}`);
    if (!Array.isArray(batch)) fail('TEST_RELEASE_FILE_LIST_INCOMPLETE');
    files.push(...batch);
    if (batch.length < 100) break;
  }
  if (files.length !== pr.changed_files || files.some(file => typeof file.filename !== 'string'
    || (file.previous_filename !== undefined && typeof file.previous_filename !== 'string'))) fail('TEST_RELEASE_FILE_LIST_INCOMPLETE');
  const paths = files.flatMap(file => [file.filename, ...(file.previous_filename ? [file.previous_filename] : [])]);
  if (paths.includes('scripts/release/plan.json')) return { deploy: true, reason: 'reviewed-release-plan' };
  if (paths.every(noApplicationChange)) return { deploy: false, reason: 'no-application-change' };
  fail('TEST_RELEASE_PLAN_UPDATE_REQUIRED');
}
export async function resolveTestReleaseTrigger(context, token, fetchImpl = fetch) {
  const revision = await resolveTestReleaseRevision(context, token, fetchImpl);
  const intent = await testReleaseIntent(context, githubReader(token, fetchImpl));
  return { ...revision, ...intent };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await resolveTestReleaseTrigger(await readReleaseEventContext(), process.env.GH_TOKEN);
    if (!process.env.GITHUB_ENV || !process.env.GITHUB_OUTPUT) fail('TEST_RELEASE_OUTPUT_REQUIRED');
    await appendFile(process.env.GITHUB_ENV, `TEST_RELEASE_SHA=${result.targetSha}\n`);
    await appendFile(process.env.GITHUB_OUTPUT, `deploy=${result.deploy}\n`);
    console.log(JSON.stringify({ status: result.deploy ? 'candidate-verified' : 'skipped', ...result }));
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY,
      `Test candidate: ${result.targetSha}\n\n${result.deploy ? 'CI/source verified; entering the existing five-stage release.' : 'No application change; no cloud command or deployment executed.'}\n`);
  } catch (error) {
    console.error(JSON.stringify({ status: 'failed', code: /^TEST_RELEASE_[A-Z_]+$/.test(error?.message) ? error.message : 'TEST_RELEASE_TRIGGER_FAILED' }));
    process.exitCode = 1;
  }
}
