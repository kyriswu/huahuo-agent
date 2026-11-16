import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const fail = () => { throw Error('AGENT_RELEASE_PLAN_INVALID'); };

export function validateReleasePlan(plan) {
  if (plan?.version !== 1 || !/^[a-z0-9][a-z0-9-]{2,63}$/.test(plan.id ?? '')
    || (plan.baseRevision !== null && !sha(plan.baseRevision))
    || JSON.stringify(plan.services) !== '["agent"]'
    || !Array.isArray(plan.database?.migrations) || plan.database.migrations.length !== 0
    || plan.database.mastraStorage !== 'framework-managed' || plan.database.dataChange !== 'none'
    || !['reuse', 'candidate'].includes(plan.configuration?.mode)
    || !Array.isArray(plan.configuration.reviewedFiles) || !plan.configuration.reviewedFiles.length
    || plan.configuration.reviewedFiles.some(file => typeof file !== 'string' || file.startsWith('/') || file.split('/').includes('..'))
    || !Array.isArray(plan.configuration.changes)
    || plan.configuration.changes.some(change => !/^[A-Z][A-Z0-9_]{0,127}$/.test(change.key ?? '')
      || !['add', 'change', 'remove'].includes(change.operation) || typeof change.required !== 'boolean')
    || !['health'].includes(plan.smoke)
    || ['database', 'api', 'configuration', 'skills'].some(key => plan.compatibility?.[key] !== true)) fail();
  if (new Set(plan.configuration.changes.map(change => change.key)).size !== plan.configuration.changes.length) fail();
  if (plan.configuration.changes.some(change => change.operation === 'change') && !plan.configuration.verifyFile) fail();
  if (plan.configuration.verifyFile !== undefined
    && plan.configuration.verifyFile !== `scripts/release/changes/${plan.id}/verify-config.mjs`) fail();
  return plan;
}

export function checkReleasePlan(root = process.cwd()) {
  try {
    const plan = validateReleasePlan(JSON.parse(readFileSync(resolve(root, 'scripts/release/plan.json'), 'utf8')));
    const git = args => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    for (const file of [...plan.configuration.reviewedFiles, ...(plan.configuration.verifyFile ? [plan.configuration.verifyFile] : [])]) {
      readFileSync(resolve(root, file));
    }
    if (plan.baseRevision !== null) {
      git(['merge-base', '--is-ancestor', plan.baseRevision, 'HEAD']);
      // These older standalone RAG migrations are not the Mastra runtime schema.
      // A shared-state change needs a separate, explicitly reviewed migration.
      if (git(['diff', '--name-only', plan.baseRevision, 'HEAD', '--', 'migrations/'])) fail();
    }
    return plan;
  } catch { fail(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const plan = checkReleasePlan(process.argv[2] ?? process.cwd());
    console.log(JSON.stringify({ status: 'passed', planId: plan.id, baseRevision: plan.baseRevision,
      services: plan.services, mastraStorage: plan.database.mastraStorage, smoke: plan.smoke }));
  } catch { console.error('AGENT_RELEASE_PLAN_INVALID'); process.exitCode = 1; }
}
