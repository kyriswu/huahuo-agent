import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { $OpenApiUtil } from '@alicloud/openapi-core';
import { RetryOptions, RuntimeOptions } from '@darabonba/typescript';

// This is the explicitly authorized test ECS, never an arbitrary deployment target.
const TARGET = Object.freeze({ regionId: 'cn-beijing', instanceId: 'i-2zegtoygiiked53yntmj' });
const MAX_POLLS = 1080;
const STAGES = ['preflight', 'checkout', 'build', 'migrate', 'verify', 'deploy', 'health', 'smoke', 'cleanup', 'complete'];
const PHASES = ['预检构建与配置', 'Mastra 存储初始化', '候选验收', '容器切换与旧服务退出', '冒烟与清理'];
const STAGE_PHASE = { preflight: 1, checkout: 1, build: 1, migrate: 2, verify: 3, deploy: 4, health: 5, smoke: 5, cleanup: 5 };
const ERROR_CODES = new Set(['TEST_RELEASE_TARGET_DENIED', 'TEST_RELEASE_COMMAND_INVALID', 'TEST_RELEASE_SHA_INVALID',
  'TEST_RELEASE_STS_REQUIRED', 'TEST_RELEASE_TIMEOUT_INVALID', 'TEST_RELEASE_ACTION_DENIED', 'TEST_RELEASE_CLOUD_RESPONSE_INVALID',
  'TEST_RELEASE_RESULT_MISMATCH', 'TEST_RELEASE_OUTPUT_TRUNCATED', 'TEST_RELEASE_OUTPUT_INVALID', 'TEST_RELEASE_TIMEOUT',
  'TEST_RELEASE_SUBMISSION_UNKNOWN', 'TEST_RELEASE_POLL_FAILED', 'TEST_RELEASE_FAILED',
  'TEST_RELEASE_PROGRESS_INVALID', 'TEST_RELEASE_REPORT_FAILED']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const { default: OpenApiClient } = createRequire(import.meta.url)('@alicloud/openapi-core');

export class CloudReleaseError extends Error {
  constructor(code) {
    const safe = ERROR_CODES.has(code) ? code : 'TEST_RELEASE_FAILED';
    super(safe); this.name = 'CloudReleaseError'; this.code = safe;
  }
}
const fail = code => { throw new CloudReleaseError(code); };

export function readCloudReleaseConfig(env = process.env) {
  if (env.TEST_RELEASE_REGION_ID !== TARGET.regionId || env.TEST_RELEASE_INSTANCE_ID !== TARGET.instanceId) fail('TEST_RELEASE_TARGET_DENIED');
  if (typeof env.TEST_RELEASE_COMMAND_ID !== 'string' || !/^c-[A-Za-z0-9]{5,80}$/.test(env.TEST_RELEASE_COMMAND_ID)) fail('TEST_RELEASE_COMMAND_INVALID');
  if (typeof env.TEST_RELEASE_SHA !== 'string' || !/^[a-f0-9]{40}$/.test(env.TEST_RELEASE_SHA)) fail('TEST_RELEASE_SHA_INVALID');
  const accessKeyId = env.ALIBABA_CLOUD_ACCESS_KEY_ID, accessKeySecret = env.ALIBABA_CLOUD_ACCESS_KEY_SECRET, securityToken = env.ALIBABA_CLOUD_SECURITY_TOKEN;
  if (typeof accessKeyId !== 'string' || !/^STS\.[A-Za-z0-9._-]{1,240}$/.test(accessKeyId)
    || typeof accessKeySecret !== 'string' || !/^[\x21-\x7e]+$/.test(accessKeySecret)
    || typeof securityToken !== 'string' || !/^[\x21-\x7e]+$/.test(securityToken)) fail('TEST_RELEASE_STS_REQUIRED');
  const budget = (name, minimum, maximum) => {
    const value = Number(env[name] ?? maximum);
    if (!Number.isInteger(value) || value < minimum || value > maximum) fail('TEST_RELEASE_TIMEOUT_INVALID');
    return value;
  };
  return Object.freeze({ ...TARGET, commandId: env.TEST_RELEASE_COMMAND_ID, sha: env.TEST_RELEASE_SHA,
    accessKeyId, accessKeySecret, securityToken,
    totalTimeoutMs: budget('TEST_RELEASE_TOTAL_TIMEOUT_MS', 100, 5400000),
    pollIntervalMs: budget('TEST_RELEASE_POLL_INTERVAL_MS', 10, 5000) });
}

function validate(config) {
  return readCloudReleaseConfig({ TEST_RELEASE_REGION_ID: config?.regionId, TEST_RELEASE_INSTANCE_ID: config?.instanceId,
    TEST_RELEASE_COMMAND_ID: config?.commandId, TEST_RELEASE_SHA: config?.sha,
    ALIBABA_CLOUD_ACCESS_KEY_ID: config?.accessKeyId, ALIBABA_CLOUD_ACCESS_KEY_SECRET: config?.accessKeySecret,
    ALIBABA_CLOUD_SECURITY_TOKEN: config?.securityToken,
    TEST_RELEASE_TOTAL_TIMEOUT_MS: config?.totalTimeoutMs, TEST_RELEASE_POLL_INTERVAL_MS: config?.pollIntervalMs });
}

export function createCloudReleaseClient(config) {
  config = validate(config);
  const client = new OpenApiClient(new $OpenApiUtil.Config({
    accessKeyId: config.accessKeyId, accessKeySecret: config.accessKeySecret, securityToken: config.securityToken,
    type: 'sts', regionId: TARGET.regionId, endpoint: 'ecs.cn-beijing.aliyuncs.com', protocol: 'HTTPS',
    retryOptions: new RetryOptions({ retryable: false }),
  }));
  return async (action, body, timeoutMs) => {
    if (!['InvokeCommand', 'DescribeInvocationResults'].includes(action)) fail('TEST_RELEASE_ACTION_DENIED');
    if (body.RegionId !== TARGET.regionId || body.CommandId !== config.commandId
      || (action === 'InvokeCommand' ? body['InstanceId.1'] : body.InstanceId) !== TARGET.instanceId) fail('TEST_RELEASE_TARGET_DENIED');
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000) fail('TEST_RELEASE_TIMEOUT_INVALID');
    const response = await client.callApi(new $OpenApiUtil.Params({
      action, version: '2014-05-26', protocol: 'HTTPS', pathname: '/', method: 'POST',
      authType: 'AK', style: 'RPC', reqBodyType: 'formData', bodyType: 'json',
    }), new $OpenApiUtil.OpenApiRequest({ body }), new RuntimeOptions({
      connectTimeout: Math.min(2000, timeoutMs), readTimeout: timeoutMs,
      autoretry: false, maxAttempts: 1, ignoreSSL: false,
    }));
    if (!object(response?.body) || (response.statusCode !== undefined && response.statusCode !== 200)) fail('TEST_RELEASE_CLOUD_RESPONSE_INVALID');
    return response.body;
  };
}

