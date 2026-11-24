import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error The runner invokes dependency-free JavaScript directly.
import { invokeCloudBuild, verifyCloudBuildOidc } from '../../scripts/kubernetes/invoke-agent-cloud-build.mjs';

const source = 'a'.repeat(40);
const main = 'b'.repeat(40);
const digest = `sha256:${'c'.repeat(64)}`;
const target = {
  AGENT_ACR_REGION_ID: 'cn-beijing',
  AGENT_BUILD_INSTANCE_ID: 'i-fixture',
  AGENT_BUILD_COMMAND_ID: 'c-fixture',
  AGENT_IMAGE_REPOSITORY: 'example-registry-vpc.cn-beijing.cr.aliyuncs.com/huahuo/agent',
  SOURCE_SHA: source,
};
const sts = {
  ...target,
  ALIBABA_CLOUD_ACCESS_KEY_ID: 'STS.fixture',
  ALIBABA_CLOUD_ACCESS_KEY_SECRET: 'fixture-secret',
  ALIBABA_CLOUD_SECURITY_TOKEN: 'fixture-token',
};
const validResult = {
  InstanceId: target.AGENT_BUILD_INSTANCE_ID,
  CommandId: target.AGENT_BUILD_COMMAND_ID,
  InvokeId: 't-fixture',
  InvocationStatus: 'Success',
  ExitCode: 0,
  Dropped: 0,
  Output: `AGENT_BUILD_RESULT ${target.AGENT_IMAGE_REPOSITORY} ${source} ${digest}\n`,
};
const result = (items: unknown[]) => ({ Invocation: { InvocationResults: { InvocationResult: items } } });
const fixture = (...results: unknown[]) => vi.fn()
  .mockResolvedValueOnce({ InvokeId: validResult.InvokeId })
  .mockImplementation(async () => results.shift());

