import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PostgresDocumentVersionStore } from '../src/adapters/rag/postgres-document-version-store.ts';
import { makeIdempotencyKey } from '../src/application/rag/document-version-service.ts';
import { loadRagStateDatabaseConfig } from '../src/extensions/huahuo/rag/state-config.ts';
import type { IndexVersionKey } from '../src/extensions/huahuo/rag/types.ts';

function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/(api[-_ ]?key|password|passwd|token|authorization)\s*[:=]\s*\S+/gi, '$1=[redacted]')
    .replace(/postgres(?:ql)?:\/\/[^\s]+/gi, 'postgresql://[redacted]')
    .slice(0, 300);
}

function arg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

function requireWriteAuthorization(): void {
  if (process.env.RAG_STATE_PROCESS_CHECK_ALLOW !== 'true') {
    throw new Error('Set RAG_STATE_PROCESS_CHECK_ALLOW=true for the authorized PostgreSQL state check');
  }
}

function config() {
  return loadRagStateDatabaseConfig(process.env, { requireTarget: true });
}

function makeKey(runId: string, version = 'v1'): IndexVersionKey {
  return {
    documentId: `state-check-${runId}`,
    documentVersion: version,
    contentHash: 'a'.repeat(64),
    pipelineVersion: 'state-check-v1',
    embeddingModel: 'state-check-model',
    embeddingDimensions: 1024,
  };
}

async function withStore<T>(action: (store: PostgresDocumentVersionStore) => Promise<T>): Promise<T> {
  const database = config();
  const store = PostgresDocumentVersionStore.fromConnectionString(database.url);
  try {
    await store.ping();
    return await action(store);
  } finally {
    await store.close();
  }
}

async function writeState(runId: string): Promise<Record<string, unknown>> {
  requireWriteAuthorization();
  const key = makeKey(runId);
  const idempotencyKey = makeIdempotencyKey(key);
  return withStore(async (store) => {
    const version = await store.start({
      ...key,
      idempotencyKey,
      sourceId: `state-check-source-${runId}`,
      sourceType: 'note',
      runId,
    });
    const job = await store.createOrGetJob({
      idempotencyKey,
      runId,
      documentId: key.documentId,
      documentVersion: key.documentVersion,
      pipelineVersion: key.pipelineVersion,
    });
    return {
      ok: true,
      status: 'PASS',
      operation: 'write-state',
      runId,
      documentId: key.documentId,
      documentVersion: key.documentVersion,
      idempotencyKey,
      versionStatus: version.status,
      jobId: job.jobId,
      jobStatus: job.status,
      note: 'State is intentionally left processing/pending; no Milvus write is claimed by this PostgreSQL-only check',
    };
  });
}

async function readState(runId: string): Promise<Record<string, unknown>> {
  const key = makeKey(runId);
  const idempotencyKey = makeIdempotencyKey(key);
  return withStore(async (store) => {
    const version = await store.findByIdempotencyKey(idempotencyKey);
    const jobs = await store.findRecoverableJobs(1000);
    if (!version) throw new Error('Persisted document version was not found after process restart');
    return {
      ok: true,
      status: 'PASS',
      operation: 'read-state',
      runId,
      documentId: key.documentId,
      versionStatus: version.status,
      versionAttemptCount: version.attemptCount,
      recoverableJobFound: jobs.some((job) => job.idempotencyKey === idempotencyKey),
    };
  });
}

async function verifyIdempotency(runId: string): Promise<Record<string, unknown>> {
  requireWriteAuthorization();
  const key = makeKey(runId);
  const idempotencyKey = makeIdempotencyKey(key);
  return withStore(async (store) => {
    const first = await store.createOrGetJob({
      idempotencyKey,
      runId,
      documentId: key.documentId,
      documentVersion: key.documentVersion,
      pipelineVersion: key.pipelineVersion,
    });
    const second = await store.createOrGetJob({
      idempotencyKey,
      runId,
      documentId: key.documentId,
      documentVersion: key.documentVersion,
      pipelineVersion: key.pipelineVersion,
    });
    if (first.jobId !== second.jobId) throw new Error('PostgreSQL idempotency key returned different job IDs');
    const owners = [`state-check-a-${randomUUID()}`, `state-check-b-${randomUUID()}`];
    const claims = await Promise.all(owners.map((owner) => store.claimJob(first.jobId, owner, 30_000)));
    if (claims.filter(Boolean).length !== 1) throw new Error('Concurrent lease claim did not elect exactly one owner');
    return {
      ok: true,
      status: 'PASS',
      operation: 'verify-idempotency',
      runId,
      jobId: first.jobId,
      sameJobId: true,
      concurrentClaimCount: claims.filter(Boolean).length,
    };
  });
}

