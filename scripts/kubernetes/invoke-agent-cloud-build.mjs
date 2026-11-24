import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const repository = 'kyriswu/huahuo-agent';
const workflowRef = `${repository}/.github/workflows/agent-kubernetes-release.yml@refs/heads/main`;
const expectedSubject = 'repo:kyriswu@5120703/huahuo-agent@1427064230:environment:test';
const expectedProviderArn = 'acs:ram::1472289886746775:oidc-provider/github-actions';
const expectedRoleArn = 'acs:ram::1472289886746775:role/github-actions-release';
const shaPattern = /^[a-f0-9]{40}$/u;
const pending = new Set(['Pending', 'Running', 'Stopping']);
const totalTimeoutMs = 25 * 60_000;
const pollIntervalMs = 5_000;
const exec = promisify(execFile);
const remoteFailure = /^AGENT_BUILD_ERROR (HOST_CONFIG_INVALID|HOST_BUSY|INVOCATION_NOT_VERIFIED|SOURCE_NOT_VERIFIED|SOURCE_ARCHIVE_FAILED|RAM_AUTH_FAILED|ACR_AUTH_FAILED|IMAGE_BUILD_FAILED|IMAGE_DIGEST_INVALID|HOST_CLEANUP_FAILED)\r?\n?$/u;

function cloudBuildConfig(env) {
  const region = env.AGENT_ACR_REGION_ID ?? '';
  const instance = env.AGENT_BUILD_INSTANCE_ID ?? '';
  const command = env.AGENT_BUILD_COMMAND_ID ?? '';
  const sha = env.SOURCE_SHA ?? '';
  const imageRepository = env.AGENT_IMAGE_REPOSITORY ?? '';
  if (!/^[a-z][a-z0-9-]{1,39}$/u.test(region) || !/^i-[A-Za-z0-9]{5,80}$/u.test(instance)
    || !/^c-[A-Za-z0-9]{5,80}$/u.test(command) || !shaPattern.test(sha)) {
    throw Error('AGENT_BUILD_CLOUD_TARGET_INVALID');
  }
  if (imageRepository.length > 255 || !/^[a-z0-9][a-z0-9.-]*(?::[1-9][0-9]{0,4})?(?:\/[a-z0-9][a-z0-9._-]*)+$/u.test(imageRepository)) {
    throw Error('AGENT_BUILD_CLOUD_REPOSITORY_INVALID');
  }
  return { region, instance, command, sha, imageRepository };
}

export async function verifyCloudBuildOidc(env = process.env, fetchImpl = fetch) {
  cloudBuildConfig(env);
  if (env.GITHUB_OIDC_PROVIDER_ARN !== expectedProviderArn || env.GITHUB_OIDC_ROLE_ARN !== expectedRoleArn) {
    throw Error('AGENT_BUILD_CLOUD_ROLE_INVALID');
  }

  try {
    if (env.GITHUB_REPOSITORY !== repository || env.GITHUB_REF !== 'refs/heads/main'
      || env.GITHUB_REF_PROTECTED !== 'true' || env.GITHUB_EVENT_NAME !== 'workflow_dispatch'
      || !shaPattern.test(env.GITHUB_SHA ?? '') || !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) throw Error();
    const url = new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL);
    if (url.protocol !== 'https:' || !url.hostname.endsWith('.actions.githubusercontent.com')
      || url.username || url.password || url.port) throw Error();
    url.searchParams.set('audience', 'sts.aliyuncs.com');
    const response = await fetchImpl(url, {
      headers: { authorization: `Bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` },
      signal: AbortSignal.timeout(10_000), redirect: 'error',
    });
    if (!response.ok) throw Error();
    const { value } = await response.json();
    if (typeof value !== 'string' || value.length > 20_000 || value.split('.').length !== 3) throw Error();
    const claims = JSON.parse(Buffer.from(value.split('.')[1], 'base64url').toString('utf8'));
    // Alibaba STS verifies the token signature during the action's exchange.
    if (claims?.iss !== 'https://token.actions.githubusercontent.com' || claims.aud !== 'sts.aliyuncs.com'
      || claims.sub !== expectedSubject || claims.repository !== repository || claims.ref !== env.GITHUB_REF
      || claims.sha !== env.GITHUB_SHA || claims.event_name !== env.GITHUB_EVENT_NAME
      || claims.workflow_ref !== workflowRef) throw Error();
  } catch {
    throw Error('AGENT_BUILD_CLOUD_OIDC_NOT_VERIFIED');
  }
}

async function callEcs(action, region, args, timeout) {
  const { stdout } = await exec('aliyun', [
    'ecs', action, '--region', region, '--RegionId', region, '--retry-count', '0', '--yes', ...args,
  ], { timeout, maxBuffer: 65_536 });
  return JSON.parse(stdout);
}

