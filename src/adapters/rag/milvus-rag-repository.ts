import {
  DataType,
  IndexState,
  IndexType,
  LoadState,
  MetricType,
  type FieldSchema,
  type FieldType,
  type MilvusClient,
} from '@zilliz/milvus2-sdk-node';
import type {
  IndexVersionKey,
  RAGChunkRow,
  RagChunkRepositoryPort,
} from '../../extensions/huahuo/rag/types.ts';
import { RagError } from '../../extensions/huahuo/rag/errors.ts';

/** Backward-compatible adapter export; application code uses the domain port. */
export type RagChunkRepository = RagChunkRepositoryPort;

export const RAG_COLLECTION_NAME = 'huahuo_chunks';
export const RAG_VECTOR_FIELD = 'embedding';
export const RAG_INDEX_NAME = 'huahuo_chunks_embedding_hnsw_cosine';
const MAX_WAIT_MS = 30_000;
const POLL_INTERVAL_MS = 250;

export function createRagChunkSchema(vectorDimensions: number): FieldType[] {
  if (!Number.isInteger(vectorDimensions) || vectorDimensions <= 0) {
    throw new RagError('RAG_CONFIG_INVALID', 'Formal RAG collection requires a positive embedding dimension');
  }
  return [
    { name: 'chunk_id', data_type: DataType.VarChar, is_primary_key: true, autoID: false, max_length: 256 },
    { name: 'tenant_id', data_type: DataType.VarChar, max_length: 256 },
    { name: 'owner_id', data_type: DataType.VarChar, max_length: 256 },
    { name: 'knowledge_base_id', data_type: DataType.VarChar, max_length: 256 },
    { name: 'source_id', data_type: DataType.VarChar, max_length: 256 },
    { name: 'run_id', data_type: DataType.VarChar, max_length: 128 },
    { name: 'source_type', data_type: DataType.VarChar, max_length: 32 },
    { name: 'title', data_type: DataType.VarChar, max_length: 512 },
    { name: 'document_id', data_type: DataType.VarChar, max_length: 256 },
    { name: 'document_version', data_type: DataType.VarChar, max_length: 128 },
    { name: 'chunk_index', data_type: DataType.Int32 },
    { name: 'content_hash', data_type: DataType.VarChar, max_length: 64 },
    { name: 'pipeline_version', data_type: DataType.VarChar, max_length: 128 },
    { name: 'chunker_version', data_type: DataType.VarChar, max_length: 128 },
    { name: 'document_version_state', data_type: DataType.VarChar, max_length: 16 },
    // The 2.6.17 Node SDK rejects JSON fields during collection creation
    // (even though newer Milvus servers can store JSON). Keep these derived
    // values as compact JSON strings until the SDK/server contract is
    // explicitly upgraded and re-validated.
    { name: 'heading_path', data_type: DataType.VarChar, max_length: 4096 },
    { name: 'text', data_type: DataType.VarChar, max_length: 16_384 },
    { name: 'embedding_model', data_type: DataType.VarChar, max_length: 256 },
    { name: 'embedding_dimensions', data_type: DataType.Int32 },
    { name: 'created_at', data_type: DataType.Int64 },
    { name: 'metadata', data_type: DataType.VarChar, max_length: 16_384 },
    { name: RAG_VECTOR_FIELD, data_type: DataType.FloatVector, dim: vectorDimensions },
  ];
}

function responseCode(response: {
  status?: { error_code?: unknown; reason?: unknown };
  error_code?: unknown;
}): string {
  return String(response.status?.error_code ?? response.error_code ?? 'Success');
}

function responseReason(response: { status?: { reason?: unknown }; reason?: unknown }): string {
  return response.status?.reason || response.reason
    ? String(response.status?.reason ?? response.reason).slice(0, 300)
    : '';
}

function ensureSuccess(
  response: {
    status?: { error_code?: unknown; reason?: unknown };
    error_code?: unknown;
    reason?: unknown;
  },
  operation: string,
): void {
  const code = responseCode(response);
  if (code !== 'Success' && code !== '0') {
    throw new RagError('MILVUS_UNAVAILABLE', `${operation} failed (${code})${responseReason(response) ? `: ${responseReason(response)}` : ''}`, {
      retryable: true,
    });
  }
}

function fieldParam(field: FieldSchema, key: string): unknown {
  const direct = (field as unknown as Record<string, unknown>)[key];
  if (direct !== undefined) return direct;
  return field.type_params?.find((item) => item.key === key)?.value;
}

function fieldType(field: FieldSchema): string {
  return String(field.data_type ?? field.dataType);
}

