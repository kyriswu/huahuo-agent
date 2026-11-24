import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const deploy = fileURLToPath(new URL('../../scripts/kubernetes/deploy.sh', import.meta.url));
const repository = 'registry.example.invalid/huahuo/agent';
const digest = `sha256:${'1'.repeat(64)}`;

const fakeKubectl = String.raw`
const assert = require('node:assert/strict');
const { appendFileSync, readFileSync } = require('node:fs');
const { basename, join } = require('node:path');
const args = process.argv.slice(2);
const env = process.env;
for (const flag of [
  '--kubeconfig=' + env.KUBECONFIG,
  '--namespace=' + env.AGENT_K8S_NAMESPACE,
  '--context=' + env.AGENT_K8S_CONTEXT,
]) assert(args.includes(flag));
assert(args.some(arg => arg.startsWith('--cache-dir=')));
const commandIndex = args.findIndex(arg => !arg.startsWith('-'));
const command = args[commandIndex];
let action = command;
if (command === 'apply') {
  const filename = args[args.indexOf('-f') + 1];
  const name = basename(filename, '.yaml');
  const manifest = readFileSync(filename, 'utf8');
  assert.equal(manifest.includes('kind: NetworkPolicy'), name === 'policy');
  assert.equal(manifest.includes('kind: Deployment'), name === 'workload');
  assert(args.includes('--server-side'));
  action = (args.includes('--dry-run=server') ? 'dry-' : 'apply-') + name;
}
appendFileSync(env.FIXTURE_CALLS, action + '\n');
if (action === env.FIXTURE_FAILURE) {
  console.error('private-cluster-detail');
  process.exit(1);
}
if (command === 'config') {
  assert(args.includes('get-contexts'));
  process.stdout.write(env.FIXTURE_CONTEXT || env.AGENT_K8S_CONTEXT);
} else if (command === 'kustomize') {
  const overlay = args[commandIndex + 1];
  assert.equal(basename(overlay), env.FIXTURE_TARGET);
  const kustomization = readFileSync(join(overlay, 'kustomization.yaml'), 'utf8');
  assert(kustomization.includes('namespace: ' + env.AGENT_K8S_NAMESPACE));
  assert(kustomization.includes('newName: ' + env.AGENT_IMAGE_REPOSITORY));
  assert(kustomization.includes('digest: ' + env.FIXTURE_DIGEST));
  for (const kind of ['Service', 'Deployment', 'NetworkPolicy', 'ServiceAccount']) {
    const image = '  image: ' + env.FIXTURE_IMAGE;
    const name = kind === 'NetworkPolicy' ? 'huahuo-agent-ingress' : 'huahuo-agent';
    console.log('---\nkind: ' + kind + '\nmetadata:\n  name: ' + name +
      '\n  namespace: ' + (env.FIXTURE_RENDERED_NAMESPACE || env.AGENT_K8S_NAMESPACE) +
      (kind === 'Deployment' ? '\nspec:\n' + image + '\n' + image : ''));
  }
} else if (command === 'get') {
  assert(args.includes('deployment/huahuo-agent'));
  const image = env.FIXTURE_APPLIED_IMAGE || env.FIXTURE_IMAGE;
  console.log(image + '\n' + image);
} else if (command === 'rollout') {
  assert(args.some(arg => /^--timeout=\d+s$/.test(arg)));
} else if (command === 'exec') {
  assert.deepEqual(args.slice(args.indexOf('--') + 1), ['node', '/app/release/runtime-check.mjs']);
} else if (command !== 'apply') throw new Error('Unexpected kubectl action: ' + command);
`;

interface DeployFixture {
  target?: string;
  imageDigest?: string;
  overrides?: Record<string, string>;
}

