import { createEmbeddingClient } from '../src/adapters/rag/embedding-client.ts';
import {
  loadRagConfig,
  requireRealEmbeddingConfig,
} from '../src/extensions/huahuo/rag/config.ts';
import {
  EmbeddingProviderError,
  RagError,
} from '../src/extensions/huahuo/rag/errors.ts';

const startedAt = Date.now();
const EXPECTED_MODEL = 'BAAI/bge-m3';
const EXPECTED_DIMENSIONS = 1024;

function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/(api[-_ ]?key|password|passwd|token|authorization)\s*[:=]\s*\S+/gi, '$1=[redacted]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\b(postgres(?:ql)?|https?):\/\/[^\s/:@]+:[^\s@]+@/gi, '$1://[redacted]@')
    .slice(0, 400);
}

function output(result: Record<string, unknown>): void {
  console.log(JSON.stringify(result));
}

async function main(): Promise<number> {
  let config: ReturnType<typeof loadRagConfig>;
  let embedding: ReturnType<typeof requireRealEmbeddingConfig>;
  try {
    config = loadRagConfig();
    embedding = requireRealEmbeddingConfig(config);
    if (embedding.model !== EXPECTED_MODEL || embedding.dimensions !== EXPECTED_DIMENSIONS) {
      output({
        ok: false,
        status: 'BLOCKED',
        exitCode: 2,
        durationMs: Date.now() - startedAt,
        errorKind: 'configuration',
        message: `Embedding check requires ${EXPECTED_MODEL} with ${EXPECTED_DIMENSIONS} dimensions`,
      });
      return 2;
    }
  } catch (error) {
    output({
      ok: false,
      status: 'BLOCKED',
      exitCode: 2,
      durationMs: Date.now() - startedAt,
      errorKind: 'configuration',
      message: safeMessage(error),
    });
    return 2;
  }

  const client = createEmbeddingClient(config.embedding);
  const samples = [
    '项目复盘会议安排在周五下午三点。',
    'A healthy apple tree needs sunlight and well-drained soil.',
    'Milvus uses HNSW with COSINE similarity for dense vector retrieval.',
  ];

  try {
    const chinese = await client.embed([samples[0]]);
    const english = await client.embed([samples[1]]);
    const mixedBatch = await client.embed(samples);
    const vectors = [...chinese, ...english, ...mixedBatch];
    if (vectors.length !== 5 || vectors.some((vector) =>
      vector.length !== embedding.dimensions
      || vector.some((value) => !Number.isFinite(value)))) {
      output({
        ok: false,
        status: 'FAIL',
        exitCode: 1,
        durationMs: Date.now() - startedAt,
        model: embedding.model,
        expectedDimensions: embedding.dimensions,
        errorKind: 'response',
        message: 'Embedding response count or dimensions did not match configuration',
      });
      return 1;
    }
    output({
      ok: true,
      status: 'PASS',
      exitCode: 0,
      durationMs: Date.now() - startedAt,
      model: embedding.model,
      dimensions: embedding.dimensions,
      inputCount: vectors.length,
      requestCount: 3,
      batches: [1, 1, 3],
    });
    return 0;
  } catch (error) {
    const provider = error instanceof EmbeddingProviderError ? error : undefined;
    const errorKind = provider?.kind
      ?? (error instanceof RagError ? error.code : 'network');
    output({
      ok: false,
      status: 'FAIL',
      exitCode: 1,
      durationMs: Date.now() - startedAt,
      model: embedding.model,
      expectedDimensions: embedding.dimensions,
      errorKind,
      ...(provider?.httpStatus ? { httpStatus: provider.httpStatus } : {}),
      message: safeMessage(error),
    });
    return 1;
  }
}

main().then((exitCode) => {
  process.exitCode = exitCode;
}).catch((error: unknown) => {
  output({
    ok: false,
    status: 'ERROR',
    exitCode: 3,
    durationMs: Date.now() - startedAt,
    message: safeMessage(error),
  });
  process.exitCode = 3;
});