function execution(response, config, invokeId) {
  const invocation = response?.Invocation;
  const items = invocation?.InvocationResults?.InvocationResult;
  if (!object(invocation) || !Array.isArray(items) || items.length > 1 || invocation.NextToken
    || (invocation.TotalCount !== undefined && invocation.TotalCount > 1)) fail('TEST_RELEASE_CLOUD_RESPONSE_INVALID');
  if (!items.length) return undefined; // Cloud Assistant results can appear after submission.
  const item = items[0];
  if (!object(item) || item.InstanceId !== TARGET.instanceId || item.CommandId !== config.commandId || item.InvokeId !== invokeId) fail('TEST_RELEASE_RESULT_MISMATCH');
  if (!['Pending', 'Running', 'Stopping', 'Success', 'Failed', 'Stopped', 'Invalid', 'Aborted', 'Timeout', 'Error', 'Cancelled'].includes(item.InvocationStatus)) fail('TEST_RELEASE_CLOUD_RESPONSE_INVALID');
  return item;
}

function terminal(value, config) {
  const result = value;
  if (!object(result) || Object.keys(result).sort().join(',') !== 'code,sha,stage,status,version'
    || result.version !== 1 || result.sha !== config.sha || !STAGES.includes(result.stage)
    || !['passed', 'failed'].includes(result.status) || !['OK', 'OK_WITH_FORCED_DRAIN', 'FAILED'].includes(result.code)) fail('TEST_RELEASE_OUTPUT_INVALID');
  return { version: 1, sha: result.sha, stage: result.stage, status: result.status, code: result.code };
}

