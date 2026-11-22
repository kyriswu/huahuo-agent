import { appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const repository = 'kyriswu/huahuo-agent';
const ciPath = '.github/workflows/agent-ci.yml';
const sha = /^[a-f0-9]{40}$/u;
const hostLabel = '[a-z0-9](?:[a-z0-9-]*[a-z0-9])?';
const registryPattern = new RegExp(`^${hostLabel}(?:\\.${hostLabel})*(?::[1-9][0-9]{0,4})?$`, 'u');
const imageComponent = /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*$/u;
const nativeRunners = new Map([
  ['linux/amd64', 'ubuntu-24.04'],
  ['linux/arm64', 'ubuntu-24.04-arm'],
]);

export async function resolveAgentImageSource(env = process.env, fetchImpl = fetch) {
  const sourceSha = env.AGENT_IMAGE_SOURCE_SHA ?? '';
  if (env.GITHUB_REPOSITORY !== repository || env.GITHUB_REF !== 'refs/heads/main'
    || env.GITHUB_EVENT_NAME !== 'workflow_dispatch' || env.GITHUB_REF_PROTECTED !== 'true'
    || !sha.test(env.GITHUB_SHA ?? '') || !sha.test(sourceSha)) {
    throw Error('AGENT_IMAGE_SOURCE_NOT_VERIFIED');
  }

  const imageRepository = env.AGENT_IMAGE_REPOSITORY ?? '';
  const [registry, ...path] = imageRepository.split('/');
  if (imageRepository.length > 255 || !registryPattern.test(registry)
    || (!registry.includes('.') && !registry.includes(':')) || !path.length
    || path.some(part => !imageComponent.test(part)) || Number(registry.split(':')[1]) > 65535) {
    throw Error('AGENT_IMAGE_REPOSITORY_INVALID');
  }
  const platform = env.AGENT_IMAGE_PLATFORM || 'linux/amd64';
  const nativeRunner = nativeRunners.get(platform);
  if (!nativeRunner) throw Error('AGENT_IMAGE_PLATFORM_INVALID');
  const runner = env.AGENT_ACR_BUILD_RUNNER || nativeRunner;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u.test(runner)) throw Error('AGENT_ACR_BUILD_RUNNER_INVALID');

  const token = env.GH_TOKEN;
  if (!token || /[\r\n]/u.test(token)) throw Error('AGENT_IMAGE_SOURCE_NOT_VERIFIED');
  const read = async path => {
    const response = await fetchImpl(`https://api.github.com/repos/${repository}${path}`, {
      headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000), redirect: 'error',
    });
    if (!response.ok) throw Error();
    return response.json();
  };

  try {
    const branch = await read('/branches/test');
    if (branch?.name !== 'test' || branch.protected !== true || branch.commit?.sha !== sourceSha) throw Error();
    const query = new URLSearchParams({ branch: 'test', event: 'push', status: 'success', head_sha: sourceSha, per_page: '10' });
    const result = await read(`/actions/workflows/agent-ci.yml/runs?${query}`);
    if (!Array.isArray(result?.workflow_runs) || !result.workflow_runs.some(run =>
      run?.head_sha === sourceSha && run.head_branch === 'test' && run.event === 'push'
      && run.status === 'completed' && run.conclusion === 'success' && run.path === ciPath
      && run.head_repository?.full_name === repository)) throw Error();
  } catch {
    throw Error('AGENT_IMAGE_SOURCE_NOT_VERIFIED');
  }

  return { source_sha: sourceSha, image_repository: imageRepository, registry, platform, runner };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const candidate = await resolveAgentImageSource();
    await appendFile(process.env.GITHUB_OUTPUT, Object.entries(candidate).map(([key, value]) => `${key}=${value}\n`).join(''));
  } catch (error) {
    const code = error?.message;
    console.error(['AGENT_IMAGE_REPOSITORY_INVALID', 'AGENT_IMAGE_PLATFORM_INVALID', 'AGENT_ACR_BUILD_RUNNER_INVALID'].includes(code)
      ? code : 'AGENT_IMAGE_SOURCE_NOT_VERIFIED');
    process.exitCode = 1;
  }
}