async function verifyVersion(runId: string): Promise<Record<string, unknown>> {
  requireWriteAuthorization();
  const key = makeKey(runId, 'v1');
  const nextKey = makeKey(runId, 'v2');
  const firstId = makeIdempotencyKey(key);
  const nextId = makeIdempotencyKey(nextKey);
  return withStore(async (store) => {
    await store.start({
      ...key,
      idempotencyKey: firstId,
      sourceId: `state-check-source-${runId}`,
      sourceType: 'note',
      runId,
    });
    await store.start({
      ...nextKey,
      idempotencyKey: nextId,
      sourceId: `state-check-source-${runId}`,
      sourceType: 'note',
      runId,
    });
    const activeBeforeVerification = await store.findActiveVersion(key.documentId);
    const activeVersionBeforeVerification = activeBeforeVerification?.documentVersion ?? null;
    if (activeBeforeVerification) throw new Error('Unverified processing version became active');
    let rejected = false;
    try {
      await store.promoteVisible(firstId);
    } catch (error) {
      rejected = /ready|visible|not ready/i.test(error instanceof Error ? error.message : String(error));
    }
    if (!rejected) throw new Error('PostgreSQL allowed an unverified processing version to become visible');
    return {
      ok: true,
      status: 'PASS',
      operation: 'verify-version',
      runId,
      activeVersionBeforeVerification,
      unverifiedPromotionRejected: rejected,
      note: 'This verifies PostgreSQL refuses activation before Milvus verification; successful cross-store switching still requires the full ingest coordinator.',
    };
  });
}

async function runChild(operation: string, runId: string): Promise<Record<string, unknown>> {
  const script = fileURLToPath(import.meta.url);
  const child = spawn(process.execPath, ['--experimental-strip-types', script, `--operation=${operation}`, `--run-id=${runId}`], {
    env: { ...process.env },
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout = await new Promise<string>((resolve, reject) => {
    let output = '';
    let errorOutput = '';
    child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr?.on('data', (chunk: Buffer) => { errorOutput += chunk.toString(); });
    child.once('error', reject);
    child.once('close', (code) => {
      if (output.trim()) resolve(output);
      else reject(new Error(errorOutput.trim() || `child exited with code ${code}`));
    });
  });
  const cleanStdout = stdout.trim();
  const line = cleanStdout.split('\n').at(-1) ?? '';
  return JSON.parse(line) as Record<string, unknown>;
}

async function scenarioAll(runId: string): Promise<Record<string, unknown>> {
  requireWriteAuthorization();
  const write = await runChild('write-state', runId);
  const read = await runChild('read-state', runId);
  const idem = await runChild('verify-idempotency', `${runId}-idem`);
  const version = await runChild('verify-version', `${runId}-version`);
  const childResults = [write, read, idem, version];
  const failedChild = childResults.find((result) => result.status !== 'PASS');
  if (failedChild) {
    throw new Error(String(failedChild.message ?? 'A child process state check did not pass'));
  }
  return {
    ok: true,
    status: 'PASS',
    operation: 'scenario-all',
    runId,
    independentProcesses: true,
    checks: { write, read, verifyIdempotency: idem, verifyVersion: version },
    note: 'This is a PostgreSQL persistence/state-machine check. It does not claim Milvus cross-store recovery.',
  };
}

async function main(): Promise<number> {
  const operation = arg('operation') ?? arg('scenario') ?? 'all';
  const runId = arg('run-id') ?? `state-check-${Date.now()}-${randomUUID()}`;
  try {
    const result = operation === 'write-state'
      ? await writeState(runId)
      : operation === 'read-state'
        ? await readState(runId)
        : operation === 'verify-idempotency'
          ? await verifyIdempotency(runId)
          : operation === 'verify-version'
            ? await verifyVersion(runId)
            : await scenarioAll(runId);
    console.log(JSON.stringify(result));
    return 0;
  } catch (error) {
    const message = safeMessage(error);
    const blocked = /required|authorized|target|RAG_STATE_PROCESS_CHECK_ALLOW|connection|ECONNREFUSED|timeout/i.test(message)
      && !/unique|conflict|did not|not found/i.test(message);
    console.log(JSON.stringify({
      ok: false,
      status: blocked ? 'BLOCKED' : 'FAIL',
      exitCode: blocked ? 2 : 1,
      operation,
      runId,
      message,
    }));
    return blocked ? 2 : 1;
  }
}

main().then((code) => { process.exitCode = code; }).catch((error: unknown) => {
  console.log(JSON.stringify({ ok: false, status: 'ERROR', exitCode: 3, message: safeMessage(error) }));
  process.exitCode = 3;
});