function createProgress(config, onProgress) {
  const seen = [];
  let finalMarker;
  const snapshot = (finished = false) => {
    const visibility = seen.length ? 'reported' : finalMarker ? 'terminal_only' : 'unavailable';
    const phases = PHASES.map((name, index) => ({ phase: index + 1, name,
      status: seen.length && !finished ? 'pending' : 'unobserved' }));
    for (const event of seen) phases[event.phase - 1].status = event.status;
    const failedPhase = seen.find(event => event.status === 'failed')?.phase ?? null;
    if (finalMarker?.status === 'failed' && failedPhase) {
      for (const phase of phases) if (phase.phase > failedPhase) phase.status = 'not_run';
    }
    return { visibility, completed: seen.length ? phases.filter(phase => phase.status === 'passed').length : null,
      total: PHASES.length, failedPhase, phases };
  };
  const accept = async (item, finished) => {
    if (item.Dropped !== 0) fail('TEST_RELEASE_OUTPUT_TRUNCATED');
    if (typeof item.Output !== 'string' || Buffer.byteLength(item.Output) > 4096) fail('TEST_RELEASE_OUTPUT_INVALID');
    let lines = item.Output.split('\n').filter(line => line.trim());
    try {
      const legacy = JSON.parse(item.Output);
      if (object(legacy) && !Object.hasOwn(legacy, 'event')) lines = [JSON.stringify(legacy)];
    } catch { /* Multiple JSONL records or a running partial record. */ }
    if (lines.length > 11) fail('TEST_RELEASE_PROGRESS_INVALID');
    const events = [];
    let marker, partial = false, currentPhase = 1, currentStatus = 'pending';
    for (const [index, line] of lines.entries()) {
      let value;
      try { value = JSON.parse(line); }
      catch {
        // A running read may end in a partially written final JSON line.
        if (!finished && index === lines.length - 1 && !item.Output.endsWith('\n') && line.trimStart().startsWith('{')) { partial = true; break; }
        fail('TEST_RELEASE_OUTPUT_INVALID');
      }
      if (marker) fail('TEST_RELEASE_PROGRESS_INVALID');
      if (object(value) && value.event === 'progress') {
        if (Object.keys(value).sort().join(',') !== 'event,phase,sha,status,version'
          || value.version !== 1 || value.sha !== config.sha || !Number.isInteger(value.phase) || value.phase < 1 || value.phase > 5
          || !['running', 'passed', 'failed'].includes(value.status)) fail('TEST_RELEASE_PROGRESS_INVALID');
        if (value.phase !== currentPhase || currentStatus === 'failed'
          || (value.status === 'running' ? currentStatus !== 'pending' : currentStatus !== 'running')) fail('TEST_RELEASE_PROGRESS_INVALID');
        events.push({ phase: value.phase, status: value.status });
        currentStatus = value.status;
        if (value.status === 'passed') { currentPhase++; currentStatus = 'pending'; }
      } else marker = terminal(value, config);
    }
    if (marker && partial) fail('TEST_RELEASE_PROGRESS_INVALID');
    if (marker && events.length) {
      const last = events.at(-1);
      if (marker.status === 'passed'
        ? events.length !== 10 || last.phase !== 5 || last.status !== 'passed'
        : last.status !== 'failed' || STAGE_PHASE[marker.stage] !== last.phase) fail('TEST_RELEASE_PROGRESS_INVALID');
    }
    if (finished && !marker) fail('TEST_RELEASE_OUTPUT_INVALID');
    for (let index = 0; index < Math.min(seen.length, events.length); index++) {
      if (seen[index].phase !== events[index].phase || seen[index].status !== events[index].status) fail('TEST_RELEASE_PROGRESS_INVALID');
    }
    // Repeated cumulative output (including a stale shorter prefix while running)
    // is not a new event. Terminal output may never omit a previously seen event.
    if (events.length < seen.length && (finished || marker)) fail('TEST_RELEASE_PROGRESS_INVALID');
    if (finalMarker && marker && JSON.stringify(finalMarker) !== JSON.stringify(marker)) fail('TEST_RELEASE_PROGRESS_INVALID');
    if (finalMarker && events.length > seen.length) fail('TEST_RELEASE_PROGRESS_INVALID');
    for (const event of events.slice(seen.length)) {
      seen.push(event);
      try { await onProgress?.({ ...event }, snapshot()); } catch { fail('TEST_RELEASE_REPORT_FAILED'); }
    }
    if (marker) finalMarker = marker;
    return marker;
  };
  return { accept, snapshot };
}

