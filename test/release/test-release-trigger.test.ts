import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
// @ts-expect-error Release tooling uses dependency-free JavaScript.
import { testReleaseIntent, resolveTestReleaseTrigger } from '../../scripts/release/test-release-trigger.mjs';
const repo = 'kyriswu/huahuo-agent', control = 'a'.repeat(40), target = 'b'.repeat(40);
const context = () => ({ repository: repo, eventName: 'workflow_run', ref: 'refs/heads/main', controlSha: control, expectedTargetSha: target,
  trigger: { id: 17, path: '.github/workflows/agent-ci.yml', head_sha: target, head_branch: 'test', event: 'push', status: 'completed', conclusion: 'success', head_repository: { full_name: repo } } });
function fixture(files: { filename: string; previous_filename?: string }[]) {
  const pr = { number: 9, merged: true, merged_at: '2026-11-15T00:00:00Z', merge_commit_sha: target, changed_files: files.length,
    base: { ref: 'test', repo: { full_name: repo } }, head: { repo: { full_name: repo } } };
  const read = async (path: string) => path.includes('/commits/') ? [pr] : path.includes('/files?') ? files : pr;
  return { pr, read };
}
describe('native test deployment intent (read-only API fixtures)', () => {
  it('deploys a merged PR that updates the reviewed release plan', async () => {
    await expect(testReleaseIntent(context(), fixture([{ filename: 'scripts/release/plan.json' }, { filename: 'src/business.ts' }]).read))
      .resolves.toEqual({ deploy: true, reason: 'reviewed-release-plan' });
  });
  it('does not deploy documentation, skill ownership or the known control-flow sync', async () => {
    const f = fixture([{ filename: 'docs/release.md' }, { filename: '.github/CODEOWNERS' }, { filename: '.agents/skills/huahuo-release/SKILL.md' }, { filename: 'scripts/release/test-release-trigger.mjs' }, { filename: '.github/workflows/agent-ci.yml' }, { filename: 'scripts/release/release-plan.mjs' }, { filename: 'test/release/release-plan.test.ts' }]);
    await expect(testReleaseIntent(context(), f.read)).resolves.toEqual({ deploy: false, reason: 'no-application-change' });
  });
  it('skips a release control sync while checking its rename source for application changes', async () => {
    const files = [{ filename: 'scripts/release/test-release-source.mjs' }, { filename: 'test/release/test-release-source.test.ts' }];
    await expect(testReleaseIntent(context(), fixture(files).read)).resolves.toEqual({ deploy: false, reason: 'no-application-change' });
    await expect(testReleaseIntent(context(), fixture([{ ...files[0], previous_filename: 'src/business.ts' }, files[1]]).read))
      .rejects.toThrow('TEST_RELEASE_PLAN_UPDATE_REQUIRED');
  });
  it.each(['src/business.ts', 'compose.yaml', '.env.example', 'package.json', 'migrations/0003_new.sql', 'scripts/release/unknown.mjs'])('requires an updated plan for %s', async filename => {
    await expect(testReleaseIntent(context(), fixture([{ filename }]).read)).rejects.toThrow('TEST_RELEASE_PLAN_UPDATE_REQUIRED');
  });
  it('does not hide application deletion behind a rename into a known control path', async () => {
    await expect(testReleaseIntent(context(), fixture([{ filename: 'scripts/release/release-plan.mjs', previous_filename: 'src/business.ts' }]).read)).rejects.toThrow('TEST_RELEASE_PLAN_UPDATE_REQUIRED');
  });
  it('does not hide application deletion behind a rename into docs', async () => {
    await expect(testReleaseIntent(context(), fixture([{ filename: 'docs/moved.ts', previous_filename: 'src/business.ts' }]).read)).rejects.toThrow('TEST_RELEASE_PLAN_UPDATE_REQUIRED');
  });
  it('fails closed for incomplete file lists', async () => {
    const f = fixture([{ filename: 'docs/a.md' }]); f.pr.changed_files = 2;
    await expect(testReleaseIntent(context(), f.read)).rejects.toThrow('TEST_RELEASE_FILE_LIST_INCOMPLETE');
  });
  it('requires the PR to have merged into this repository test at the exact triggering SHA', async () => {
    const f = fixture([{ filename: 'scripts/release/plan.json' }]); f.pr.merge_commit_sha = control;
    await expect(testReleaseIntent(context(), f.read)).rejects.toThrow('TEST_RELEASE_MERGED_PR_REQUIRED');
  });
  it('preserves explicit manual recovery without pretending it is a CI event', async () => {
    await expect(testReleaseIntent({ eventName: 'workflow_dispatch' }, async () => { throw Error(); })).resolves.toEqual({ deploy: true, reason: 'explicit-dispatch' });
  });
  it('verifies source/CI before deciding to skip; never requests cloud credentials', async () => {
    const c = context(), f = fixture([{ filename: 'docs/a.md' }]), urls: string[] = [];
    const request = async (url: string) => {
      urls.push(url);
      return { ok: true, json: async () => url.endsWith('/main') ? { ref: 'refs/heads/main', object: { type: 'commit', sha: control } }
        : url.endsWith('/test') ? { ref: 'refs/heads/test', object: { type: 'commit', sha: target } }
          : url.includes('/actions/workflows/') ? { workflow_runs: [c.trigger] }
            : f.read(url.replace('https://api.github.com/repos/' + repo, '')) };
    };
    await expect(resolveTestReleaseTrigger(c, 'synthetic-token', request)).resolves.toMatchObject({ deploy: false, targetSha: target });
    expect(urls.every(url => url.startsWith('https://api.github.com/repos/' + repo + '/'))).toBe(true);
  });
});