function schemaMismatches(fields: FieldSchema[], dimensions: number, dynamicField: boolean): string[] {
  const expected = createRagChunkSchema(dimensions);
  const mismatches: string[] = [];
  for (const expectedField of expected) {
    const actual = fields.find((field) => field.name === expectedField.name);
    if (!actual) {
      mismatches.push(`${expectedField.name}: missing`);
      continue;
    }
    const expectedType = String(expectedField.data_type);
    const actualType = fieldType(actual);
    if (actualType !== expectedType && actualType !== DataType[expectedField.data_type as keyof typeof DataType]?.toString()) {
      mismatches.push(`${expectedField.name}: type=${actualType}, expected=${expectedType}`);
    }
    const expectedMaxLength = (expectedField as FieldType & { max_length?: number }).max_length;
    if (expectedMaxLength !== undefined && Number(fieldParam(actual, 'max_length')) !== expectedMaxLength) {
      mismatches.push(`${expectedField.name}: max_length=${String(fieldParam(actual, 'max_length'))}, expected=${expectedMaxLength}`);
    }
    const expectedDim = (expectedField as FieldType & { dim?: number }).dim;
    if (expectedDim !== undefined && Number(fieldParam(actual, 'dim')) !== expectedDim) {
      mismatches.push(`${expectedField.name}: dim=${String(fieldParam(actual, 'dim'))}, expected=${expectedDim}`);
    }
    if (expectedField.is_primary_key !== undefined && Boolean(actual.is_primary_key) !== expectedField.is_primary_key) {
      mismatches.push(`${expectedField.name}: is_primary_key=${String(actual.is_primary_key)}, expected=${String(expectedField.is_primary_key)}`);
    }
    if (expectedField.autoID !== undefined && Boolean(actual.autoID) !== expectedField.autoID) {
      mismatches.push(`${expectedField.name}: autoID=${String(actual.autoID)}, expected=${String(expectedField.autoID)}`);
    }
  }
  const expectedNames = new Set(expected.map((field) => field.name));
  const unexpected = fields.filter((field) => !expectedNames.has(field.name)).map((field) => field.name);
  if (unexpected.length > 0) mismatches.push(`unexpected fields=${unexpected.join(',')}`);
  const primaryFields = fields.filter((field) => field.is_primary_key).map((field) => field.name);
  if (primaryFields.length !== 1 || primaryFields[0] !== 'chunk_id') {
    mismatches.push(`primary_fields=${primaryFields.join(',')}, expected=chunk_id`);
  }
  if (dynamicField) mismatches.push('enable_dynamic_field=true, expected=false');
  return mismatches;
}

function escapeFilterValue(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

function serializeJsonString(value: unknown, fieldName: string): string {
  try {
    const serialized = JSON.stringify(value);
    if (typeof serialized !== 'string') throw new Error('empty serialization');
    return serialized;
  } catch (error) {
    throw new RagError('INGEST_FAILED', `${fieldName} is not JSON serializable`, { cause: error });
  }
}

function versionFilter(key: IndexVersionKey, state?: RAGChunkRow['documentVersionState']): string {
  const parts = [
    `document_id == "${escapeFilterValue(key.documentId)}"`,
    `document_version == "${escapeFilterValue(key.documentVersion)}"`,
    `content_hash == "${escapeFilterValue(key.contentHash)}"`,
    `pipeline_version == "${escapeFilterValue(key.pipelineVersion)}"`,
    `embedding_model == "${escapeFilterValue(key.embeddingModel)}"`,
    `embedding_dimensions == ${key.embeddingDimensions}`,
  ];
  if (state) parts.push(`document_version_state == "${escapeFilterValue(state)}"`);
  return parts.join(' && ');
}

async function waitForIndex(client: MilvusClient, collection: string): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < MAX_WAIT_MS) {
    const response = await client.getIndexState({ collection_name: collection, field_name: RAG_VECTOR_FIELD });
    ensureSuccess(response, 'getIndexState');
    if (response.state === IndexState.Finished || String(response.state) === 'Finished') return;
    if (response.state === IndexState.Failed || String(response.state) === 'Failed') {
      throw new RagError('MILVUS_UNAVAILABLE', 'Formal RAG vector index build failed', { retryable: false });
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new RagError('MILVUS_UNAVAILABLE', 'Timed out waiting for formal RAG vector index', { retryable: true });
}

async function waitForLoad(client: MilvusClient, collection: string): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < MAX_WAIT_MS) {
    const response = await client.getLoadState({ collection_name: collection });
    ensureSuccess(response, 'getLoadState');
    if (response.state === LoadState.LoadStateLoaded || String(response.state) === 'Loaded') return;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new RagError('MILVUS_UNAVAILABLE', 'Timed out waiting for formal RAG collection load', { retryable: true });
}

export class MilvusRagRepository implements RagChunkRepositoryPort {
  private readonly client: MilvusClient;
  private readonly collection: string;

  constructor(
    client: MilvusClient,
    collection = RAG_COLLECTION_NAME,
  ) {
    this.client = client;
    this.collection = collection;
  }