function completion(item, result) {
  const passed = item.InvocationStatus === 'Success' && item.ExitCode === 0 && !item.ErrorCode
    && result.stage === 'complete' && result.status === 'passed' && ['OK', 'OK_WITH_FORCED_DRAIN'].includes(result.code);
  return { status: passed ? 'passed' : 'failed', stage: result.stage, code: passed
    ? (result.code === 'OK_WITH_FORCED_DRAIN' ? 'TEST_RELEASE_OK_WITH_FORCED_DRAIN' : 'TEST_RELEASE_OK')
    : 'TEST_RELEASE_REMOTE_FAILED' };
}

export async function runCloudRelease(config, { call, wait = delay, now = () => performance.now(), onProgress } = {}) {
  const started = now();
  let stage = 'configuration', requestCount = 0;
  let progress = createProgress({}, onProgress);
  const report = result => ({ ...result, progress: progress.snapshot(true), requestCount, durationMs: Math.max(0, Math.round(now() - started)) });
  try {
    config = validate(config);
    progress = createProgress(config, onProgress);
    call ??= createCloudReleaseClient(config);
    const remaining = () => config.totalTimeoutMs - (now() - started);
    const request = async (action, body) => {
      if (remaining() <= 0) fail('TEST_RELEASE_TIMEOUT');
      const timeoutMs = Math.min(10000, Math.max(1, Math.floor(remaining())));
      requestCount++;
      let timer;
      try {
        const response = await Promise.race([
          Promise.resolve().then(() => call(action, { RegionId: TARGET.regionId, ...body }, timeoutMs)),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new CloudReleaseError('TEST_RELEASE_TIMEOUT')), timeoutMs); }),
        ]);
        if (remaining() <= 0) fail('TEST_RELEASE_TIMEOUT');
        return response;
      } finally { clearTimeout(timer); }
    };
    stage = 'submit';
    let submitted;
    try {
      submitted = await request('InvokeCommand', { CommandId: config.commandId, 'InstanceId.1': TARGET.instanceId,
        Parameters: JSON.stringify({ sha: config.sha }), RepeatMode: 'Once', ClientToken: randomUUID() });
    } catch { fail('TEST_RELEASE_SUBMISSION_UNKNOWN'); }
    if (!object(submitted) || typeof submitted.InvokeId !== 'string' || !/^t-[A-Za-z0-9]{5,80}$/.test(submitted.InvokeId)) fail('TEST_RELEASE_CLOUD_RESPONSE_INVALID');
    stage = 'poll';
    for (let attempt = 0; attempt < MAX_POLLS; attempt++) {
      let response;
      try {
        response = await request('DescribeInvocationResults', { CommandId: config.commandId, InvokeId: submitted.InvokeId,
          InstanceId: TARGET.instanceId, ContentEncoding: 'PlainText', MaxResults: 1 });
      } catch (error) {
        if (error instanceof CloudReleaseError && error.code === 'TEST_RELEASE_TIMEOUT') throw error;
        fail('TEST_RELEASE_POLL_FAILED');
      }
      const item = execution(response, config, submitted.InvokeId);
      if (item) {
        const finished = !['Pending', 'Running', 'Stopping'].includes(item.InvocationStatus);
        const marker = await progress.accept(item, finished);
        if (finished) return report(completion(item, marker));
      }
      if (remaining() <= 0 || attempt === MAX_POLLS - 1) fail('TEST_RELEASE_TIMEOUT');
      await wait(Math.min(config.pollIntervalMs, remaining()));
    }
    fail('TEST_RELEASE_TIMEOUT');
  } catch (error) {
    const code = error instanceof CloudReleaseError ? error.code : 'TEST_RELEASE_FAILED';
    return report({ status: 'failed', stage: code === 'TEST_RELEASE_REPORT_FAILED' ? 'report' : stage, code });
  }
}

