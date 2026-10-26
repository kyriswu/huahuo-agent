import { createMilvusClient, classifyMilvusError, safeMilvusMessage } from '../src/adapters/rag/milvus-client.ts';
import { MilvusRagRepository } from '../src/adapters/rag/milvus-rag-repository.ts';
import {
  loadMilvusConnectionConfig,
} from '../src/extensions/huahuo/rag/milvus-poc-config.ts';
import {
  loadRagConfig,
  requireRealEmbeddingConfig,
} from '../src/extensions/huahuo/rag/config.ts';
import { RagConfigurationError } from '../src/extensions/huahuo/rag/errors.ts';

const startedAt = Date.now();
const EXPECTED_COLLECTION = 'huahuo_chunks';
const EXPECTED_MODEL = 'BAAI/bge-m3';
const EXPECTED_DIMENSIONS = 1024;
const EXPECTED_TARGET = 'milvus-huahuo-test';
const EXPECTED_ADDRESS = 'c-850eb68e967e1f3a.milvus.aliyuncs.com:19530';

async function main(): Promise<void> {
  if (process.env.RAG_MILVUS_INIT_ALLOW !== 'true') {
    throw new RagConfigurationError('Set RAG_MILVUS_INIT_ALLOW=true for the explicitly authorized test initialization');
  }
  if (process.env.RAG_ACCEPTANCE_ENVIRONMENT_TARGET?.trim() !== EXPECTED_TARGET) {
    throw new RagConfigurationError(`RAG_ACCEPTANCE_ENVIRONMENT_TARGET must be ${EXPECTED_TARGET}`);
  }
  const ragConfig = loadRagConfig();
  const embedding = requireRealEmbeddingConfig(ragConfig);
  const connection = loadMilvusConnectionConfig();
  if (ragConfig.ragCollection !== EXPECTED_COLLECTION) {
    throw new RagConfigurationError(`Initialization is restricted to ${EXPECTED_COLLECTION}`);
  }
  if (embedding.model !== EXPECTED_MODEL || embedding.dimensions !== EXPECTED_DIMENSIONS) {
    throw new RagConfigurationError(`Initialization requires ${EXPECTED_MODEL} with ${EXPECTED_DIMENSIONS} dimensions`);
  }
  const address = connection.address.replace(/^\w+:\/\//, '');
  if (address !== EXPECTED_ADDRESS || connection.database !== 'default') {
    throw new RagConfigurationError('Initialization target is not the authorized Milvus test instance');
  }
  const client = await createMilvusClient(connection);
  try {
    const repository = new MilvusRagRepository(client, ragConfig.ragCollection);
    await repository.ensureReady(embedding.dimensions);
    console.log(JSON.stringify({
      ok: true,
      durationMs: Date.now() - startedAt,
      collection: ragConfig.ragCollection,
      dimensions: embedding.dimensions,
      index: 'HNSW + COSINE',
      status: 'loaded',
    }));
  } finally {
    await client.closeConnection();
  }
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({
    ok: false,
    status: error instanceof RagConfigurationError ? 'BLOCKED' : 'FAIL',
    exitCode: error instanceof RagConfigurationError ? 2 : 1,
    durationMs: Date.now() - startedAt,
    errorKind: error instanceof RagConfigurationError ? 'configuration' : classifyMilvusError(error),
    message: safeMilvusMessage(error),
  }));
  process.exitCode = error instanceof RagConfigurationError ? 2 : 1;
});

