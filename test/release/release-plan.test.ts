import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
// @ts-expect-error Release tooling uses standalone JavaScript.
import { validateReleasePlan } from '../../scripts/release/release-plan.mjs';

const plan = () => JSON.parse(readFileSync(new URL('../../scripts/release/plan.json', import.meta.url), 'utf8'));
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
});
