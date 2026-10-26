import { randomUUID } from 'node:crypto';
import { PostgresDocumentVersionStore } from '../src/adapters/rag/postgres-document-version-store.ts';
import { loadRagStateDatabaseConfig } from '../src/extensions/huahuo/rag/state-config.ts';

const startedAt = Date.now();

function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/(api[-_ ]?key|password|passwd|token|authorization)\s*[:=]\s*\S+/gi, '$1=[redacted]')
    .replace(/\b(postgres(?:ql)?|https?):\/\/[^\s/:@]+:[^\s@]+@/gi, '$1://[redacted]@')
    .slice(0, 300);
}

async function main(): Promise<number> {
  let config: ReturnType<typeof loadRagStateDatabaseConfig>;
  try {
    config = loadRagStateDatabaseConfig(process.env, { requireTarget: true });
  } catch (error) {
    console.log(JSON.stringify({
      ok: false,
      status: 'BLOCKED',
      exitCode: 2,
      message: error instanceof Error ? error.message : 'Invalid state database configuration',
    }));
    return 2;
  }
  const limit = Number(process.env.RAG_RECOVERY_MAX_JOBS || 10);
  const store = PostgresDocumentVersionStore.fromConnectionString(config.url);
  try {
    await store.ping();
    const jobs = await store.findRecoverableJobs(limit);
    if (jobs.length === 0) {
      console.log(JSON.stringify({
        ok: true,
        status: 'PASS',
        exitCode: 0,
        target: config.target,
        recoveredCount: 0,
        durationMs: Date.now() - startedAt,
      }));
      return 0;
    }
    // Source content and an authorized Milvus repository are intentionally not inferred here.
    // Claiming a job without both would make recovery unsafe, so leave jobs untouched.
    console.log(JSON.stringify({
      ok: false,
      status: 'BLOCKED',
      exitCode: 2,
      target: config.target,
      recoverableCount: jobs.length,
      jobIds: jobs.map((job) => job.jobId),
      workerId: `recovery-${randomUUID()}`,
      message: 'Recoverable jobs found, but no authorized source-content and Milvus recovery coordinator is configured; no state was modified',
      durationMs: Date.now() - startedAt,
    }));
    return 2;
  } catch (error) {
    console.error(JSON.stringify({
      ok: false,
      status: 'FAIL',
      exitCode: 1,
      message: safeMessage(error),
      durationMs: Date.now() - startedAt,
    }));
    return 1;
  } finally {
    await store.close();
  }
}

main().then((exitCode) => {
  process.exitCode = exitCode;
}).catch((error: unknown) => {
  console.error(JSON.stringify({
    ok: false,
    status: 'ERROR',
    exitCode: 3,
    message: safeMessage(error),
  }));
  process.exitCode = 3;
});

