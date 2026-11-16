import { appendFile, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { CI_PATH, REPOSITORY, isSha, githubReader, readReleaseEventContext, verifyCiTrigger } from './release-events.mjs';
const failed = () => { throw Error('MAIN_RELEASE_PREPARATION_FAILED'); };
export async function prepareMainRelease(context, plan, read) {
  if (context.repository !== REPOSITORY || context.ref !== 'refs/heads/main' || !isSha(context.controlSha)) failed();
  if (context.eventName === 'workflow_run') {
    const trigger = verifyCiTrigger(context, 'main');
    if (trigger.head_sha !== context.controlSha) return { status: 'skipped', reason: 'main-moved' };
    const run = await read(`/actions/runs/${trigger.id}`);
    verifyCiTrigger({ ...context, trigger: run }, 'main');
    if (run.id !== trigger.id || run.head_sha !== context.controlSha) failed();
  } else if (context.eventName === 'workflow_dispatch') {
    const result = await read(`/actions/workflows/agent-ci.yml/runs?branch=main&event=push&head_sha=${context.controlSha}&per_page=100`);
    const runs = result.workflow_runs?.filter(run => run.path === CI_PATH && run.head_sha === context.controlSha
      && run.head_branch === 'main' && run.event === 'push' && run.head_repository?.full_name === REPOSITORY).sort((a, b) => b.id - a.id);
    if (!runs?.length || runs[0].status !== 'completed' || runs[0].conclusion !== 'success') failed();
  } else failed();
  const ref = await read('/git/ref/heads/main');
  if (ref.ref !== 'refs/heads/main' || ref.object?.type !== 'commit') failed();
  if (ref.object.sha !== context.controlSha) return { status: 'skipped', reason: 'main-moved' };
  if (plan?.version !== 1 || !/^[a-z0-9][a-z0-9-]{2,63}$/.test(plan.id) || (plan.baseRevision !== null && !isSha(plan.baseRevision))
    || !Array.isArray(plan.services) || plan.services.some(role => !['agent'].includes(role))
    || !Array.isArray(plan.database?.migrations) || plan.database.migrations.some(file => !/^[0-9]{4}_[a-z0-9_]+\.sql$/.test(file))
    || !Array.isArray(plan.configuration?.changes) || plan.configuration.changes.some(change => !/^[A-Z][A-Z0-9_]{0,127}$/.test(change.key))) failed();
  return { status: 'prepared', sha: context.controlSha, planId: plan.id, services: plan.services,
    migrationCount: plan.database.migrations.length, configurationKeys: plan.configuration.changes.map(change => change.key),
    productionConnected: false, productionBaseline: null, productionDeployment: 'not-executed' };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const context = await readReleaseEventContext();
    const plan = JSON.parse(await readFile('scripts/release/plan.json', 'utf8'));
    const result = await prepareMainRelease(context, plan, githubReader(process.env.GH_TOKEN));
    console.log(JSON.stringify(result));
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `prepared=${result.status === 'prepared'}\n`);
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY,
      result.status === 'prepared' ? `Main candidate prepared: ${result.sha}\n\nPlan: ${result.planId}; migrations: ${result.migrationCount}.\n\nProduction is not connected; no production credentials, migration or container command executed. Production baseline remains uninitialized.\n`
        : 'Stale main CI skipped; no production operation executed.\n');
  } catch { console.error('::error::MAIN_RELEASE_PREPARATION_FAILED'); process.exitCode = 1; }
}