  async ensureReady(vectorDimensions: number, options: { createIfMissing?: boolean } = {}): Promise<void> {
    const exists = await this.client.hasCollection({ collection_name: this.collection });
    ensureSuccess(exists, 'hasCollection');
    if (!exists.value) {
      if (options.createIfMissing === false) {
        throw new RagError(
          'MILVUS_UNAVAILABLE',
          `Formal RAG collection ${this.collection} does not exist; run the explicit initialization command first`,
          { retryable: false },
        );
      }
      const created = await this.client.createCollection({
        collection_name: this.collection,
        enable_dynamic_field: false,
        fields: createRagChunkSchema(vectorDimensions),
      });
      ensureSuccess(created, 'createCollection');
    } else {
      const description = await this.client.describeCollection({ collection_name: this.collection });
      ensureSuccess(description, 'describeCollection');
      const mismatches = schemaMismatches(
        description.schema.fields,
        vectorDimensions,
        description.schema.enable_dynamic_field,
      );
      if (mismatches.length > 0) {
        throw new RagError(
          'MILVUS_SCHEMA_INCOMPATIBLE',
          `Formal RAG collection schema is incompatible: ${mismatches.join('; ')}`,
        );
      }
    }

    const indexes = await this.client.describeIndex({ collection_name: this.collection, field_name: RAG_VECTOR_FIELD });
    const indexCode = responseCode(indexes);
    const indexReason = responseReason(indexes);
    const indexMissing = indexCode.toLowerCase().includes('indexnotexist')
      || indexReason.toLowerCase().includes('indexnotexist');
    if (indexCode !== 'Success' && indexCode !== '0' && !indexMissing) {
      throw new RagError(
        'MILVUS_UNAVAILABLE',
        `describeIndex failed (${indexCode})${indexReason ? `: ${indexReason}` : ''}`,
        { retryable: true },
      );
    }
    const matching = indexMissing
      ? undefined
      : indexes.index_descriptions?.find((index) => {
          const params = Object.fromEntries((index.params ?? []).map((pair) => [pair.key, pair.value]));
          return String(params.index_type).toUpperCase() === String(IndexType.HNSW).toUpperCase()
            && String(params.metric_type).toUpperCase() === String(MetricType.COSINE).toUpperCase();
        });
    if (!matching && indexes.index_descriptions?.length) {
      throw new RagError('MILVUS_SCHEMA_INCOMPATIBLE', 'Formal RAG vector index is not HNSW + COSINE');
    }
    if (!matching) {
      const createdIndex = await this.client.createIndex({
        collection_name: this.collection,
        field_name: RAG_VECTOR_FIELD,
        index_name: RAG_INDEX_NAME,
        index_type: IndexType.HNSW,
        metric_type: MetricType.COSINE,
        params: { M: 16, efConstruction: 128 },
      });
      ensureSuccess(createdIndex, 'createIndex');
    }
    await waitForIndex(this.client, this.collection);
    const loaded = await this.client.loadCollection({ collection_name: this.collection });
    ensureSuccess(loaded, 'loadCollection');
    await waitForLoad(this.client, this.collection);
  }

  async upsertChunks(rows: RAGChunkRow[]): Promise<void> {
    if (rows.length === 0) return;
    const response = await this.client.upsert({
      collection_name: this.collection,
      data: rows.map((row) => ({
        chunk_id: row.chunkId,
        tenant_id: row.tenantId,
        owner_id: row.ownerId,
        knowledge_base_id: row.knowledgeBaseId,
        source_id: row.sourceId,
        run_id: row.runId ?? 'application',
        source_type: row.sourceType,
        title: row.title,
        document_id: row.documentId,
        document_version: row.documentVersion,
        chunk_index: row.chunkIndex,
        content_hash: row.contentHash,
        pipeline_version: row.pipelineVersion,
        chunker_version: row.chunkerVersion,
        document_version_state: row.documentVersionState,
        heading_path: serializeJsonString(row.headingPath, 'heading_path'),
        text: row.text,
        embedding_model: row.embeddingModel,
        embedding_dimensions: row.embeddingDimensions,
        created_at: Date.now(),
        metadata: serializeJsonString(row.metadata ?? {}, 'metadata'),
        embedding: row.embedding,
      })),
    });
    ensureSuccess(response, 'upsert');
  }

  async countVersionChunks(
    key: IndexVersionKey,
    state: RAGChunkRow['documentVersionState'],
  ): Promise<number> {
    const response = await this.client.query({
      collection_name: this.collection,
      filter: versionFilter(key, state),
      output_fields: ['chunk_id'],
      limit: 16_384,
      consistency_level: 0,
    });
    ensureSuccess(response, 'query');
    return response.data?.length ?? 0;
  }
}

