import { PostgresDocumentVersionStore } from '../src/adapters/rag/postgres-document-version-store.ts';
import { loadRagStateDatabaseConfig } from '../src/extensions/huahuo/rag/state-config.ts';

const startedAt = Date.now();

function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/(api[-_ ]?key|password|passwd|token|authorization)\s*[:=\s]*\S+/gi, '$1=[redacted]')
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
      mode: 'read-only',
      message: error instanceof Error ? error.message : 'Invalid state database configuration',
    }));
    return 2;
  }
  const limit = Number(process.env.RAG_RECONCILE_MAX_VERSIONS || 1000);
  const store = PostgresDocumentVersionStore.fromConnectionString(config.url);
  try {
    await store.ping();
    const versions = await store.listVersions(limit);
    const heads = await store.listHeads(limit);
    const visibleByDocument = new Map<string, number>();
    for (const version of versions) {
      if (version.status === 'visible') {
        visibleByDocument.set(version.documentId, (visibleByDocument.get(version.documentId) ?? 0) + 1);
      }
    }
    const multipleVisible = [...visibleByDocument.entries()]
      .filter(([, count]) => count > 1)
      .map(([documentId, count]) => ({ documentId, count }));
    const visibleByIdentity = new Map(
      versions.filter((version) => version.status === 'visible')
        .map((version) => [`${version.documentId}\u0000${version.documentVersion}\u0000${version.pipelineVersion}`, version]),
    );
    const headConflicts = heads.flatMap((head) => {
      if (!head.activeDocumentVersion || !head.activePipelineVersion) {
        return [{ documentId: head.documentId, reason: 'head has no active version' }];
      }
      const identity = `${head.documentId}\u0000${head.activeDocumentVersion}\u0000${head.activePipelineVersion}`;
      return visibleByIdentity.has(identity)
        ? []
        : [{ documentId: head.documentId, reason: 'head points to a missing or non-visible version', activeDocumentVersion: head.activeDocumentVersion, activePipelineVersion: head.activePipelineVersion }];
    });
    if (multipleVisible.length > 0 || headConflicts.length > 0) {
      console.log(JSON.stringify({
        ok: false,
        status: 'FAIL',
        exitCode: 1,
        mode: 'read-only',
        target: config.target,
        checkedVersions: versions.length,
        checkedHeads: heads.length,
        multipleVisible,
        headConflicts,
        message: 'Multiple visible versions detected; no repair was attempted',
        durationMs: Date.now() - startedAt,
      }));
      return 1;
    }
    console.log(JSON.stringify({
      ok: false,
      status: 'BLOCKED',
      exitCode: 2,
      mode: 'read-only',
      target: config.target,
      checkedVersions: versions.length,
      checkedHeads: heads.length,
      stateConflicts: [],
      milvusVerification: 'NOT_RUN',
      message: 'PostgreSQL state is internally consistent for the inspected rows; Milvus cross-store comparison was not run',
      durationMs: Date.now() - startedAt,
    }));
    return 2;
  } catch (error) {
    console.error(JSON.stringify({
      ok: false,
      status: 'FAIL',
      exitCode: 1,
      mode: 'read-only',
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