export async function invokeCloudBuild(env = process.env, {
  call = callEcs, wait = delay, now = () => performance.now(), onSubmitted,
} = {}) {
  const { region, instance, command, sha, imageRepository } = cloudBuildConfig(env);
  if (!/^STS\.[A-Za-z0-9._-]{1,240}$/u.test(env.ALIBABA_CLOUD_ACCESS_KEY_ID ?? '')
    || !/^[\x21-\x7e]+$/u.test(env.ALIBABA_CLOUD_ACCESS_KEY_SECRET ?? '')
    || !/^[\x21-\x7e]+$/u.test(env.ALIBABA_CLOUD_SECURITY_TOKEN ?? '')) throw Error('AGENT_BUILD_CLOUD_STS_REQUIRED');

  const deadline = now() + totalTimeoutMs;
  const remaining = () => Math.max(0, deadline - now());
  const callTimeout = () => Math.max(1, Math.min(10_000, Math.floor(remaining())));
  let submitted;
  try {
    submitted = await call('InvokeCommand', region, [
      '--CommandId', command, '--InstanceId.1', instance, '--RepeatMode', 'Once', '--Username', 'root',
      '--ClientToken', randomUUID(),
      '--Tag.1.Key', 'source-sha', '--Tag.1.Value', sha,
    ], callTimeout());
  } catch {
    // Submission may already have reached ECS. Leave it for reconciliation.
    throw Error('AGENT_BUILD_CLOUD_SUBMISSION_UNKNOWN');
  }
  const invokeId = submitted?.InvokeId;
  if (typeof invokeId !== 'string' || !/^t-[A-Za-z0-9]{5,80}$/u.test(invokeId)) throw Error('AGENT_BUILD_CLOUD_RESPONSE_INVALID');
  onSubmitted?.(invokeId);

  while (remaining() > 0) {
    let response;
    try {
      response = await call('DescribeInvocationResults', region, [
        '--CommandId', command, '--InstanceId', instance, '--InvokeId', invokeId,
        '--ContentEncoding', 'PlainText', '--MaxResults', '1',
      ], callTimeout());
    } catch {
      throw Error('AGENT_BUILD_CLOUD_POLL_FAILED');
    }
    if (remaining() <= 0) break;

    const invocation = response?.Invocation;
    const items = invocation?.InvocationResults?.InvocationResult;
    if (!Array.isArray(items) || items.length > 1 || invocation.TotalCount > 1
      || invocation.NextToken || response.NextToken) throw Error('AGENT_BUILD_CLOUD_RESPONSE_INVALID');
    if (items.length) {
      const item = items[0];
      if (item?.InstanceId !== instance || item?.CommandId !== command || item?.InvokeId !== invokeId) {
        throw Error('AGENT_BUILD_CLOUD_RESULT_MISMATCH');
      }
      if (!pending.has(item.InvocationStatus)) {
        if (item.InvocationStatus !== 'Success' || item.ExitCode !== 0 || item.ErrorCode) {
          const failure = item.Dropped === 0 && typeof item.Output === 'string' && remoteFailure.exec(item.Output);
          throw Error(failure ? `AGENT_BUILD_CLOUD_REMOTE_${failure[1]}` : 'AGENT_BUILD_CLOUD_BUILD_FAILED');
        }
        const result = item.Dropped === 0 && typeof item.Output === 'string' && item.Output.length <= 512
          && /^AGENT_BUILD_RESULT ([a-z0-9._:/-]+) ([a-f0-9]{40}) (sha256:[a-f0-9]{64})\r?\n?$/u.exec(item.Output);
        if (!result) throw Error('AGENT_BUILD_CLOUD_OUTPUT_INVALID');
        if (result[1] !== imageRepository) throw Error('AGENT_BUILD_CLOUD_REPOSITORY_MISMATCH');
        if (result[2] !== sha) throw Error('AGENT_BUILD_CLOUD_SOURCE_MISMATCH');
        return result[3];
      }
    }
    await wait(Math.min(pollIntervalMs, remaining()));
  }
  throw Error('AGENT_BUILD_CLOUD_TIMEOUT');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv[2] === '--verify-oidc') {
      await verifyCloudBuildOidc();
    } else {
      const digest = await invokeCloudBuild(process.env, {
        onSubmitted: invokeId => console.log(`Cloud Assistant build invocation ${invokeId}`),
      });
      await appendFile(process.env.GITHUB_OUTPUT, `image_digest=${digest}\n`);
    }
  } catch (error) {
    console.error(/^AGENT_BUILD_CLOUD_[A-Z_]+$/u.test(error?.message ?? '') ? error.message : 'AGENT_BUILD_CLOUD_FAILED');
    process.exitCode = 1;
  }
}
