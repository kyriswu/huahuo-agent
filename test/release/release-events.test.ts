import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error Release tooling uses dependency-free JavaScript.
import { readReleaseEventContext, verifyCiTrigger } from '../../scripts/release/release-events.mjs';
const controlSha = 'a'.repeat(40), targetSha = 'b'.repeat(40);
const run = () => ({ id: 17, path: '.github/workflows/agent-ci.yml', head_sha: targetSha, head_branch: 'test', event: 'push', status: 'completed', conclusion: 'success', head_repository: { full_name: 'kyriswu/huahuo-agent' } });
const context = () => ({ repository: 'kyriswu/huahuo-agent', ref: 'refs/heads/main', controlSha, eventName: 'workflow_run', trigger: run() });
describe('native CI trigger boundary (local payloads only)', () => {
  it('keeps the default-main control SHA separate from the successful test SHA', () => {
    expect(verifyCiTrigger(context(), 'test').head_sha).toBe(targetSha);
  });
  it.each([
    { event: 'pull_request' }, { head_branch: 'main' }, { conclusion: 'failure' }, { status: 'in_progress' },
    { path: '.github/workflows/other.yml' }, { id: -1 }, { head_sha: 'test' },
    { head_repository: { full_name: 'fork/huahuo-agent' } },
  ])('rejects untrusted CI metadata %j', patch => {
    const c = context(); Object.assign(c.trigger, patch);
    expect(() => verifyCiTrigger(c, 'test')).toThrow('RELEASE_CI_EVENT_NOT_VERIFIED');
  });
  it('does not grant automatic release to a test-side workflow or direct push', () => {
    expect(() => verifyCiTrigger({ ...context(), ref: 'refs/heads/test' }, 'test')).toThrow();
    expect(() => verifyCiTrigger({ ...context(), eventName: 'push' }, 'test')).toThrow();
  });
  it('reads the GitHub payload and preserves an already locked target', async () => {
    const root = await mkdtemp(join(tmpdir(), 'huahuo-ci-event-'));
    try {
      const path = join(root, 'event.json'); await writeFile(path, JSON.stringify({ workflow_run: run() }));
      const env = { GITHUB_REPOSITORY: 'kyriswu/huahuo-agent', GITHUB_REF: 'refs/heads/main', GITHUB_SHA: controlSha, GITHUB_EVENT_NAME: 'workflow_run', GITHUB_EVENT_PATH: path };
      expect((await readReleaseEventContext(env)).expectedTargetSha).toBe(targetSha);
      expect((await readReleaseEventContext({ ...env, TEST_RELEASE_SHA: 'c'.repeat(40) })).expectedTargetSha).toBe('c'.repeat(40));
      await writeFile(path, 'x'.repeat(1024 * 1024 + 1));
      await expect(readReleaseEventContext(env)).rejects.toThrow('RELEASE_CI_EVENT_NOT_VERIFIED');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