describe('fixed Cloud Assistant Agent build', () => {
  it('tags one fixed invocation with the tested SHA and accepts the exact matching digest', async () => {
    const call = fixture(result([]), result([{ ...validResult, InvocationStatus: 'Running' }]), result([validResult]));
    const onSubmitted = vi.fn();
    await expect(invokeCloudBuild(sts, { call, onSubmitted, wait: async () => undefined })).resolves.toBe(digest);
    expect(call.mock.calls[0]?.slice(0, 3)).toEqual([
      'InvokeCommand', 'cn-beijing', [
        '--CommandId', 'c-fixture', '--InstanceId.1', 'i-fixture',
        '--RepeatMode', 'Once', '--Username', 'root', '--ClientToken', expect.stringMatching(/^[0-9a-f-]{36}$/u),
        '--Tag.1.Key', 'source-sha', '--Tag.1.Value', source,
      ],
    ]);
    expect(call.mock.calls.slice(1).map(([action]) => action)).toEqual(Array(3).fill('DescribeInvocationResults'));
    expect(call.mock.calls[1]?.[2]).toEqual([
      '--CommandId', 'c-fixture', '--InstanceId', 'i-fixture', '--InvokeId', 't-fixture',
      '--ContentEncoding', 'PlainText', '--MaxResults', '1',
    ]);
    expect(onSubmitted).toHaveBeenCalledExactlyOnceWith('t-fixture');
  });

  it.each([
    [{ InstanceId: 'i-moved' }, 'RESULT_MISMATCH'],
    [{ InvokeId: 't-other' }, 'RESULT_MISMATCH'],
    [{ CommandId: 'c-other' }, 'RESULT_MISMATCH'],
    [{ InvocationStatus: 'Failed', ExitCode: 1 }, 'BUILD_FAILED'],
    [{ InvocationStatus: 'Failed', ExitCode: 1, Output: 'AGENT_BUILD_ERROR ACR_AUTH_FAILED\n' }, 'REMOTE_ACR_AUTH_FAILED'],
    [{ Dropped: 1 }, 'OUTPUT_INVALID'],
    [{ Output: validResult.Output.repeat(2) }, 'OUTPUT_INVALID'],
    [{ Output: `AGENT_BUILD_RESULT registry.example.com/wrong/repo ${source} ${digest}\n` }, 'REPOSITORY_MISMATCH'],
    [{ Output: `AGENT_BUILD_RESULT ${target.AGENT_IMAGE_REPOSITORY} ${main} ${digest}\n` }, 'SOURCE_MISMATCH'],
  ])('rejects a failed, malformed, or nonmatching result (%j)', async (patch, code) => {
    const call = fixture(result([{ ...validResult, ...patch }]));
    await expect(invokeCloudBuild(sts, { call })).rejects.toThrow(`AGENT_BUILD_CLOUD_${code}`);
  });

  it('rejects long-lived credentials and never retries an ambiguous submission', async () => {
    const call = vi.fn().mockRejectedValue(Error('server may have received the submission'));
    await expect(invokeCloudBuild({ ...sts, ALIBABA_CLOUD_ACCESS_KEY_ID: 'LTAI-example' }, { call })).rejects
      .toThrow('AGENT_BUILD_CLOUD_STS_REQUIRED');
    expect(call).not.toHaveBeenCalled();
    await expect(invokeCloudBuild(sts, { call })).rejects.toThrow('AGENT_BUILD_CLOUD_SUBMISSION_UNKNOWN');
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('bounds polling without starting another build when the invocation remains pending', async () => {
    let elapsed = 0;
    const call = vi.fn()
      .mockResolvedValueOnce({ InvokeId: 't-fixture' })
      .mockResolvedValue(result([]));
    await expect(invokeCloudBuild(sts, { call, now: () => elapsed, wait: async () => { elapsed += 25 * 60_000; } }))
      .rejects.toThrow('AGENT_BUILD_CLOUD_TIMEOUT');
    expect(call.mock.calls.map(([action]) => action)).toEqual(['InvokeCommand', 'DescribeInvocationResults']);
  });
});

describe('Cloud Assistant build OIDC precheck', () => {
  const repo = 'kyriswu/huahuo-agent';
  const env = {
    ...target,
    GITHUB_OIDC_PROVIDER_ARN: 'acs:ram::1472289886746775:oidc-provider/github-actions',
    GITHUB_OIDC_ROLE_ARN: 'acs:ram::1472289886746775:role/github-actions-release',
    GITHUB_REPOSITORY: repo,
    GITHUB_REF: 'refs/heads/main',
    GITHUB_REF_PROTECTED: 'true',
    GITHUB_SHA: main,
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    ACTIONS_ID_TOKEN_REQUEST_URL: 'https://pipelines.actions.githubusercontent.com/request',
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'fixture-request-token',
  };
  const claims = {
    iss: 'https://token.actions.githubusercontent.com',
    aud: 'sts.aliyuncs.com',
    sub: 'repo:kyriswu@5120703/huahuo-agent@1427064230:environment:test',
    repository: repo,
    ref: env.GITHUB_REF,
    sha: main,
    event_name: 'workflow_dispatch',
    workflow_ref: `${repo}/.github/workflows/agent-kubernetes-release.yml@refs/heads/main`,
  };
  const request = (patch = {}) => vi.fn(async () =>
    Response.json({ value: `header.${Buffer.from(JSON.stringify({ ...claims, ...patch })).toString('base64url')}.signature` }));

  it('accepts the protected main control revision and test environment', async () => {
    const fetch = request();
    await expect(verifyCloudBuildOidc(env, fetch)).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledWith(
      new URL('https://pipelines.actions.githubusercontent.com/request?audience=sts.aliyuncs.com'),
      expect.objectContaining({ redirect: 'error' }),
    );
  });

  it('rejects a different GitHub workflow and a role from another Alibaba Cloud account', async () => {
    await expect(verifyCloudBuildOidc(env, request({ workflow_ref: `${repo}/other.yml` })))
      .rejects.toThrow('AGENT_BUILD_CLOUD_OIDC_NOT_VERIFIED');
    const fetch = request();
    await expect(verifyCloudBuildOidc({ ...env, GITHUB_OIDC_ROLE_ARN: 'acs:ram::9876543210123456:role/github-actions-release' }, fetch))
      .rejects.toThrow('AGENT_BUILD_CLOUD_ROLE_INVALID');
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    { GITHUB_OIDC_PROVIDER_ARN: 'acs:ram::1472289886746775:oidc-provider/other' },
    {
      GITHUB_OIDC_PROVIDER_ARN: 'acs:ram::1234567890123456:oidc-provider/github-actions',
      GITHUB_OIDC_ROLE_ARN: 'acs:ram::1234567890123456:role/github-actions-release',
    },
    { GITHUB_OIDC_ROLE_ARN: 'acs:ram::1472289886746775:role/another-role' },
    { GITHUB_OIDC_ROLE_ARN: 'acs:ram::1472289886746775:role/github-actions-release\n' },
    { GITHUB_OIDC_ROLE_ARN: undefined },
  ])('requires the exact shared provider and release role (%j)', async (patch) => {
    const fetch = request();
    await expect(verifyCloudBuildOidc({ ...env, ...patch }, fetch)).rejects.toThrow('AGENT_BUILD_CLOUD_ROLE_INVALID');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('requires the immutable repository subject in the test environment', async () => {
    await expect(verifyCloudBuildOidc(env, request({ sub: `repo:${repo}:environment:test` })))
      .rejects.toThrow('AGENT_BUILD_CLOUD_OIDC_NOT_VERIFIED');
  });
});
