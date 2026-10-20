import { createMilvusClient, classifyMilvusError, safeMilvusMessage } from '../src/adapters/rag/milvus-client.ts';
import { MilvusRagRepository } from '../src/adapters/rag/milvus-rag-repository.ts';
import {
  loadMilvusConnectionConfig,
} from '../src/extensions/huahuo/rag/milvus-poc-config.ts';
import {
  loadRagConfig,
  requireRealEmbeddingConfig,
} from '../src/extensions/huahuo/rag/config.ts';

async function main(): Promise<void> {
  const ragConfig = loadRagConfig();
  const embedding = requireRealEmbeddingConfig(ragConfig);
  const connection = loadMilvusConnectionConfig();
  const client = await createMilvusClient(connection);
  try {
    const repository = new MilvusRagRepository(client, ragConfig.ragCollection);
    await repository.ensureReady(embedding.dimensions);
    console.log(JSON.stringify({
      ok: true,
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
    errorKind: classifyMilvusError(error),
    message: safeMilvusMessage(error),
  }));
  process.exitCode = 1;
});

