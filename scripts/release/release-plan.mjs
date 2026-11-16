import { readFileSync, realpathSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const fail = () => { throw Error('AGENT_RELEASE_PLAN_INVALID'); };

/** Review may record an incompatible candidate without granting deployment. */
export function reviewReleasePlan(plan) {
  if (plan?.version !== 1 || !/^[a-z0-9][a-z0-9-]{2,63}$/.test(plan.id ?? '')
    || (plan.baseRevision !== null && !sha(plan.baseRevision))
    || JSON.stringify(plan.services) !== '["agent"]'
    || !Array.isArray(plan.database?.migrations) || plan.database.migrations.length !== 0
    || plan.database.mastraStorage !== 'framework-managed' || plan.database.dataChange !== 'none'
    || !['reuse', 'candidate'].includes(plan.configuration?.mode)
    || !Array.isArray(plan.configuration.reviewedFiles) || !plan.configuration.reviewedFiles.length
    || plan.configuration.reviewedFiles.some(file => typeof file !== 'string' || !/^[A-Za-z0-9_.\-/]+$/.test(file)
      || file.startsWith('/') || file.split('/').some(part => !part || part === '.' || part === '..'))
    || !Array.isArray(plan.configuration.changes)
    || plan.configuration.changes.some(change => !/^[A-Z][A-Z0-9_]{0,127}$/.test(change.key ?? '')
      || !['add', 'change', 'remove'].includes(change.operation) || typeof change.required !== 'boolean')
    || !['health'].includes(plan.smoke)
    || ['database', 'api', 'configuration', 'skills'].some(key => typeof plan.compatibility?.[key] !== 'boolean')
    || Object.keys(plan.compatibility).some(key => !['database', 'api', 'configuration', 'skills'].includes(key))) fail();
  if (new Set(plan.configuration.changes.map(change => change.key)).size !== plan.configuration.changes.length) fail();
  if (new Set(plan.configuration.reviewedFiles).size !== plan.configuration.reviewedFiles.length) fail();
  if (plan.configuration.changes.some(change => change.operation === 'change') && !plan.configuration.verifyFile) fail();
  if (plan.configuration.verifyFile !== undefined
    && plan.configuration.verifyFile !== `scripts/release/changes/${plan.id}/verify-config.mjs`) fail();
  return plan;
}

export function validateReleasePlan(plan) {
  const reviewed = reviewReleasePlan(plan);
  if (Object.values(reviewed.compatibility).some(value => value !== true)) fail();
  return reviewed;
}

function inspectReleasePlan(root, validate, requireAncestor) {
  try {
    root = realpathSync(root);
    const git = args => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    if (realpathSync(git(['rev-parse', '--show-toplevel'])) !== root
      || git(['status', '--porcelain', '--untracked-files=all'])) fail();
    const plan = validate(JSON.parse(readFileSync(resolve(root, 'scripts/release/plan.json'), 'utf8')));
    for (const file of [...plan.configuration.reviewedFiles, ...(plan.configuration.verifyFile ? [plan.configuration.verifyFile] : [])]) {
      const actual = relative(root, realpathSync(resolve(root, file)));
      if (isAbsolute(actual) || actual.startsWith('..')) fail();
      readFileSync(resolve(root, file));
    }
    if (plan.baseRevision !== null) {
      git(['rev-parse', '--verify', `${plan.baseRevision}^{commit}`]);
      // main may contain a squash of a deployed test merge. Review compares the
      // actual deployed tree; only the ordinary test deploy requires ancestry.
      if (requireAncestor) git(['merge-base', '--is-ancestor', plan.baseRevision, 'HEAD']);
      // These older standalone RAG migrations are not the Mastra runtime schema.
      // A shared-state change needs a separate, explicitly reviewed migration.
      if (git(['diff', '--name-only', plan.baseRevision, 'HEAD', '--', 'migrations/'])) fail();
      const configFiles = git(['diff', '--name-only', plan.baseRevision, 'HEAD', '--',
        '.env.example', 'compose.yaml', 'Dockerfile', 'src/studio/config.ts', 'src/server/base-url.ts', 'src/mastra/config.ts']);
      if (configFiles && configFiles.split('\n').some(file => !plan.configuration.reviewedFiles.includes(file))) fail();
    }
    return plan;
  } catch { fail(); }
}

export const checkReleasePlan = (root = process.cwd()) => inspectReleasePlan(root, validateReleasePlan, true);
export const checkReleaseReview = (root = process.cwd()) => inspectReleasePlan(root, reviewReleasePlan, false);

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2), review = args[0] === '--review';
    if (review) args.shift();
    if (args.length > 1 || args[0]?.startsWith('-')) fail();
    const plan = (review ? checkReleaseReview : checkReleasePlan)(args[0] ?? process.cwd());
    console.log(JSON.stringify({ status: review ? 'reviewed' : 'passed', deploymentReady: Object.values(plan.compatibility).every(value => value === true), planId: plan.id, baseRevision: plan.baseRevision,
      services: plan.services, mastraStorage: plan.database.mastraStorage, smoke: plan.smoke }));
  } catch { console.error('AGENT_RELEASE_PLAN_INVALID'); process.exitCode = 1; }
}