function runDeploy({ target = 'test', imageDigest = digest, overrides = {} }: DeployFixture = {}) {
  const root = mkdtempSync(join(tmpdir(), 'agent-deploy-fixture-'));
  try {
    const kubeconfig = join(root, 'kubeconfig');
    const calls = join(root, 'calls');
    writeFileSync(kubeconfig, 'fixture kubeconfig', { mode: 0o600 });
    writeFileSync(calls, '');
    writeFileSync(join(root, 'kubectl'), `#!${process.execPath}\n${fakeKubectl}`, { mode: 0o700 });
    const result = spawnSync('bash', [deploy, target, imageDigest], {
      encoding: 'utf8', timeout: 10_000,
      env: {
        PATH: `${root}:${process.env.PATH ?? '/usr/bin:/bin'}`, KUBECONFIG: kubeconfig,
        AGENT_K8S_CONTEXT: 'fixture-context', AGENT_K8S_NAMESPACE: 'fixture-namespace',
        AGENT_IMAGE_REPOSITORY: repository, FIXTURE_CALLS: calls, FIXTURE_TARGET: target,
        FIXTURE_DIGEST: imageDigest, FIXTURE_IMAGE: `${repository}@${imageDigest}`, ...overrides,
      },
    });
    return { result, calls: readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean) };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

it.each(['test', 'production'])('deploys the %s overlay with policy in place before the workload', target => {
  const { result, calls } = runDeploy({ target });
  expect(result.status, result.stderr).toBe(0);
  expect(calls).toEqual(['config', 'kustomize', 'dry-policy', 'dry-workload', 'apply-policy', 'apply-workload', 'get', 'rollout', 'get', 'exec', 'get']);
  expect(result.stdout).toContain(`${repository}@${digest}`);
});

const invalidInputs: DeployFixture[] = [
  { imageDigest: 'latest' },
  { target: 'local' },
  { overrides: { AGENT_K8S_NAMESPACE: 'unsafe/namespace' } },
  { overrides: { AGENT_IMAGE_REPOSITORY: `${repository}:latest` } },
];

it.each(invalidInputs)('rejects invalid input before kubectl', options => {
  const { result, calls } = runDeploy(options);
  expect(result.status).toBe(1);
  expect(calls).toEqual([]);
});

it('stops on a missing selected kubeconfig context', () => {
  const { result, calls } = runDeploy({ overrides: { FIXTURE_CONTEXT: 'other-context' } });
  expect(result.stderr).toContain('AGENT_K8S_CONTEXT_UNKNOWN');
  expect(calls).toEqual(['config']);
});

it('rejects a rendered resource outside the selected namespace before server calls', () => {
  const { result, calls } = runDeploy({ overrides: { FIXTURE_RENDERED_NAMESPACE: 'other-namespace' } });
  expect(result.stderr).toContain('AGENT_K8S_RENDER_UNEXPECTED');
  expect(calls).toEqual(['config', 'kustomize']);
});

it('stops before applying anything after a workload dry-run failure and omits raw diagnostics', () => {
  const { result, calls } = runDeploy({ overrides: { FIXTURE_FAILURE: 'dry-workload' } });
  expect(result.stderr).toContain('AGENT_K8S_WORKLOAD_INVALID');
  expect(result.stderr).not.toContain('private-cluster-detail');
  expect(calls).toEqual(['config', 'kustomize', 'dry-policy', 'dry-workload']);
});

it('fails instead of rolling out if the server reports a different image', () => {
  const { result, calls } = runDeploy({ overrides: { FIXTURE_APPLIED_IMAGE: 'different-image' } });
  expect(result.stderr).toContain('AGENT_K8S_DEPLOYED_IMAGES_MISMATCH');
  expect(calls.at(-1)).toBe('get');
  expect(calls).not.toContain('rollout');
});

it('fails a runtime smoke without retrying or rolling back', () => {
  const { result, calls } = runDeploy({ overrides: { FIXTURE_FAILURE: 'exec' } });
  expect(result.stderr).toContain('AGENT_K8S_RUNTIME_SMOKE_FAILED');
  expect(result.stderr).not.toContain('private-cluster-detail');
  expect(calls.at(-1)).toBe('exec');
  expect(calls.filter(call => call === 'apply-workload')).toHaveLength(1);
});
