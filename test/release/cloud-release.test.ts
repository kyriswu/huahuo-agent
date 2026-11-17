import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error Release tooling deliberately uses plain JavaScript.
import { CloudReleaseError, createCloudReleaseClient, createCloudReleaseReporter, readCloudReleaseConfig, renderCloudReleaseSummary, runCloudRelease } from '../../scripts/release/invoke-cloud-release.mjs';

const { default: OpenApiClient } = createRequire(import.meta.url)('@alicloud/openapi-core') as typeof import('@alicloud/openapi-core');
const instanceId = 'i-2zegtoygiiked53yntmj', commandId = 'c-reviewedCommand123', invokeId = 't-fixtureInvocation123';
const sha = '0123456789abcdef0123456789abcdef01234567';
const accessKeyId = 'STS.release-fixture-only', accessKeySecret = 'private-cloud-secret-fixture', securityToken = 'private-cloud-security-token-fixture';
const privateOutput = 'private-remote-output-must-not-be-logged';
const env = () => ({
  TEST_RELEASE_REGION_ID: 'cn-beijing', TEST_RELEASE_INSTANCE_ID: instanceId, TEST_RELEASE_COMMAND_ID: commandId,
  TEST_RELEASE_SHA: sha, ALIBABA_CLOUD_ACCESS_KEY_ID: accessKeyId,
  ALIBABA_CLOUD_ACCESS_KEY_SECRET: accessKeySecret, ALIBABA_CLOUD_SECURITY_TOKEN: securityToken,
});
const marker = () => ({ version: 1, sha, stage: 'complete', status: 'passed', code: 'OK' });
const progress = (phase: number, status: string) => ({ version: 1, sha, event: 'progress', phase, status });
const completeProgress = () => [1, 2, 3, 4, 5].flatMap(phase => [progress(phase, 'running'), progress(phase, 'passed')]);
const jsonl = (...values: unknown[]) => values.map(value => JSON.stringify(value)).join('\n') + '\n';
const directories: string[] = [];
function directory() { const value = mkdtempSync(join(tmpdir(), 'huahuo-release-progress-')); directories.push(value); return value; }
const record = (change: Record<string, unknown> = {}) => ({
  InstanceId: instanceId, InvokeId: invokeId, CommandId: commandId, InvocationStatus: 'Success',
  ExitCode: 0, Dropped: 0, Output: JSON.stringify(marker()), ...change,
});
const response = (items: unknown[] = [record()]) => ({ Invocation: { InvocationResults: { InvocationResult: items } } });
type Call = (action: string, body: Record<string, unknown>, timeoutMs: number) => Promise<unknown>;
function setup(result: unknown = response(), variables: Record<string, string> = {}) {
  let time = 0;
  const call = vi.fn<Call>(async action => action === 'InvokeCommand' ? { InvokeId: invokeId } : result);
  return { config: readCloudReleaseConfig({ ...env(), TEST_RELEASE_TOTAL_TIMEOUT_MS: '100', TEST_RELEASE_POLL_INTERVAL_MS: '10', ...variables }),
    call, now: () => time, wait: vi.fn(async (milliseconds: number) => { time += milliseconds; }) };
}
function expectSanitized(value: unknown) {
  const output = JSON.stringify(value);
  for (const secret of [accessKeyId, accessKeySecret, securityToken, privateOutput]) expect(output).not.toContain(secret);
  expect(output.length).toBeLessThan(4096);
}
function cli(variables: Record<string, string>, preload?: string) {
  return new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [...(preload ? ['--import', preload] : []), 'scripts/release/invoke-cloud-release.mjs'], {
      cwd: process.cwd(), env: { PATH: process.env.PATH, ...variables }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks: Buffer[] = [];
    child.stdout.on('data', chunk => chunks.push(chunk)); child.stderr.on('data', chunk => chunks.push(chunk));
    child.once('error', reject); child.once('close', code => resolve({ code, output: Buffer.concat(chunks).toString() }));
  });
}
afterEach(() => { vi.restoreAllMocks(); for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe('reviewed cloud release command with local RPC fixtures only', () => {
  it('invokes the one fixed instance once with only the commit parameter and verifies the exact invocation', async () => {
    const s = setup();
    const result = await runCloudRelease(s.config, s);
    expect(result.status).toBe('passed'); expectSanitized(result);
    expect(s.call).toHaveBeenCalledTimes(2);
    const [action, body, timeout] = s.call.mock.calls[0]!;
    expect(action).toBe('InvokeCommand');
    expect(body).toEqual({ RegionId: 'cn-beijing', 'InstanceId.1': instanceId, CommandId: commandId,
      Parameters: JSON.stringify({ sha }), RepeatMode: 'Once', ClientToken: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/) });
    expect(timeout).toBeGreaterThan(0); expect(timeout).toBeLessThanOrEqual(10000);
    expect(s.call.mock.calls[1]?.slice(0, 2)).toEqual(['DescribeInvocationResults', {
      RegionId: 'cn-beijing', InstanceId: instanceId, InvokeId: invokeId, CommandId: commandId,
      ContentEncoding: 'PlainText', MaxResults: 1,
    }]);
  });

  it('polls a running invocation without resubmitting the command', async () => {
    const s = setup();
    s.call.mockResolvedValueOnce({ InvokeId: invokeId })
      .mockResolvedValueOnce(response([record({ InvocationStatus: 'Running', Output: '' })]))
      .mockResolvedValueOnce(response());
    expect((await runCloudRelease(s.config, s)).status).toBe('passed');
    expect(s.call.mock.calls.map(args => args[0])).toEqual(['InvokeCommand', 'DescribeInvocationResults', 'DescribeInvocationResults']);
    expect(s.wait).toHaveBeenCalledTimes(1);
  });

  it('reports an explicitly completed forced drain without claiming graceful completion', async () => {
    const s = setup(response([record({ Output: JSON.stringify({ ...marker(), code: 'OK_WITH_FORCED_DRAIN' }) })]));
    expect(await runCloudRelease(s.config, s)).toMatchObject({ status: 'passed', stage: 'complete', code: 'TEST_RELEASE_OK_WITH_FORCED_DRAIN' });
  });

  it('does not accept a forced-drain marker when the release has not completed', async () => {
    const s = setup(response([record({ Output: JSON.stringify({ ...marker(), stage: 'deploy', code: 'OK_WITH_FORCED_DRAIN' }) })]));
    expect((await runCloudRelease(s.config, s)).status).toBe('failed');
  });

  it.each([
    ['different instance', { InstanceId: 'i-not-the-authorized-instance' }],
    ['different invocation', { InvokeId: 't-anotherInvocation' }],
    ['different reviewed command', { CommandId: 'c-anotherCommand' }],
    ['nonzero exit', { ExitCode: 1 }], ['string exit', { ExitCode: '0' }],
    ['truncated output', { Dropped: 1 }], ['missing truncation field', { Dropped: undefined }],
    ['failed invocation', { InvocationStatus: 'Failed' }], ['stopped invocation', { InvocationStatus: 'Stopped' }],
    ['unknown invocation status', { InvocationStatus: 'NotARealStatus' }],
    ['unstructured output', { Output: privateOutput }], ['missing terminal marker', { Output: '{}' }],
    ['wrong commit', { Output: JSON.stringify({ ...marker(), sha: 'f'.repeat(40) }) }],
    ['unfinished release', { Output: JSON.stringify({ ...marker(), stage: 'deploy' }) }],
    ['failed release', { Output: JSON.stringify({ ...marker(), status: 'failed' }) }],
    ['unknown marker version', { Output: JSON.stringify({ ...marker(), version: 2 }) }],
    ['unknown marker fields', { Output: JSON.stringify({ ...marker(), raw: privateOutput }) }],
    ['success text mixed with raw output', { Output: privateOutput + '\n' + JSON.stringify(marker()) }],
  ])('rejects %s even when the provider call succeeds', async (_name, change) => {
    const s = setup(response([record(change)]));
    const result = await runCloudRelease(s.config, s);
    expect(result.status).toBe('failed'); expect(result.code).toMatch(/^[A-Z][A-Z0-9_]+$/); expectSanitized(result);
    expect(s.call.mock.calls.filter(args => args[0] === 'InvokeCommand')).toHaveLength(1);
  });

  it.each([
    ['multiple invocation records', response([record(), record()])],
    ['malformed invocation collection', { Invocation: { InvocationResults: { InvocationResult: {} } } }],
    ['missing invocation envelope', { Output: JSON.stringify(marker()) }],
  ])('rejects %s', async (_name, body) => {
    const s = setup(body);
    const result = await runCloudRelease(s.config, s);
    expect(result.status).toBe('failed'); expectSanitized(result);
  });

  it('stops polling at the total deadline without a second invocation or cancellation', async () => {
    const s = setup(response([record({ InvocationStatus: 'Running', Output: '' })]));
    const result = await runCloudRelease(s.config, s);
    expect(result.status).toBe('failed'); expectSanitized(result);
    expect(s.now()).toBeGreaterThanOrEqual(100); expect(s.now()).toBeLessThanOrEqual(110);
    expect(s.call.mock.calls.filter(args => args[0] === 'InvokeCommand')).toHaveLength(1);
    expect(s.call.mock.calls.every(args => ['InvokeCommand', 'DescribeInvocationResults'].includes(args[0]))).toBe(true);
    expect(s.call.mock.calls.length).toBeLessThanOrEqual(12);
  });

  it('also caps polling requests when a shortened interval leaves a large time budget', async () => {
    const s = setup(response([]), { TEST_RELEASE_TOTAL_TIMEOUT_MS: '5400000' });
    const result = await runCloudRelease(s.config, s);
    expect(result).toMatchObject({ status: 'failed', code: 'TEST_RELEASE_TIMEOUT', requestCount: 1081 });
    expect(s.call.mock.calls.filter(args => args[0] === 'InvokeCommand')).toHaveLength(1);
    expect(s.call.mock.calls.filter(args => args[0] === 'DescribeInvocationResults')).toHaveLength(1080);
  });

  it.each(['invoke', 'poll'])('bounds a hung %s transport even when the SDK never resolves', async stage => {
    const s = setup();
    if (stage === 'poll') s.call.mockResolvedValueOnce({ InvokeId: invokeId });
    s.call.mockImplementationOnce(() => new Promise(() => undefined));
    const started = Date.now();
    const result = await runCloudRelease(s.config, { call: s.call });
    expect(result).toMatchObject({ status: 'failed', code: stage === 'invoke' ? 'TEST_RELEASE_SUBMISSION_UNKNOWN' : 'TEST_RELEASE_TIMEOUT' });
    expect(Date.now() - started).toBeLessThan(2000); expectSanitized(result);
    expect(s.call).toHaveBeenCalledTimes(stage === 'invoke' ? 1 : 2);
  });

  it.each(['invoke', 'poll'])('sanitizes an ambiguous %s failure and never retries the write', async stage => {
    const s = setup();
    const failure = new Error([privateOutput, accessKeyId, accessKeySecret, securityToken].join(' '));
    if (stage === 'poll') s.call.mockResolvedValueOnce({ InvokeId: invokeId });
    s.call.mockRejectedValueOnce(failure);
    const result = await runCloudRelease(s.config, s);
    expect(result.status).toBe('failed'); expectSanitized(result);
    expect(s.call).toHaveBeenCalledTimes(stage === 'poll' ? 2 : 1);
  });

  it('rejects an invocation response without an ID instead of guessing or resubmitting', async () => {
    const s = setup(); s.call.mockResolvedValueOnce({ RequestId: privateOutput });
    const result = await runCloudRelease(s.config, s);
    expect(result.status).toBe('failed'); expectSanitized(result); expect(s.call).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['TEST_RELEASE_REGION_ID', 'cn-hangzhou'], ['TEST_RELEASE_INSTANCE_ID', 'i-unapproved'],
    ['TEST_RELEASE_COMMAND_ID', ''], ['TEST_RELEASE_COMMAND_ID', 'c-x'], ['TEST_RELEASE_COMMAND_ID', 'c-invalid;command'],
    ['TEST_RELEASE_SHA', 'main'], ['TEST_RELEASE_SHA', 'A'.repeat(40)], ['TEST_RELEASE_SHA', sha + '\nrm'],
    ['ALIBABA_CLOUD_ACCESS_KEY_ID', 'LTAI-long-lived-key'], ['ALIBABA_CLOUD_ACCESS_KEY_SECRET', ''], ['ALIBABA_CLOUD_SECURITY_TOKEN', ''],
    ['TEST_RELEASE_TOTAL_TIMEOUT_MS', '99'], ['TEST_RELEASE_TOTAL_TIMEOUT_MS', '5400001'],
    ['TEST_RELEASE_POLL_INTERVAL_MS', '9'], ['TEST_RELEASE_POLL_INTERVAL_MS', '5001'],
  ])('rejects unsafe configuration %s before an RPC', (key, value) => {
    expect(() => readCloudReleaseConfig({ ...env(), [key]: value })).toThrow(CloudReleaseError);
  });

  it('uses the real SDK over HTTPS POST, temporary credentials, a fixed endpoint, and disabled retries', async () => {
    const rpc = vi.spyOn(OpenApiClient.prototype, 'callApi').mockResolvedValue({ body: { InvokeId: invokeId } });
    const config = readCloudReleaseConfig(env());
    const call = createCloudReleaseClient(config);
    const body = { RegionId: 'cn-beijing', 'InstanceId.1': instanceId, CommandId: commandId, Parameters: JSON.stringify({ sha }) };
    expect(await call('InvokeCommand', body, 1234)).toEqual({ InvokeId: invokeId });
    expect(rpc).toHaveBeenCalledTimes(1);
    const [params, request, runtime] = rpc.mock.calls[0]!;
    expect(params).toMatchObject({ action: 'InvokeCommand', version: '2014-05-26', protocol: 'HTTPS', method: 'POST', style: 'RPC', reqBodyType: 'formData', bodyType: 'json' });
    expect(request.body).toEqual(body); expect(Object.keys(request.query ?? {})).toHaveLength(0);
    expect(runtime).toMatchObject({ autoretry: false, maxAttempts: 1, ignoreSSL: false });
    expect(runtime.connectTimeout).toBeLessThanOrEqual(1234); expect(runtime.readTimeout).toBeLessThanOrEqual(1234);
    const client = rpc.mock.contexts[0] as InstanceType<typeof OpenApiClient>;
    expect(client._endpoint).toBe('ecs.cn-beijing.aliyuncs.com'); expect(client._retryOptions.retryable).toBe(false);
    expect(await client._credential.getCredential()).toMatchObject({ accessKeyId, accessKeySecret, securityToken });
  });

  it('refuses unrelated cloud actions at the SDK boundary without a transport request', async () => {
    const rpc = vi.spyOn(OpenApiClient.prototype, 'callApi').mockResolvedValue({ body: {} });
    const call = createCloudReleaseClient(readCloudReleaseConfig(env()));
    await expect(call('RunCommand', { RegionId: 'cn-beijing', CommandContent: privateOutput }, 1000)).rejects.toThrow(CloudReleaseError);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('CLI rejects missing configuration with nonzero exit and sanitized output before any cloud call', async () => {
    const result = await cli({ ...env(), TEST_RELEASE_COMMAND_ID: '' });
    expect(result.code).not.toBe(0); expect(result.output).toContain('failed'); expectSanitized(result);
  });
});

describe('bounded host diagnostics for the original release invocation', () => {
  const failedMarker = (diagnostic?: Record<string, unknown>) => ({ version: 1, sha, stage: 'preflight', status: 'failed', code: 'FAILED',
    ...(diagnostic ? { diagnostic } : {}) });
  const failedRecord = (value: unknown) => record({ InvocationStatus: 'Failed', ExitCode: 1, Output: JSON.stringify(value) });

  it('reports a validated host check and exact invocation without another command or raw logs', async () => {
    const diagnostic = { check: 'configuration', code: 'CONFIGURATION_INVALID', exitCode: 1 };
    const s = setup(response([failedRecord(failedMarker(diagnostic))]));
    const result = await runCloudRelease(s.config, s);
    expect(result).toMatchObject({ status: 'failed', code: 'TEST_RELEASE_REMOTE_FAILED', invocationId: invokeId, diagnosticStatus: 'available', diagnostic });
    const summary = renderCloudReleaseSummary(result);
    expect(summary).toContain('配置断言失败'); expect(summary).toContain('CONFIGURATION_INVALID'); expect(summary).toContain(invokeId);
    expect(summary).toContain('检查退出码：1'); expect(summary).not.toContain('已完成 5');
    expect(s.call.mock.calls.map(args => args[0])).toEqual(['InvokeCommand', 'DescribeInvocationResults']);
    expectSanitized(result); expectSanitized(summary);
  });

  it.each([
    ['build within preflight', 'preflight', 'build', 'BUILD_FAILED'],
    ['Server admission within preflight', 'preflight', 'server-admission', 'SERVER_PREFLIGHT_FAILED'],
    ['storage initialization', 'migrate', 'storage', 'STORAGE_INIT_FAILED'],
    ['candidate checks', 'verify', 'candidate', 'CANDIDATE_CHECK_FAILED'],
    ['switching containers', 'deploy', 'switch', 'SWITCH_FAILED'],
    ['restoring after switch', 'deploy', 'restore', 'RESTORE_FAILED'],
    ['restoring after health', 'health', 'restore', 'RESTORE_FAILED'],
    ['runtime checks', 'smoke', 'runtime', 'RUNTIME_CHECK_FAILED'],
    ['cleanup', 'cleanup', 'cleanup', 'CLEANUP_FAILED'],
  ])('accepts the fixed classification for %s without inventing progress', async (_name, stage, check, code) => {
    const diagnostic = { check, code };
    const s = setup(response([failedRecord({ ...failedMarker(diagnostic), stage })]));
    const result = await runCloudRelease(s.config, s);
    expect(result).toMatchObject({ status: 'failed', stage, diagnostic, progress: { visibility: 'terminal_only', completed: null } });
    expect(s.call.mock.calls.filter(args => args[0] === 'InvokeCommand')).toHaveLength(1); expectSanitized(result);
  });

  it.each([
    ['a raw message', { check: 'build', code: 'BUILD_FAILED', message: privateOutput }],
    ['a log path', { check: 'build', code: 'BUILD_FAILED', logPath: '/private/' + privateOutput }],
    ['an unknown check', { check: privateOutput, code: 'BUILD_FAILED' }],
    ['a coerced array check', { check: ['build'], code: 'BUILD_FAILED' }],
    ['an arbitrary error code', { check: 'build', code: privateOutput }],
    ['a code for another check', { check: 'configuration', code: 'BUILD_FAILED' }],
    ['a check from a later phase', { check: 'storage', code: 'STORAGE_INIT_FAILED' }],
    ['a string exit code', { check: 'build', code: 'BUILD_FAILED', exitCode: '1' }],
    ['an invalid exit code', { check: 'build', code: 'BUILD_FAILED', exitCode: 256 }],
  ])('rejects diagnostics containing %s without forwarding the payload', async (_name, diagnostic) => {
    const s = setup(response([failedRecord(failedMarker(diagnostic))]));
    const result = await runCloudRelease(s.config, s);
    expect(result).toMatchObject({ status: 'failed', code: 'TEST_RELEASE_REMOTE_FAILED', invocationId: invokeId, diagnosticStatus: 'invalid' });
    expect(result).not.toHaveProperty('diagnostic'); expectSanitized(result); expectSanitized(renderCloudReleaseSummary(result));
    expect(s.call.mock.calls.filter(args => args[0] === 'InvokeCommand')).toHaveLength(1);
  });

  it('keeps a confirmed preflight failure when the optional diagnosis is malformed', async () => {
    const bad = failedMarker({ check: 'build', code: 'BUILD_FAILED', raw: privateOutput });
    const s = setup(response([record({ InvocationStatus: 'Failed', ExitCode: 1,
      Output: jsonl(progress(1, 'running'), progress(1, 'failed'), bad) })]));
    const result = await runCloudRelease(s.config, s);
    expect(result).toMatchObject({ status: 'failed', stage: 'preflight', code: 'TEST_RELEASE_REMOTE_FAILED', diagnosticStatus: 'invalid',
      progress: { visibility: 'reported', completed: 0, failedPhase: 1 } });
    expect(result.progress.phases[1].status).toBe('not_run');
    const summary = renderCloudReleaseSummary(result);
    expect(summary).toContain('宿主诊断分类未通过校验，已丢弃'); expect(summary).toContain('保留原发布失败结果'); expectSanitized(summary);
    expect(s.call.mock.calls.filter(args => args[0] === 'InvokeCommand')).toHaveLength(1);
  });

  it.each([
    ['another commit', { sha: 'f'.repeat(40) }],
    ['a successful terminal', { status: 'passed', code: 'OK', stage: 'complete' }],
  ])('rejects a diagnosis attached to %s', async (_name, change) => {
    const s = setup(response([failedRecord({ ...failedMarker({ check: 'build', code: 'BUILD_FAILED' }), ...change })]));
    const result = await runCloudRelease(s.config, s);
    expect(result).toMatchObject({ status: 'failed', code: 'TEST_RELEASE_OUTPUT_INVALID' }); expect(result).not.toHaveProperty('diagnostic');
    expectSanitized(result); expect(s.call).toHaveBeenCalledTimes(2);
  });

  it('explicitly reports missing host diagnosis and retains the original handle after polling timeout', async () => {
    const s = setup(response([record({ InvocationStatus: 'Running', Output: '' })]));
    const result = await runCloudRelease(s.config, s);
    expect(result).toMatchObject({ status: 'failed', code: 'TEST_RELEASE_TIMEOUT', invocationId: invokeId });
    const summary = renderCloudReleaseSummary(result);
    expect(summary).toContain('宿主未提供可验证的诊断分类'); expect(summary).toContain('不能据此推断根因'); expect(summary).toContain(invokeId);
    expect(s.call.mock.calls.filter(args => args[0] === 'InvokeCommand')).toHaveLength(1); expectSanitized(result);
    const failed = setup(response([failedRecord(failedMarker())]));
    const confirmed = await runCloudRelease(failed.config, failed);
    expect(confirmed).toMatchObject({ code: 'TEST_RELEASE_REMOTE_FAILED', diagnosticStatus: 'missing' });
    expect(renderCloudReleaseSummary(confirmed)).toContain('宿主未提供可验证的诊断分类');
  });

  it('does not expose an unvalidated invocation ID or echo direct summary fields', async () => {
    const s = setup(); s.call.mockResolvedValueOnce({ InvokeId: privateOutput });
    const result = await runCloudRelease(s.config, s);
    expect(result).not.toHaveProperty('invocationId'); expectSanitized(result);
    const summary = renderCloudReleaseSummary({ status: 'failed', invocationId: privateOutput, diagnostic: { check: privateOutput, code: privateOutput } });
    expectSanitized(summary); expect(summary).toContain('宿主未提供可验证的诊断分类');
  });

  it('writes the safe failure analysis and exact handle to Actions summary without an extra RPC', async () => {
    const path = directory(), preload = join(path, 'sdk-diagnostic-fixture.mjs'), summary = join(path, 'summary.md');
    const script = new URL('../../scripts/release/invoke-cloud-release.mjs', import.meta.url).href;
    const last = response([record({ InvocationStatus: 'Failed', ExitCode: 1,
      Output: jsonl(progress(1, 'running'), progress(1, 'failed'), failedMarker({ check: 'configuration', code: 'CONFIGURATION_INVALID', exitCode: 1 })) })]);
    writeFileSync(preload, "import {createRequire} from 'node:module';const {default:Client}=createRequire(" + JSON.stringify(script)
      + ")('@alicloud/openapi-core');let calls=0;Client.prototype.callApi=async function(params){if(++calls>2)throw Error('unexpected extra RPC');return {body:params.action==='InvokeCommand'?{InvokeId:"
      + JSON.stringify(invokeId) + '}:' + JSON.stringify(last) + '};};');
    const result = await cli({ ...env(), GITHUB_STEP_SUMMARY: summary }, preload);
    expect(result.code).toBe(1); expectSanitized(result);
    const final = JSON.parse(result.output.trim().split('\n').at(-1)!);
    expect(final).toMatchObject({ code: 'TEST_RELEASE_REMOTE_FAILED', invocationId: invokeId, diagnosticStatus: 'available',
      diagnostic: { check: 'configuration', code: 'CONFIGURATION_INVALID', exitCode: 1 }, requestCount: 2 });
    const contents = readFileSync(summary, 'utf8');
    expect(contents).toContain('配置断言失败'); expect(contents).toContain(invokeId); expect(contents).toContain('已完成 0 / 5 项');
    expect(contents).toContain('下一步：'); expectSanitized(contents);
  });
});

describe('five-stage cumulative Cloud Assistant progress', () => {
  it('reports only newly observed events, deduplicates cumulative/stale prefixes and updates one summary', async () => {
    const path = join(directory(), 'summary.md'), output: string[] = [];
    const reporter = createCloudReleaseReporter({ summaryPath: path, write: (line: string) => output.push(line) });
    const s = setup(), all = completeProgress(), summaries: string[] = [];
    const states = [all.slice(0, 1), all.slice(0, 1), all.slice(0, 3), all.slice(0, 1), [...all, marker()]];
    let poll = 0;
    s.call.mockImplementation(async action => {
      if (action === 'InvokeCommand') return { InvokeId: invokeId };
      if (poll) summaries.push(readFileSync(path, 'utf8'));
      const values = states[poll++]!;
      return response([record({ InvocationStatus: poll === states.length ? 'Success' : 'Running', Output: jsonl(...values) })]);
    });
    const result = await runCloudRelease(s.config, { ...s, onProgress: reporter.onProgress });
    reporter.finish(result);
    expect(result).toMatchObject({ status: 'passed', progress: { visibility: 'reported', completed: 5, total: 5, failedPhase: null } });
    expect(output.map(line => JSON.parse(line))).toEqual(all.map(event => expect.objectContaining({ phase: event.phase, status: event.status })));
    expect(summaries.some(summary => summary.includes('已完成 1 / 5 项') && summary.includes('2. Mastra 存储初始化：执行中'))).toBe(true);
    const summary = readFileSync(path, 'utf8');
    expect(summary.match(/## 测试服务器发布/g)).toHaveLength(1);
    expect(summary).toContain('已完成 5 / 5 项'); expect(summary.match(/- \[x\]/g)).toHaveLength(5);
    expect(s.call.mock.calls.filter(args => args[0] === 'InvokeCommand')).toHaveLength(1);
    expectSanitized(result); expectSanitized(summary); for (const line of output) expectSanitized(line);
  });

  it('identifies phase-three failure and explicitly marks phases four and five as not executed', async () => {
    const events = [...completeProgress().slice(0, 4), progress(3, 'running'), progress(3, 'failed')];
    const s = setup(response([record({ InvocationStatus: 'Failed', ExitCode: 1,
      Output: jsonl(...events, { ...marker(), stage: 'verify', status: 'failed', code: 'FAILED' }) })]));
    const result = await runCloudRelease(s.config, s);
    expect(result).toMatchObject({ status: 'failed', stage: 'verify', progress: { completed: 2, failedPhase: 3 } });
    expect(result.progress.phases.map((phase: { status: string }) => phase.status)).toEqual(['passed', 'passed', 'failed', 'not_run', 'not_run']);
    const summary = renderCloudReleaseSummary(result);
    expect(summary).toContain('失败位置：第 3 阶段'); expect(summary).toContain('4. 容器切换与旧服务退出：未执行');
    expect(summary).toContain('5. 冒烟与清理：未执行'); expect(s.call).toHaveBeenCalledTimes(2); expectSanitized(result);
  });

  it.each([
    ['skip the first phase', [progress(2, 'running')]],
    ['pass without running', [progress(1, 'passed')]],
    ['repeat an event within a payload', [progress(1, 'running'), progress(1, 'running')]],
    ['skip unfinished work', [progress(1, 'running'), progress(2, 'running')]],
    ['go backwards', [progress(1, 'running'), progress(1, 'passed'), progress(1, 'running')]],
    ['contradict a completed result', [progress(1, 'running'), progress(1, 'passed'), progress(1, 'failed')]],
    ['continue after failure', [progress(1, 'running'), progress(1, 'failed'), progress(2, 'running')]],
    ['wrong progress SHA', [{ ...progress(1, 'running'), sha: 'f'.repeat(40) }]],
    ['unapproved progress field', [{ ...progress(1, 'running'), detail: privateOutput }]],
    ['phase outside the fixed list', [progress(6, 'running')]],
    ['unapproved progress status', [progress(1, privateOutput)]],
    ['terminal before all phases passed', [progress(1, 'running'), progress(1, 'passed'), marker()]],
    ['terminal failure in a different phase', [progress(1, 'running'), progress(1, 'failed'), { ...marker(), stage: 'verify', status: 'failed', code: 'FAILED' }]],
    ['progress after terminal', [marker(), progress(1, 'running')]],
    ['repeated terminal', [marker(), marker()]],
  ])('rejects a protocol that would %s without printing its data', async (_name, values) => {
    const onProgress = vi.fn();
    const s = setup(response([record({ Output: jsonl(...values) })]));
    const result = await runCloudRelease(s.config, { ...s, onProgress });
    expect(result.status).toBe('failed'); expectSanitized(result); expect(onProgress).not.toHaveBeenCalled();
    expect(s.call.mock.calls.filter(args => args[0] === 'InvokeCommand')).toHaveLength(1);
  });

  it('rejects a cumulative history that contradicts an already observed event', async () => {
    const s = setup(), onProgress = vi.fn();
    s.call.mockResolvedValueOnce({ InvokeId: invokeId })
      .mockResolvedValueOnce(response([record({ InvocationStatus: 'Running', Output: jsonl(progress(1, 'running'), progress(1, 'passed')) })]))
      .mockResolvedValueOnce(response([record({ InvocationStatus: 'Failed', ExitCode: 1, Output: jsonl(progress(1, 'running'), progress(1, 'failed'),
        { ...marker(), stage: 'preflight', status: 'failed', code: 'FAILED' }) })]));
    const result = await runCloudRelease(s.config, { ...s, onProgress });
    expect(result).toMatchObject({ status: 'failed', code: 'TEST_RELEASE_PROGRESS_INVALID' });
    expect(onProgress).toHaveBeenCalledTimes(2); expect(s.call).toHaveBeenCalledTimes(3);
  });

  it('rejects a terminal response that omits previously observed progress', async () => {
    const s = setup();
    s.call.mockResolvedValueOnce({ InvokeId: invokeId })
      .mockResolvedValueOnce(response([record({ InvocationStatus: 'Running', Output: jsonl(progress(1, 'running')) })]))
      .mockResolvedValueOnce(response());
    expect(await runCloudRelease(s.config, s)).toMatchObject({ status: 'failed', code: 'TEST_RELEASE_PROGRESS_INVALID' });
  });

  it('holds a partially written running line and emits its complete event exactly once later', async () => {
    const s = setup(), onProgress = vi.fn();
    s.call.mockResolvedValueOnce({ InvokeId: invokeId })
      .mockResolvedValueOnce(response([record({ InvocationStatus: 'Running',
        Output: jsonl(progress(1, 'running')) + JSON.stringify(progress(1, 'passed')).slice(0, 25) })]))
      .mockResolvedValueOnce(response([record({ Output: jsonl(...completeProgress(), marker()) })]));
    expect((await runCloudRelease(s.config, { ...s, onProgress })).status).toBe('passed');
    expect(onProgress).toHaveBeenCalledTimes(10);
  });

  it.each(['Running', 'Success'])('rejects dropped output in %s state before accepting any progress', async state => {
    const s = setup(response([record({ InvocationStatus: state, Dropped: 1, Output: jsonl(...completeProgress(), marker()) })]));
    const onProgress = vi.fn();
    expect(await runCloudRelease(s.config, { ...s, onProgress })).toMatchObject({ status: 'failed', code: 'TEST_RELEASE_OUTPUT_TRUNCATED' });
    expect(onProgress).not.toHaveBeenCalled(); expect(s.call).toHaveBeenCalledTimes(2);
  });

  it('rejects raw or oversized running output without forwarding it', async () => {
    for (const output of [privateOutput + '\n', jsonl(progress(1, 'running')) + ' '.repeat(4096)]) {
      const s = setup(response([record({ InvocationStatus: 'Running', Output: output })])), onProgress = vi.fn();
      const result = await runCloudRelease(s.config, { ...s, onProgress });
      expect(result.status).toBe('failed'); expectSanitized(result); expect(onProgress).not.toHaveBeenCalled();
    }
  });

  it('keeps terminal-only legacy or idempotent success visible without inventing completed stages', async () => {
    const s = setup(response([record({ Output: JSON.stringify(marker(), null, 2) })])), onProgress = vi.fn();
    const result = await runCloudRelease(s.config, { ...s, onProgress });
    expect(result).toMatchObject({ status: 'passed', progress: { visibility: 'terminal_only', completed: null } });
    expect(result.progress.phases.every((phase: { status: string }) => phase.status === 'unobserved')).toBe(true);
    const summary = renderCloudReleaseSummary(result);
    expect(summary).toContain('同 SHA 幂等返回需要复核'); expect(summary).not.toContain('已完成 5'); expect(summary).not.toContain('- [x]');
    expect(onProgress).not.toHaveBeenCalled();
  });

  it('retains strict cloud success, exit-code and forced-drain checks with a complete progress stream', async () => {
    for (const change of [{ InvocationStatus: 'Failed' }, { ExitCode: 1 }, { ErrorCode: privateOutput }]) {
      const s = setup(response([record({ ...change, Output: jsonl(...completeProgress(), marker()) })]));
      expect((await runCloudRelease(s.config, s)).status).toBe('failed');
    }
    const s = setup(response([record({ Output: jsonl(...completeProgress(), { ...marker(), code: 'OK_WITH_FORCED_DRAIN' }) })]));
    expect(await runCloudRelease(s.config, s)).toMatchObject({ status: 'passed', code: 'TEST_RELEASE_OK_WITH_FORCED_DRAIN' });
  });

  it('reports polling timeout as unconfirmed remote work without labelling later phases unexecuted', async () => {
    const s = setup(response([record({ InvocationStatus: 'Running', Output: jsonl(progress(1, 'running')) })]));
    const result = await runCloudRelease(s.config, s);
    expect(result).toMatchObject({ status: 'failed', code: 'TEST_RELEASE_TIMEOUT', progress: { completed: 0, failedPhase: null } });
    expect(result.progress.phases[1].status).toBe('unobserved');
    expect(renderCloudReleaseSummary(result)).toContain('未确认有效的发布结果'); expect(s.call.mock.calls.filter(args => args[0] === 'InvokeCommand')).toHaveLength(1);
  });

  it('stops on progress reporting failure and does not leak a raw filesystem exception or resubmit', async () => {
    const s = setup(response([record({ InvocationStatus: 'Running', Output: jsonl(progress(1, 'running')) })]));
    const result = await runCloudRelease(s.config, { ...s, onProgress: () => { throw new Error(privateOutput + securityToken); } });
    expect(result).toMatchObject({ status: 'failed', code: 'TEST_RELEASE_REPORT_FAILED' }); expectSanitized(result); expect(s.call).toHaveBeenCalledTimes(2);
  });

  it('CLI prints safe live progress and writes the final five-stage summary using a fully stubbed SDK', async () => {
    const path = directory(), preload = join(path, 'sdk-fixture.mjs'), summary = join(path, 'summary.md');
    const script = new URL('../../scripts/release/invoke-cloud-release.mjs', import.meta.url).href;
    const first = response([record({ InvocationStatus: 'Running', Output: jsonl(progress(1, 'running')) })]);
    const last = response([record({ Output: jsonl(...completeProgress(), marker()) })]);
    writeFileSync(preload, [
      "import {createRequire} from 'node:module';",
      'const {default:Client}=createRequire(' + JSON.stringify(script) + ")('@alicloud/openapi-core');",
      'let polls=0;Client.prototype.callApi=async function(params){return {body:params.action===\'InvokeCommand\'?{InvokeId:' + JSON.stringify(invokeId) + '}:(polls++?' + JSON.stringify(last) + ':' + JSON.stringify(first) + ')};};',
    ].join('\n'));
    const result = await cli({ ...env(), TEST_RELEASE_POLL_INTERVAL_MS: '10', TEST_RELEASE_TOTAL_TIMEOUT_MS: '1000', GITHUB_STEP_SUMMARY: summary }, preload);
    expect(result.code).toBe(0); expectSanitized(result);
    const lines = result.output.trim().split('\n').map(line => JSON.parse(line));
    expect(lines.filter(line => line.event === 'release_progress')).toHaveLength(10);
    expect(lines.at(-1)).toMatchObject({ status: 'passed', progress: { completed: 5 } });
    expect(readFileSync(summary, 'utf8')).toContain('已完成 5 / 5 项');
  });

  it('CLI explicitly asks for review on terminal-only idempotent output instead of printing five completed stages', async () => {
    const path = directory(), preload = join(path, 'sdk-fixture.mjs'), summary = join(path, 'summary.md');
    const script = new URL('../../scripts/release/invoke-cloud-release.mjs', import.meta.url).href;
    writeFileSync(preload, "import {createRequire} from 'node:module';const {default:Client}=createRequire(" + JSON.stringify(script)
      + ")('@alicloud/openapi-core');Client.prototype.callApi=async function(params){return {body:params.action==='InvokeCommand'?{InvokeId:"
      + JSON.stringify(invokeId) + '}:' + JSON.stringify(response()) + '};};');
    const result = await cli({ ...env(), GITHUB_STEP_SUMMARY: summary }, preload);
    expect(result.code).toBe(0); expect(result.output).toContain('review the host record');
    expect(result.output).not.toContain('release_progress'); expectSanitized(result);
    expect(readFileSync(summary, 'utf8')).toContain('完成项数不可见');
    expect(readFileSync(summary, 'utf8')).not.toContain('- [x]');
  });
});
