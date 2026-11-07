import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ingestDocument } from '../src/application/rag/ingest-document.ts';
import { InMemoryDocumentVersionStore } from '../src/application/rag/document-version-service.ts';
import type {
  EmbeddingClientPort,
  IndexVersionKey,
  RAGChunkRow,
  RAGDocumentInput,
  RagChunkRepositoryPort,
} from '../src/extensions/huahuo/rag/types.ts';

const startedAt = Date.now();
const artifactRoot = join('artifacts', 'rag-acceptance');

class DeterministicEmbedding implements EmbeddingClientPort {
  calls = 0;

  async embed(texts: string[]): Promise<number[][]> {
    this.calls += 1;
    return texts.map((text) => {
      const digest = createHash('sha256').update(text, 'utf8').digest();
      return [digest[0] / 255, digest[1] / 255, digest[2] / 255, digest[3] / 255];
    });
  }
}

class InMemoryVectorRepository implements RagChunkRepositoryPort {
  readonly rows = new Map<string, RAGChunkRow>();
  calls = 0;
  failOnCall?: number;

  async ensureReady(): Promise<void> {}

  async upsertChunks(rows: RAGChunkRow[]): Promise<void> {
    this.calls += 1;
    if (this.failOnCall === this.calls) {
      this.failOnCall = undefined;
      throw new Error('acceptance-injected partial batch failure');
    }
    for (const row of rows) this.rows.set(row.chunkId, { ...row });
  }

  async countVersionChunks(
    key: IndexVersionKey,
    state: RAGChunkRow['documentVersionState'],
  ): Promise<number> {
    return [...this.rows.values()].filter((row) =>
      row.documentId === key.documentId
      && row.documentVersion === key.documentVersion
      && row.contentHash === key.contentHash
      && row.pipelineVersion === key.pipelineVersion
      && row.embeddingModel === key.embeddingModel
      && row.embeddingDimensions === key.embeddingDimensions
      && row.documentVersionState === state,
    ).length;
  }
}

const options = {
  pipelineVersion: 'acceptance-v1',
  embeddingModel: 'mock-deterministic-v1',
  embeddingDimensions: 4,
  maxTokens: 40,
  overlapTokens: 5,
  batchSize: 2,
};

function input(runId: string, documentId: string, version = 'v1', content = '# Acceptance\n\nA deterministic document.'):
  RAGDocumentInput {
  return {
    sourceId: `${runId}-${documentId}`,
    sourceType: 'article',
    documentId,
    documentVersion: version,
    title: `Acceptance ${documentId}`,
    content,
    tenantId: `tenant-${runId}`,
    ownerId: `owner-${runId}`,
    knowledgeBaseId: `kb-${runId}`,
    runId,
  };
}

async function expectFailure(action: () => Promise<unknown>, text: string): Promise<void> {
  try {
    await action();
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes(text)) {
      throw new Error(`Expected error containing "${text}"`);
    }
    return;
  }
  throw new Error('Expected operation to fail');
}

async function main(): Promise<void> {
  const runId = randomUUID();
  const checks: Array<Record<string, unknown>> = [];
  const started = Date.now();

  const embedding = new DeterministicEmbedding();
  const repository = new InMemoryVectorRepository();
  const versionStore = new InMemoryDocumentVersionStore();
  const firstInput = input(runId, 'flow');
  const first = await ingestDocument(firstInput, options, { embedding, repository, versionStore });
  const duplicate = await ingestDocument(firstInput, options, { embedding, repository, versionStore });
  const updated = await ingestDocument(
    input(runId, 'flow', 'v2', `${firstInput.content}\n\nUpdated version.`),
    options,
    { embedding, repository, versionStore },
  );
  if (first.status !== 'visible' || !duplicate.reused || updated.status !== 'visible') {
    throw new Error('Idempotency or version-switching acceptance failed');
  }
  checks.push({ id: 'idempotency-and-versioning', status: 'PASS', firstStatus: first.status, duplicateReused: duplicate.reused, updatedStatus: updated.status });

  const failureEmbedding = new DeterministicEmbedding();
  const failureRepository = new InMemoryVectorRepository();
  const failureStore = new InMemoryDocumentVersionStore();
  const base = input(runId, 'recovery', 'v1', '# Recovery\n\none two three four five six seven eight nine ten eleven twelve.');
  await ingestDocument(base, options, { embedding: failureEmbedding, repository: failureRepository, versionStore: failureStore });
  failureRepository.failOnCall = failureRepository.calls + 1;
  const next = input(runId, 'recovery', 'v2', `${base.content}\n\nRetry candidate.`);
  await expectFailure(() => ingestDocument(next, options, {
    embedding: failureEmbedding,
    repository: failureRepository,
    versionStore: failureStore,
  }), 'acceptance-injected partial batch failure');
  const retried = await ingestDocument(next, options, {
    embedding: failureEmbedding,
    repository: failureRepository,
    versionStore: failureStore,
  });
  if (retried.status !== 'visible') throw new Error('Failure recovery acceptance failed');
  checks.push({ id: 'failure-recovery', status: 'PASS', retriedStatus: retried.status, storedRows: failureRepository.rows.size });

  const badRepository = new InMemoryVectorRepository();
  const badStore = new InMemoryDocumentVersionStore();
  await expectFailure(() => ingestDocument(input(runId, 'invalid'), options, {
    embedding: { embed: async () => [[1, 2]] },
    repository: badRepository,
    versionStore: badStore,
  }), 'Embedding dimension does not match configured dimension');
  if (badRepository.rows.size !== 0) throw new Error('Invalid embedding was written');
  checks.push({ id: 'invalid-embedding', status: 'PASS', storedRows: 0 });

  const report = {
    ok: true,
    status: 'PASS',
    mode: 'mock',
    runId,
    durationMs: Date.now() - started,
    checks,
    embeddingCalls: embedding.calls,
    generatedAt: new Date().toISOString(),
  };
  await mkdir(join(artifactRoot, 'runs'), { recursive: true });
  await writeFile(join(artifactRoot, 'latest.json'), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(join(artifactRoot, 'runs', `${runId}.json`), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ ...report, durationMs: Date.now() - startedAt }));
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({
    ok: false,
    status: 'FAIL',
    mode: 'mock',
    durationMs: Date.now() - startedAt,
    message: error instanceof Error ? error.message : 'Acceptance failed',
  }));
  process.exitCode = 1;
});
