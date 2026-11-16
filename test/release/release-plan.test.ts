import { describe, expect, it } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
// @ts-expect-error Release tooling uses standalone JavaScript.
import { validateReleasePlan, reviewReleasePlan, checkReleasePlan, checkReleaseReview } from '../../scripts/release/release-plan.mjs';

// Validator fixtures represent a reviewed deployment; the working candidate can
// intentionally retain false compatibility gates until coordinated cutover.
const plan = () => {
  const value = JSON.parse(readFileSync(new URL('../../scripts/release/plan.json', import.meta.url), 'utf8'));
  value.compatibility = { database: true, api: true, configuration: true, skills: true };
  return value;
};
describe('Agent release plan', () => {
  it('records an uninitialized deployment separately from a Git head', () => {
    const initial = plan(); initial.baseRevision = null;
    expect(validateReleasePlan(initial).baseRevision).toBeNull();
    const next = plan(); next.baseRevision = 'a'.repeat(40);
    expect(validateReleasePlan(next).baseRevision).toBe(next.baseRevision);
  });
  it.each(['test', '', 'a'.repeat(39)])('rejects a mutable or invalid deployed base: %s', baseRevision => {
    expect(() => validateReleasePlan({ ...plan(), baseRevision })).toThrow('AGENT_RELEASE_PLAN_INVALID');
  });
  it('blocks unrelated runtime roles and standalone RAG database writes', () => {
    const p = plan(); p.services = ['worker']; expect(() => validateReleasePlan(p)).toThrow();
    p.services = ['agent']; p.database.migrations = ['0005_new.sql']; expect(() => validateReleasePlan(p)).toThrow();
  });
  it('requires compatibility review and a local assertion for changed configuration', () => {
    const p = plan(); delete p.configuration.verifyFile; expect(() => validateReleasePlan(p)).toThrow();
    const q = plan(); q.compatibility.database = false; expect(() => validateReleasePlan(q)).toThrow();
  });
  it('reviews declared incompatibility without granting deployment or accepting missing/mistyped decisions', () => {
    const p = plan(); p.compatibility.api = false;
    expect(reviewReleasePlan(p).compatibility.api).toBe(false);
    expect(() => validateReleasePlan(p)).toThrow();
    for (const patch of [{ api: 'false' }, { api: undefined }, { unknown: true }]) {
      expect(() => reviewReleasePlan({ ...p, compatibility: { ...p.compatibility, ...patch } })).toThrow();
    }
  });
  it('reviews only a complete clean commit and still rejects historical migration changes', () => {
    const root = mkdtempSync(join(tmpdir(), 'huahuo-agent-review-'));
    const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const put = (file: string, contents: string) => { mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), contents); };
    const commit = () => { git('add', '.'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'fixture'); };
    try {
      git('-c', 'init.templateDir=', 'init');
      const p = plan(); p.baseRevision = null; p.configuration.reviewedFiles = ['src/config.ts']; p.compatibility.api = false;
      put('src/config.ts', 'export {};\n'); put(p.configuration.verifyFile, '// fixture, never executed\n');
      put('migrations/0001_legacy.sql', 'SELECT 1;\n'); put('scripts/release/plan.json', JSON.stringify(p)); commit();
      p.baseRevision = git('rev-parse', 'HEAD'); put('scripts/release/plan.json', JSON.stringify(p)); commit();
      expect(checkReleaseReview(root).compatibility.api).toBe(false);
      expect(() => checkReleasePlan(root)).toThrow();
      put('untracked.txt', 'not reviewed'); expect(() => checkReleaseReview(root)).toThrow(); rmSync(join(root, 'untracked.txt'));
      put('src/config.ts', 'export const dirty = true;\n'); expect(() => checkReleaseReview(root)).toThrow();
      put('src/config.ts', 'export {};\n');
      // A main squash does not have the deployed test merge as an ancestor.
      const deployed = git('rev-parse', 'HEAD');
      git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'test merge');
      p.baseRevision = git('rev-parse', 'HEAD');
      git('checkout', '--detach', deployed); put('scripts/release/plan.json', JSON.stringify(p)); commit();
      expect(checkReleaseReview(root).baseRevision).toBe(p.baseRevision);
      const compatible = { ...p, compatibility: { database: true, api: true, configuration: true, skills: true } };
      put('scripts/release/plan.json', JSON.stringify(compatible)); commit();
      expect(() => checkReleasePlan(root)).toThrow();
      put('migrations/0001_legacy.sql', 'SELECT 2;\n'); commit(); expect(() => checkReleaseReview(root)).toThrow();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
