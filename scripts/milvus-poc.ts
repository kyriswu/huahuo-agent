import { randomUUID } from 'node:crypto';
import {
  DataType,
  ConsistencyLevelEnum,
  IndexState,
  IndexType,
  LoadState,
  MetricType,
  MilvusClient,
  type FieldSchema,
} from '@zilliz/milvus2-sdk-node';
import { createMilvusClient, classifyMilvusError, safeMilvusMessage } from '../src/adapters/rag/milvus-client.ts';
import { MilvusDenseSearchAdapter } from '../src/adapters/rag/milvus-dense-search.ts';
import { loadMilvusPocConfig } from '../src/extensions/huahuo/rag/milvus-poc-config.ts';

type PocRow = {
  id: string;
  run_id: string;
  source_id: string;
  content: string;
  embedding: number[];
};

const VECTOR_FIELD = 'embedding';
const INDEX_NAME = 'huahuo_rag_poc_dense_hnsw_cosine';
const INDEX_PARAMS = { M: 16, efConstruction: 128 };
const SEARCH_PARAMS = { ef: 64 };
const POLL_INTERVAL_MS = 250;
const MAX_WAIT_MS = 30_000;

const SAMPLE_ROWS: Omit<PocRow, 'id' | 'run_id'>[] = [
  { source_id: 'poc-source-1', content: 'Apple fruit', embedding: [1, 0, 0, 0] },
  { source_id: 'poc-source-2', content: 'Red apple', embedding: [0.9, 0.1, 0, 0] },
  { source_id: 'poc-source-3', content: 'Ocean water', embedding: [0, 1, 0, 0] },
  { source_id: 'poc-source-4', content: 'Mountain rocks', embedding: [0, 0, 1, 0] },
];

function responseStatus(response: {
  status?: { error_code?: unknown; reason?: unknown };
  error_code?: unknown;
  reason?: unknown;
}): { code: string; reason?: string } {
  return {
    code: String(response.status?.error_code ?? response.error_code ?? 'Success'),
    ...(response.status?.reason || response.reason
      ? { reason: String(response.status?.reason ?? response.reason) }
      : {}),
  };
}

function ensureSuccess(
  response: {
    status?: { error_code?: unknown; reason?: unknown };
    error_code?: unknown;
    reason?: unknown;
  },
  operation: string,
): void {
  const { code, reason } = responseStatus(response);
  if (code !== 'Success' && code !== '0') {
    throw new Error(`${operation} failed (${code})${reason ? `: ${reason.slice(0, 240)}` : ''}`);
  }
}

function normalizeType(field: FieldSchema): string {
  return String(field.data_type ?? field.dataType);
}

function fieldParam(field: FieldSchema, key: string): unknown {
  const direct = (field as unknown as Record<string, unknown>)[key];
  if (direct !== undefined) return direct;
  const params = field.type_params;
  return params?.find((item) => item.key === key)?.value;
}

function schemaMismatches(
  fields: FieldSchema[],
  dim: number,
  enableDynamicField: boolean,
): string[] {
  const expected: Record<string, { type: string; maxLength?: number; dim?: number; primary?: boolean }> = {
    id: { type: 'VarChar', maxLength: 128, primary: true },
    run_id: { type: 'VarChar', maxLength: 96 },
    source_id: { type: 'VarChar', maxLength: 128 },
    content: { type: 'VarChar', maxLength: 4096 },
    embedding: { type: 'FloatVector', dim, },
  };
  const mismatches: string[] = [];
  for (const [name, expectation] of Object.entries(expected)) {
    const field = fields.find((candidate) => candidate.name === name);
    if (!field) {
      mismatches.push(`${name}: missing`);
      continue;
    }
    const actualType = normalizeType(field);
    if (actualType !== expectation.type && actualType !== String(DataType[expectation.type as keyof typeof DataType])) {
      mismatches.push(`${name}: type=${actualType}, expected=${expectation.type}`);
    }
    if (expectation.maxLength !== undefined && Number(fieldParam(field, 'max_length')) !== expectation.maxLength) {
      mismatches.push(`${name}: max_length=${String(fieldParam(field, 'max_length'))}, expected=${expectation.maxLength}`);
    }
    if (expectation.dim !== undefined && Number(fieldParam(field, 'dim')) !== expectation.dim) {
      mismatches.push(`${name}: dim=${String(fieldParam(field, 'dim'))}, expected=${expectation.dim}`);
    }
    if (expectation.primary !== undefined && Boolean(field.is_primary_key) !== expectation.primary) {
      mismatches.push(`${name}: is_primary_key=${String(field.is_primary_key)}, expected=${expectation.primary}`);
    }
    if (name === 'id' && field.autoID !== false) {
      mismatches.push(`${name}: autoID=${String(field.autoID)}, expected=false`);
    }
  }
  const unexpected = fields.filter((field) => !(field.name in expected)).map((field) => field.name);
  if (unexpected.length > 0) mismatches.push(`unexpected fields=${unexpected.join(',')}`);
  if (enableDynamicField) mismatches.push('enable_dynamic_field=true, expected=false');
  return mismatches;
}

async function waitForIndex(client: MilvusClient, collection: string): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < MAX_WAIT_MS) {
    const response = await client.getIndexState({ collection_name: collection, field_name: VECTOR_FIELD });
    ensureSuccess(response, 'getIndexState');
    if (response.state === IndexState.Finished || String(response.state) === 'Finished') return;
    if (response.state === IndexState.Failed || String(response.state) === 'Failed') {
      throw new Error('HNSW index build failed');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error(`Timed out waiting for index build after ${MAX_WAIT_MS} ms`);
}

async function waitForLoad(client: MilvusClient, collection: string): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < MAX_WAIT_MS) {
    const response = await client.getLoadState({ collection_name: collection });
    ensureSuccess(response, 'getLoadState');
    if (response.state === LoadState.LoadStateLoaded || String(response.state) === 'Loaded') return;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error(`Timed out waiting for collection load after ${MAX_WAIT_MS} ms`);
}

