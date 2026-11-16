import { describe, expect, it } from 'vitest';
// @ts-expect-error Release tooling uses dependency-free JavaScript.
import { prepareMainRelease } from '../../scripts/release/main-release-readiness.mjs';
const repo = 'kyriswu/huahuo-agent', sha = 'a'.repeat(40);
const run = () => ({ id: 17, path: '.github/workflows/agent-ci.yml', head_sha: sha, head_branch: 'main', event: 'push', status: 'completed', conclusion: 'success', head_repository: { full_name: repo } });
const context = () => ({ repository: repo, eventName: 'workflow_run', ref: 'refs/heads/main', controlSha: sha, trigger: run() });
const plan = () => ({ version: 1, id: 'ready-main', baseRevision: 'b'.repeat(40), services: ['agent'], database: { migrations: [] }, configuration: { changes: [{ key: 'PUBLIC_FEATURE', secretValue: 'synthetic-private-detail' }] } });
const read = async (path: string) => path.startsWith('/actions/runs/') ? run() : { ref: 'refs/heads/main', object: { type: 'commit', sha } };
describe('main readiness without production access', () => {
  it('prepares the exact main candidate while keeping production uninitialized and omitting values', async () => {
    const result = await prepareMainRelease(context(), plan(), read);
    expect(result).toMatchObject({ status: 'prepared', sha, productionConnected: false, productionBaseline: null, productionDeployment: 'not-executed', configurationKeys: ['PUBLIC_FEATURE'] });
    expect(JSON.stringify(result)).not.toContain('synthetic-private-detail');
  });
  it('skips stale main CI without touching a server', async () => {
    const c = context(); c.trigger.head_sha = 'c'.repeat(40);
    await expect(prepareMainRelease(c, plan(), async () => { throw Error('unexpected API'); })).resolves.toEqual({ status: 'skipped', reason: 'main-moved' });
  });
  it('refuses failed or test-branch CI and never prepares production deployment', async () => {
    for (const patch of [{ conclusion: 'failure' }, { head_branch: 'test' }, { event: 'pull_request' }]) {
      const c = context(); Object.assign(c.trigger, patch);
      await expect(prepareMainRelease(c, plan(), read)).rejects.toThrow();
    }
  });
  it('checks the exact CI run returned by GitHub', async () => {
    await expect(prepareMainRelease(context(), plan(), async () => ({ ...run(), id: 18 }))).rejects.toThrow('MAIN_RELEASE_PREPARATION_FAILED');
  });
});