describe('reviewed plan versus deployment permission', () => {
  const plan = () => {
    const p = JSON.parse(readFileSync(new URL('../../scripts/release/plan.json', import.meta.url), 'utf8'));
    p.compatibility = { database: true, api: true, configuration: true, skills: true };
    return p;
  };
  function requestFor(value: unknown) {
    const c = context(), f = fixture([{ filename: 'scripts/release/plan.json' }]), urls: string[] = [];
    const bytes = Buffer.from(JSON.stringify(value));
    const file = { type: 'file', path: 'scripts/release/plan.json', encoding: 'base64', content: bytes.toString('base64'), size: bytes.length };
    const request = async (url: string) => {
      urls.push(url);
      return { ok: true, json: async () => url.endsWith('/main') ? { ref: 'refs/heads/main', object: { type: 'commit', sha: control } }
        : url.endsWith('/test') ? { ref: 'refs/heads/test', object: { type: 'commit', sha: target } }
          : url.includes('/actions/workflows/') ? { workflow_runs: [c.trigger] }
            : url.includes('/contents/') ? file : f.read(url.replace('https://api.github.com/repos/' + repo, '')) };
    };
    return { request, urls, file };
  }
  it('defers an incompatible exact-SHA candidate without requesting cloud credentials', async () => {
    const p = plan(); p.compatibility.api = false;
    const f = requestFor(p);
    await expect(resolveTestReleaseTrigger(context(), 'fixture', f.request)).resolves.toMatchObject({ deploy: false, deferred: true, reason: 'incompatible-candidate', targetSha: target });
    expect(f.urls.at(-1)).toBe(`https://api.github.com/repos/${repo}/contents/scripts/release/plan.json?ref=${target}`);
    expect(f.urls.every(url => url.startsWith(`https://api.github.com/repos/${repo}/`))).toBe(true);
  });
  it('allows a reviewed compatible candidate and preserves the normal intent', async () => {
    const f = requestFor(plan());
    await expect(resolveTestReleaseTrigger(context(), 'fixture', f.request)).resolves.toMatchObject({ deploy: true, reason: 'reviewed-release-plan' });
  });
  it('keeps ordinary manual recovery strict even after CI review succeeds', async () => {
    const p = plan(); p.compatibility.api = false;
    const f = requestFor(p);
    await expect(resolveTestReleaseTrigger({ ...context(), eventName: 'workflow_dispatch' }, 'fixture', f.request)).rejects.toThrow('TEST_RELEASE_PLAN_INVALID');
  });
  it.each([{ api: 'false' }, { api: null }, { api: undefined }])('fails closed for a malformed compatibility decision %j', async patch => {
    const p = plan(); Object.assign(p.compatibility, patch); const f = requestFor(p);
    await expect(resolveTestReleaseTrigger(context(), 'fixture', f.request)).rejects.toThrow('TEST_RELEASE_PLAN_INVALID');
  });
  it.each([{ type: 'symlink' }, { encoding: 'none' }, { size: 65537 }, { size: 1 }, { path: '.env' }, { content: 'not base64' }])('rejects invalid or oversized content metadata %j', async patch => {
    const f = requestFor(plan()); Object.assign(f.file, patch);
    await expect(resolveTestReleaseTrigger(context(), 'fixture', f.request)).rejects.toThrow('TEST_RELEASE_PLAN_INVALID');
  });
});