export function renderCloudReleaseSummary(result) {
  const progress = result.progress ?? createProgress({}).snapshot(true);
  const status = { running: '进行中', passed: '通过', failed: '失败' }[result.status] ?? '失败';
  const labels = { pending: '待执行', running: '执行中', passed: '已完成', failed: '失败', not_run: '未执行', unobserved: '不可见' };
  const lines = ['## 测试服务器发布：' + status, ''];
  if (progress.visibility === 'reported') lines.push('已完成 ' + progress.completed + ' / 5 项。', '');
  else lines.push('阶段完成项数不可见；仅有终态或尚未收到进度。旧版协议或同 SHA 幂等返回需要复核宿主发布记录。', '');
  for (const phase of progress.phases) lines.push('- [' + (phase.status === 'passed' ? 'x' : ' ') + '] ' + phase.phase + '. ' + phase.name + '：' + labels[phase.status]);
  if (progress.failedPhase) lines.push('', '失败位置：第 ' + progress.failedPhase + ' 阶段。');
  if (result.stage) lines.push('', '调用器阶段：' + result.stage + '；结果码：' + result.code + '。');
  if (result.status === 'failed' && ['poll', 'report'].includes(result.stage) && !progress.failedPhase) lines.push('', '调用器未确认有效的发布结果；请复核现有云助手调用，不得自动重发。');
  if (result.code === 'TEST_RELEASE_OK_WITH_FORCED_DRAIN') lines.push('', '旧服务达到排空上限后被强制停止；本次通过不表示全部请求自然完成。');
  return lines.join('\n') + '\n';
}

export function createCloudReleaseReporter({ summaryPath, write = line => process.stdout.write(line) } = {}) {
  const update = result => { if (summaryPath) writeFileSync(summaryPath, renderCloudReleaseSummary(result)); };
  return {
    onProgress(event, progress) {
      write(JSON.stringify({ event: 'release_progress', phase: event.phase, name: PHASES[event.phase - 1],
        status: event.status, completed: progress.completed, total: PHASES.length }) + '\n');
      update({ status: 'running', progress });
    },
    finish: update,
  };
}

async function main() {
  let result;
  const reporter = createCloudReleaseReporter({ summaryPath: process.env.GITHUB_STEP_SUMMARY });
  try { result = await runCloudRelease(readCloudReleaseConfig(), { onProgress: reporter.onProgress }); }
  catch (error) { result = { status: 'failed', stage: 'configuration', code: error instanceof CloudReleaseError ? error.code : 'TEST_RELEASE_FAILED', requestCount: 0, durationMs: 0 }; }
  let exitCode = result.status === 'passed' ? 0 : 1;
  if (result.code === 'TEST_RELEASE_OK_WITH_FORCED_DRAIN') console.warn('::warning::Deployment completed after the configured drain deadline forced old services to stop.');
  if (result.progress?.visibility === 'terminal_only') console.warn('::notice::Only a terminal result was reported. Stage execution is not visible; review the host record for a legacy or same-SHA idempotent result.');
  try {
    reporter.finish(result);
  } catch {
    result = { ...result, status: 'failed', stage: 'report', code: 'TEST_RELEASE_REPORT_FAILED' };
    exitCode = 1;
  }
  // Fixed fields only. No provider errors, command output or credentials are printed.
  // On an ambiguous timeout the remote command may still run; never resubmit here.
  // Explicit exit also closes an SDK request that outlived the local deadline.
  process.stdout.write(JSON.stringify(result) + '\n', () => process.exit(exitCode));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