function queryVectorFromArgs(dim: number): number[] {
  const argument = process.argv.find((value) => value.startsWith('--query-vector='));
  if (!argument) return [1, 0, 0, 0];
  let parsed: unknown;
  try {
    parsed = JSON.parse(argument.slice('--query-vector='.length));
  } catch {
    throw new Error('Query vector argument must be valid JSON, for example [1,0,0,0]');
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== dim ||
    parsed.some((value) => typeof value !== 'number' || !Number.isFinite(value))
  ) {
    throw new Error(`Query vector must be a finite numeric array with dimension ${dim}`);
  }
  return parsed;
}

async function ensureCollection(client: MilvusClient, collection: string, dim: number): Promise<'created' | 'existing'> {
  const exists = await client.hasCollection({ collection_name: collection });
  ensureSuccess(exists, 'hasCollection');
  if (exists.value) {
    const description = await client.describeCollection({ collection_name: collection });
    ensureSuccess(description, 'describeCollection');
    const mismatches = schemaMismatches(
      description.schema.fields,
      dim,
      description.schema.enable_dynamic_field,
    );
    if (mismatches.length > 0) {
      throw new Error(`Existing collection schema is incompatible: ${mismatches.join('; ')}`);
    }
    return 'existing';
  }

  const response = await client.createCollection({
    collection_name: collection,
    enable_dynamic_field: false,
    fields: [
      { name: 'id', data_type: DataType.VarChar, is_primary_key: true, autoID: false, max_length: 128 },
      { name: 'run_id', data_type: DataType.VarChar, max_length: 96 },
      { name: 'source_id', data_type: DataType.VarChar, max_length: 128 },
      { name: 'content', data_type: DataType.VarChar, max_length: 4096 },
      { name: VECTOR_FIELD, data_type: DataType.FloatVector, dim },
    ],
  });
  ensureSuccess(response, 'createCollection');
  return 'created';
}

async function ensureIndex(client: MilvusClient, collection: string): Promise<void> {
  const descriptions = await client.describeIndex({ collection_name: collection, field_name: VECTOR_FIELD });
  const descriptionStatus = responseStatus(descriptions);
  if (
    descriptionStatus.code !== 'Success' &&
    descriptionStatus.code !== '0' &&
    !descriptionStatus.code.toLowerCase().includes('indexnotexist')
  ) {
    ensureSuccess(descriptions, 'describeIndex');
  }
  const matching = descriptionStatus.code.toLowerCase().includes('indexnotexist')
    ? undefined
    : descriptions.index_descriptions?.find((index) => {
    const params = Object.fromEntries(index.params.map((pair) => [pair.key, pair.value]));
    return params.index_type === IndexType.HNSW && params.metric_type === MetricType.COSINE;
      });
  if (!matching && descriptions.index_descriptions?.length) {
    throw new Error('Existing vector index is incompatible: expected HNSW with COSINE metric');
  }
  if (!matching) {
    const response = await client.createIndex({
      collection_name: collection,
      field_name: VECTOR_FIELD,
      index_name: INDEX_NAME,
      index_type: IndexType.HNSW,
      metric_type: MetricType.COSINE,
      params: INDEX_PARAMS,
    });
    ensureSuccess(response, 'createIndex');
  }
  await waitForIndex(client, collection);
}

async function insertRows(client: MilvusClient, collection: string, runId: string): Promise<PocRow[]> {
  const rows = SAMPLE_ROWS.map((row, index) => ({
    ...row,
    id: `${runId}-sample-${index + 1}`,
    run_id: runId,
  }));
  const response = await client.insert({ collection_name: collection, data: rows });
  ensureSuccess(response, 'insert');
  await client.flushSync({ collection_names: [collection] });
  return rows;
}

async function main(): Promise<void> {
  const config = loadMilvusPocConfig();
  const queryVector = queryVectorFromArgs(config.vectorDim);
  const runId = `poc-${randomUUID()}`;
  const client = await createMilvusClient(config);
  try {
    const collectionState = await ensureCollection(client, config.collection, config.vectorDim);
    await ensureIndex(client, config.collection);
    await client.loadCollection({ collection_name: config.collection });
    await waitForLoad(client, config.collection);
    const rows = await insertRows(client, config.collection, runId);
    const denseSearch = new MilvusDenseSearchAdapter(client, {
      collection: config.collection,
      vectorDim: config.vectorDim,
      vectorField: VECTOR_FIELD,
      searchEf: SEARCH_PARAMS.ef,
    });
    const results = await denseSearch.search({
      vector: queryVector,
      limit: 4,
      runId,
    });
    console.log(JSON.stringify({
      ok: true,
      sdk: MilvusClient.sdkInfo,
      collection: config.collection,
      collectionState,
      index: { type: IndexType.HNSW, metric: MetricType.COSINE, params: INDEX_PARAMS },
      runId,
      insertedIds: rows.map((row) => row.id),
      results,
    }));
  } finally {
    await client.closeConnection();
  }
}

main().catch((error: unknown) => {
  const kind = classifyMilvusError(error);
  console.error(JSON.stringify({
    ok: false,
    errorKind: kind,
    message: safeMilvusMessage(error),
  }));
  process.exitCode = 1;
});
