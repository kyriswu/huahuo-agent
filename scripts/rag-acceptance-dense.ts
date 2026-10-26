import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chunkMarkdown, normalizeMarkdown, sha256 } from '../src/application/rag/chunk-markdown.ts';
import { InMemoryDocumentVersionStore } from '../src/application/rag/document-version-service.ts';
import { ingestDocument } from '../src/application/rag/ingest-document.ts';
import { OpenAICompatibleEmbeddingClient, createEmbeddingClient } from '../src/adapters/rag/embedding-client.ts';
import { createMilvusClient, classifyMilvusError, safeMilvusMessage } from '../src/adapters/rag/milvus-client.ts';
import {
  MilvusDenseSearchAdapter,
  type DenseSearchResult,
} from '../src/adapters/rag/milvus-dense-search.ts';
import {
  MilvusRagRepository,
  type RagChunkRepository,
} from '../src/adapters/rag/milvus-rag-repository.ts';
import { PostgresDocumentVersionStore } from '../src/adapters/rag/postgres-document-version-store.ts';
import { PostgresRagChunkStore } from '../src/adapters/rag/postgres-rag-chunk-store.ts';
import {
  loadMilvusConnectionConfig,
  type MilvusConnectionConfig,
} from '../src/extensions/huahuo/rag/milvus-poc-config.ts';
import {
  loadRagConfig,
  requireRealEmbeddingConfig,
  type RagRuntimeConfig,
} from '../src/extensions/huahuo/rag/config.ts';
import { loadRagStateDatabaseConfig } from '../src/extensions/huahuo/rag/state-config.ts';
import { RagConfigurationError, RagError } from '../src/extensions/huahuo/rag/errors.ts';
import type {
  EmbeddingClientPort,
  IndexVersionKey,
  RAGChunkRow,
  RAGDocumentInput,
  RagChunkRepositoryPort,
} from '../src/extensions/huahuo/rag/types.ts';

type Mode = 'mock' | 'real';
type CheckStatus = 'PASS' | 'FAIL' | 'BLOCKED' | 'NOT_RUN';
type OverallStatus = 'PASS' | 'FAIL' | 'BLOCKED' | 'ERROR' | 'SAFETY_ABORT';

interface AcceptanceCheck {
  checkId: string;
  name: string;
  status: CheckStatus;
  required: boolean;
  durationMs: number;
  summary: string;
  failureReason: string | null;
  usedMock: boolean;
  evidence: unknown;
}

interface AcceptanceReport {
  runId: string;
  mode: Mode;
  status: OverallStatus;
  exitCode: number;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  environmentTarget: string;
  embeddingModel: string | null;
  embeddingDimensions: number | null;
  collectionName: string;
  checks: AcceptanceCheck[];
  failures: Array<{ checkId: string; reason: string }>;
  blockedReasons: string[];
  artifacts: string[];
}

class CheckSignal extends Error {
  readonly status: Exclude<CheckStatus, 'PASS' | 'NOT_RUN'>;
  readonly evidence: unknown;

  constructor(
    status: Exclude<CheckStatus, 'PASS' | 'NOT_RUN'>,
    message: string,
    evidence: unknown = null,
  ) {
    super(message);
    this.name = 'CheckSignal';
    this.status = status;
    this.evidence = evidence;
  }
}

class SafetyAbortSignal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SafetyAbortSignal';
  }
}

const ARTIFACT_ROOT = join('artifacts', 'rag-acceptance');
const EXPECTED_COLLECTION = 'huahuo_chunks';
const EXPECTED_EMBEDDING_MODEL = 'BAAI/bge-m3';
const EXPECTED_EMBEDDING_DIMENSIONS = 1024;
const EXPECTED_ENVIRONMENT = 'milvus-huahuo-test';
const EXPECTED_MILVUS_HOST = 'c-850eb68e967e1f3a.milvus.aliyuncs.com';
const EXPECTED_MILVUS_PORT = '19530';

function nowIso(): string {
  return new Date().toISOString();
}

function parseMode(argv: string[]): Mode {
  const raw = argv.find((value) => value.startsWith('--mode='))?.slice('--mode='.length)
    ?? (() => {
      const index = argv.indexOf('--mode');
      return index >= 0 ? argv[index + 1] : undefined;
    })();
  if (raw === 'mock' || raw === 'real') return raw;
  throw new CheckSignal('BLOCKED', 'Use --mode=mock or --mode=real');
}

function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/(api[-_ ]?key|password|passwd|token|authorization)\s*[:=]\s*\S+/gi, '$1=[redacted]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\b(root|admin|user):[^\s]+@/gi, '$1:[redacted]@')
    .replace(/\b(postgres(?:ql)?|https?):\/\/[^\s/:@]+:[^\s@]+@/gi, '$1://[redacted]@')
    .slice(0, 400);
}

function assertCondition(condition: unknown, message: string, evidence: unknown = null): asserts condition {
  if (!condition) throw new CheckSignal('FAIL', message, evidence);
}

function getRequiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new CheckSignal('BLOCKED', `Missing required acceptance setting: ${name}`);
  return value;
}

function expectedAddress(address: string): boolean {
  const withoutScheme = address.replace(/^\w+:\/\//, '');
  const lastColon = withoutScheme.lastIndexOf(':');
  if (lastColon <= 0) return false;
  return withoutScheme.slice(0, lastColon) === EXPECTED_MILVUS_HOST
    && withoutScheme.slice(lastColon + 1) === EXPECTED_MILVUS_PORT;
}

function makeCheck(
  checks: AcceptanceCheck[],
  spec: Pick<AcceptanceCheck, 'checkId' | 'name' | 'required' | 'usedMock'>,
  action: () => Promise<{ summary: string; evidence?: unknown }>,
): Promise<void> {
  const started = Date.now();
  return action()
    .then((result) => {
      checks.push({
        ...spec,
        status: 'PASS',
        durationMs: Date.now() - started,
        summary: result.summary,
        failureReason: null,
        evidence: result.evidence ?? null,
      });
    })
    .catch((error: unknown) => {
      if (error instanceof CheckSignal) {
        checks.push({
          ...spec,
          status: error.status,
          durationMs: Date.now() - started,
          summary: error.status === 'BLOCKED' ? '前置条件不足，未完成此检查' : '检查未通过',
          failureReason: error.message,
          evidence: error.evidence,
        });
        return;
      }
      checks.push({
        ...spec,
        status: 'FAIL',
        durationMs: Date.now() - started,
        summary: '验收程序出现未预期异常',
        failureReason: safeMessage(error),
        evidence: null,
      });
      throw error;
    });
}

class DeterministicMockEmbedding implements EmbeddingClientPort {
  calls = 0;

  async embed(texts: string[]): Promise<number[][]> {
    this.calls += 1;
    return texts.map((text) => {
      const digest = createHash('sha256').update(text, 'utf8').digest();
      return [digest[0] / 255, digest[1] / 255, digest[2] / 255, digest[3] / 255];
    });
  }
}

class MockChunkRepository implements RagChunkRepositoryPort {
  readonly rows = new Map<string, RAGChunkRow>();
  failOnCall?: number;
  calls = 0;

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

function acceptanceInput(runId: string, suffix: string, content: string, version = 'v1'): RAGDocumentInput {
  return {
    sourceId: `acceptance-${runId}-${suffix}`,
    sourceType: 'article',
    documentId: `acceptance-${suffix}`,
    documentVersion: version,
    title: `Dense acceptance ${suffix}`,
    content,
    tenantId: `acceptance-tenant-${runId}`,
    ownerId: `acceptance-owner-${runId}`,
    knowledgeBaseId: `acceptance-kb-${runId}`,
    runId,
  };
}

const mockOptions = {
  pipelineVersion: 'acceptance-v1',
  embeddingModel: 'mock-deterministic-v1',
  embeddingDimensions: 4,
  maxTokens: 40,
  overlapTokens: 5,
  batchSize: 2,
};

async function runMockAcceptance(runId: string, checks: AcceptanceCheck[]): Promise<void> {
  const embedding = new DeterministicMockEmbedding();
  const repository = new MockChunkRepository();
  const versionStore = new InMemoryDocumentVersionStore();
  const input = acceptanceInput(runId, 'flow', '# Flow\n\nA deterministic dense acceptance document.');

  await makeCheck(checks, {
    checkId: 'mock-data-flow-idempotency',
    name: 'Mock 数据流、重复入库和版本切换',
    required: true,
    usedMock: true,
  }, async () => {
    const first = await ingestDocument(input, mockOptions, { embedding, repository, versionStore });
    const firstRows = repository.rows.size;
    const duplicate = await ingestDocument(input, mockOptions, { embedding, repository, versionStore });
    const updated = await ingestDocument(
      { ...input, documentVersion: 'v2', content: `${input.content}\n\nUpdated version.` },
      mockOptions,
      { embedding, repository, versionStore },
    );
    assertCondition(first.status === 'visible', '首次 Mock 入库未进入 visible');
    assertCondition(duplicate.reused, '相同内容重复入库未复用');
    assertCondition(repository.rows.size >= firstRows, '重复入库导致异常行数变化');
    assertCondition(updated.documentId === first.documentId, '版本更新改变了 documentId');
    assertCondition(updated.contentHash !== first.contentHash, '版本更新未改变 contentHash');
    assertCondition((await versionStore.findByDocumentVersion(input.documentId, 'v1'))[0]?.status === 'superseded', '新版本成功后旧版本未 superseded');
    return {
      summary: 'Mock 首次入库、重复复用和新版本切换通过',
      evidence: {
        firstStatus: first.status,
        duplicateReused: duplicate.reused,
        firstChunkCount: first.chunkCount,
        updatedChunkCount: updated.chunkCount,
        embeddingCalls: embedding.calls,
        runId,
      },
    };
  });

  await makeCheck(checks, {
    checkId: 'mock-failure-recovery',
    name: 'Mock 部分批次失败、重试和旧版本保护',
    required: true,
    usedMock: true,
  }, async () => {
    const failureEmbedding = new DeterministicMockEmbedding();
    const failureRepository = new MockChunkRepository();
    const failureStore = new InMemoryDocumentVersionStore();
    const base = acceptanceInput(runId, 'recovery', '# Recovery\n\none two three four five six seven eight nine ten eleven twelve.');
    await ingestDocument(base, mockOptions, { embedding: failureEmbedding, repository: failureRepository, versionStore: failureStore });
    failureRepository.failOnCall = failureRepository.calls + 2;
    const nextInput = { ...base, documentVersion: 'v2', content: `${base.content}\n\nFailure candidate.` };
    await expectReject(() => ingestDocument(nextInput, mockOptions, {
      embedding: failureEmbedding,
      repository: failureRepository,
      versionStore: failureStore,
    }), 'acceptance-injected partial batch failure');
    assertCondition((await failureStore.findByDocumentVersion(base.documentId, 'v1'))[0]?.status === 'visible', '失败版本影响了旧 visible 版本');
    const retried = await ingestDocument(nextInput, mockOptions, {
      embedding: failureEmbedding,
      repository: failureRepository,
      versionStore: failureStore,
    });
    assertCondition(retried.status === 'visible', '失败版本重试未成功');
    assertCondition(new Set(failureRepository.rows.keys()).size === failureRepository.rows.size, '重试产生重复 chunk ID');
    return {
      summary: 'Mock 故障注入后旧版本保持可用，重试无重复 ID',
      evidence: {
        retriedStatus: retried.status,
        chunkCount: retried.chunkCount,
        storedRows: failureRepository.rows.size,
      },
    };
  });

  await makeCheck(checks, {
    checkId: 'mock-invalid-embedding',
    name: 'Mock 无效 Embedding 维度拒绝写入',
    required: true,
    usedMock: true,
  }, async () => {
    const badEmbedding: EmbeddingClientPort = { embed: async () => [[1, 2]] };
    const badRepository = new MockChunkRepository();
    const badStore = new InMemoryDocumentVersionStore();
    const badInput = acceptanceInput(runId, 'invalid-embedding', 'A document with invalid mock dimensions.');
    await expectReject(() => ingestDocument(badInput, mockOptions, {
      embedding: badEmbedding,
      repository: badRepository,
      versionStore: badStore,
    }), 'Embedding dimension does not match configured dimension');
    const records = await badStore.findByDocumentVersion(badInput.documentId, badInput.documentVersion);
    assertCondition(records[0]?.status === 'failed', '无效 Embedding 后状态不是 failed');
    assertCondition(badRepository.rows.size === 0, '无效 Embedding 被写入 Mock Repository');
    return { summary: '无效维度被拒绝且未写入 Chunk', evidence: { status: records[0]?.status ?? null } };
  });
}

async function expectReject(action: () => Promise<unknown>, expectedText: string): Promise<void> {
  try {
    await action();
  } catch (error) {
    assertCondition(safeMessage(error).includes(expectedText), `错误信息未包含预期文本: ${expectedText}`);
    return;
  }
  throw new CheckSignal('FAIL', '预期操作失败但实际成功');
}

interface RealContext {
  client: Awaited<ReturnType<typeof createMilvusClient>>;
  repository: MilvusRagRepository;
  versionStore: PostgresDocumentVersionStore;
  contentStore: PostgresRagChunkStore;
  embedding: EmbeddingClientPort;
  ragConfig: RagRuntimeConfig;
  embeddingModel: string;
  embeddingDimensions: number;
  connection: MilvusConnectionConfig;
  stateDatabaseTarget: string;
}

async function realPreflight(): Promise<RealContext> {
  if (process.env.RAG_ACCEPTANCE_ALLOW_REAL !== 'true') {
    throw new CheckSignal('BLOCKED', '需要显式设置 RAG_ACCEPTANCE_ALLOW_REAL=true');
  }
  if (process.env.RAG_ACCEPTANCE_ALLOW_WRITES !== 'true') {
    throw new CheckSignal('BLOCKED', '需要显式设置 RAG_ACCEPTANCE_ALLOW_WRITES=true');
  }
  const target = process.env.RAG_ACCEPTANCE_ENVIRONMENT_TARGET?.trim();
  if (!target) throw new CheckSignal('BLOCKED', `需要显式设置 RAG_ACCEPTANCE_ENVIRONMENT_TARGET=${EXPECTED_ENVIRONMENT}`);
  if (target !== EXPECTED_ENVIRONMENT) throw new SafetyAbortSignal(`验收目标不是授权测试环境: ${target}`);

  let ragConfig: RagRuntimeConfig;
  let embeddingConfig: ReturnType<typeof requireRealEmbeddingConfig>;
  let connection: MilvusConnectionConfig;
  try {
    ragConfig = loadRagConfig();
    embeddingConfig = requireRealEmbeddingConfig(ragConfig);
    connection = loadMilvusConnectionConfig();
  } catch (error) {
    throw new CheckSignal('BLOCKED', safeMessage(error));
  }
  let stateDatabase: ReturnType<typeof loadRagStateDatabaseConfig>;
  try {
    stateDatabase = loadRagStateDatabaseConfig(process.env, { requireTarget: true });
  } catch (error) {
    throw new CheckSignal('BLOCKED', safeMessage(error));
  }
  if (ragConfig.ragCollection !== EXPECTED_COLLECTION) {
    throw new SafetyAbortSignal(`验收 Collection 必须为 ${EXPECTED_COLLECTION}`);
  }
  if (embeddingConfig.model !== EXPECTED_EMBEDDING_MODEL || embeddingConfig.dimensions !== EXPECTED_EMBEDDING_DIMENSIONS) {
    throw new CheckSignal(
      'BLOCKED',
      `真实验收固定使用 ${EXPECTED_EMBEDDING_MODEL} / ${EXPECTED_EMBEDDING_DIMENSIONS} 维；当前配置不匹配`,
      { configuredModel: embeddingConfig.model, configuredDimensions: embeddingConfig.dimensions },
    );
  }
  if (!expectedAddress(connection.address)) {
    throw new SafetyAbortSignal('Milvus 地址不是已授权的测试实例 host:19530');
  }
  if (connection.database !== 'default') {
    throw new SafetyAbortSignal('验收数据库必须为 default');
  }
  if (process.env.MILVUS_POC_COLLECTION?.trim() === EXPECTED_COLLECTION) {
    throw new SafetyAbortSignal('PoC Collection 不得与正式 Collection 相同');
  }

  let client: RealContext['client'];
  const versionStore = PostgresDocumentVersionStore.fromConnectionString(stateDatabase.url);
  const contentStore = PostgresRagChunkStore.fromConnectionString(stateDatabase.url);
  try {
    await versionStore.ping();
  } catch (error) {
    await versionStore.close().catch(() => undefined);
    await contentStore.close().catch(() => undefined);
    throw new CheckSignal('BLOCKED', 'RAG_STATE_DATABASE_URL test database is unavailable', {
      errorKind: 'postgresql',
    });
  }
  try {
    client = await createMilvusClient(connection);
  } catch (error) {
    await versionStore.close().catch(() => undefined);
    await contentStore.close().catch(() => undefined);
    const kind = classifyMilvusError(error);
    if (kind === 'network' || kind === 'timeout') {
      throw new CheckSignal('BLOCKED', `Milvus ${kind}，真实验收无法开始`);
    }
    throw new CheckSignal('FAIL', `Milvus ${kind} 连接失败`);
  }
  const repository = new MilvusRagRepository(client, ragConfig.ragCollection);
  try {
    await repository.ensureReady(embeddingConfig.dimensions, { createIfMissing: false });
  } catch (error) {
    await client.closeConnection();
    await versionStore.close().catch(() => undefined);
    await contentStore.close().catch(() => undefined);
    if (error instanceof RagError && error.code === 'MILVUS_SCHEMA_INCOMPATIBLE') {
      throw new SafetyAbortSignal(error.message);
    }
    if (error instanceof RagError && error.code === 'MILVUS_UNAVAILABLE' && /does not exist/.test(error.message)) {
      throw new CheckSignal('BLOCKED', error.message);
    }
    throw new CheckSignal('FAIL', safeMessage(error));
  }
  return {
    client,
    repository,
    versionStore,
    contentStore,
    embedding: createEmbeddingClient(ragConfig.embedding),
    ragConfig,
    embeddingModel: embeddingConfig.model,
    embeddingDimensions: embeddingConfig.dimensions,
    connection,
    stateDatabaseTarget: stateDatabase.target,
  };
}

const realDocuments = [
  {
    suffix: 'chinese-meeting',
    content: '# 项目复盘会议\n\n团队将于周五下午三点在上海办公室举行项目复盘会议。参会者需要准备本周的进度和风险清单。',
  },
  {
    suffix: 'english-apple',
    content: '# Apple Tree Care\n\nA healthy apple tree needs full sunlight, regular watering, and well-drained soil. Pruning helps improve fruit production.',
  },
  {
    suffix: 'mixed-milvus',
    content: '# Dense Retrieval\n\nMilvus uses an HNSW index with COSINE similarity for dense vector retrieval. The query vector must match the collection dimension.',
  },
];

interface QueryCase {
  queryId: string;
  queryText: string;
  expectedDocumentIds: string[];
  topK: number;
}

function realQueries(): QueryCase[] {
  return [
    {
      queryId: 'chinese-paraphrase',
      queryText: '上海办公室的项目复盘安排在什么时候？',
      expectedDocumentIds: ['acceptance-chinese-meeting'],
      topK: 3,
    },
    {
      queryId: 'english-paraphrase',
      queryText: 'What conditions help an apple tree grow fruit?',
      expectedDocumentIds: ['acceptance-english-apple'],
      topK: 3,
    },
    {
      queryId: 'mixed-terminology',
      queryText: 'Milvus 的 HNSW cosine dense vector 检索有什么维度要求？',
      expectedDocumentIds: ['acceptance-mixed-milvus'],
      topK: 3,
    },
    {
      queryId: 'semantic-paraphrase',
      queryText: '怎样通过修剪提高苹果树的结果能力？',
      expectedDocumentIds: ['acceptance-english-apple'],
      topK: 3,
    },
    {
      queryId: 'keyword-different-meaning-diagnostic',
      queryText: 'How can I reset a PostgreSQL password?',
      expectedDocumentIds: [],
      topK: 3,
    },
  ];
}

function indexKey(result: { documentId: string; documentVersion: string; contentHash: string; pipelineVersion: string; embeddingModel: string; embeddingDimensions: number }): IndexVersionKey {
  return {
    documentId: result.documentId,
    documentVersion: result.documentVersion,
    contentHash: result.contentHash,
    pipelineVersion: result.pipelineVersion,
    embeddingModel: result.embeddingModel,
    embeddingDimensions: result.embeddingDimensions,
  };
}

async function runRealAcceptance(
  runId: string,
  checks: AcceptanceCheck[],
  context: RealContext,
): Promise<void> {
  const versionStore = context.versionStore;
  const countingEmbedding = new CountingEmbedding(context.embedding);
  const options = {
    pipelineVersion: context.ragConfig.ingest.pipelineVersion,
    embeddingModel: context.embeddingModel,
    embeddingDimensions: context.embeddingDimensions,
    maxTokens: context.ragConfig.chunking.maxTokens,
    overlapTokens: context.ragConfig.chunking.overlapTokens,
    batchSize: context.ragConfig.ingest.batchSize,
    runId,
  };
  const inputs = realDocuments.map((doc) => acceptanceInput(runId, doc.suffix, doc.content));
  const results = new Map<string, Awaited<ReturnType<typeof ingestDocument>>>();

  await makeCheck(checks, {
    checkId: 'real-embedding-and-ingest',
    name: '真实 Embedding、切片和 Milvus 入库',
    required: true,
    usedMock: false,
  }, async () => {
    for (const input of inputs) {
      const result = await ingestDocument(input, options, {
        embedding: countingEmbedding,
        repository: context.repository,
        contentStore: context.contentStore,
        versionStore,
        jobStore: versionStore,
      });
      assertCondition(result.status === 'visible', `文档 ${input.documentId} 未进入 visible`);
      const count = await context.repository.countVersionChunks(indexKey(result), 'ready');
      assertCondition(count === result.chunkCount, `文档 ${input.documentId} Chunk 数量校验失败`, { count, expected: result.chunkCount });
      results.set(input.documentId, result);
    }
    return {
      summary: `真实入库 ${results.size} 篇文档，Embedding 批次数 ${countingEmbedding.calls}`,
      evidence: {
        runId,
        documents: [...results.values()].map((result) => ({
          documentId: result.documentId,
          documentVersion: result.documentVersion,
          contentHash: result.contentHash,
          chunkCount: result.chunkCount,
          status: result.status,
        })),
        embeddingRequests: countingEmbedding.calls,
        embeddingModel: context.embeddingModel,
        embeddingDimensions: context.embeddingDimensions,
      },
    };
  });

  const search = new MilvusDenseSearchAdapter(context.client, {
    collection: EXPECTED_COLLECTION,
    vectorDim: context.embeddingDimensions,
    vectorField: 'embedding',
    searchEf: 64,
    idField: 'chunk_id',
    contentField: 'text',
    sourceIdField: 'source_id',
    runIdField: 'run_id',
    documentIdField: 'document_id',
    documentVersionField: 'document_version',
  });

  const queryEvidence: Array<Record<string, unknown>> = [];
  await makeCheck(checks, {
    checkId: 'real-dense-top-k-semantic',
    name: '真实 Dense COSINE Top-K 与语义相关性',
    required: true,
    usedMock: false,
  }, async () => {
    for (const query of realQueries()) {
      const vectors = await countingEmbedding.embed([query.queryText]);
      assertCondition(vectors.length === 1 && vectors[0]?.length === context.embeddingDimensions, `查询 ${query.queryId} Embedding 维度错误`);
      const actual = await search.search({ vector: vectors[0], limit: query.topK, runId });
      assertCondition(actual.length <= query.topK, `查询 ${query.queryId} 返回数量超过 Top-K`, {
        returned: actual.length,
        topK: query.topK,
      });
      assertCondition(actual.every((result) =>
        result.id.length > 0
        && typeof result.documentId === 'string'
        && result.documentId.length > 0
        && typeof result.documentVersion === 'string'
        && result.documentVersion.length > 0
        && result.runId === runId
        && Number.isFinite(result.score)), `查询 ${query.queryId} 返回字段无效`, {
        results: actual.map(compactResult),
      });
      const compact = actual.map(compactResult);
      const matchedExpectedDocumentIds = [...new Set(compact
        .map((result) => result.documentId)
        .filter((documentId): documentId is string => typeof documentId === 'string' && query.expectedDocumentIds.includes(documentId)))];
      const passed = query.expectedDocumentIds.length === 0
        || matchedExpectedDocumentIds.length > 0;
      queryEvidence.push({
        queryId: query.queryId,
        queryText: query.queryText,
        expectedDocumentIds: query.expectedDocumentIds,
        topK: query.topK,
        actualResults: compact,
        matchedExpectedDocumentIds,
        passed,
        failureReason: passed ? null : '预期文档未进入 Top-K',
      });
      assertCondition(passed, `查询 ${query.queryId} 未召回预期文档`, queryEvidence.at(-1));
    }
    return {
      summary: '中文、英文、中英混合和语义改写查询均完成真实 Top-K 断言；无关查询已记录诊断结果',
      evidence: { queries: queryEvidence },
    };
  });

  await makeCheck(checks, {
    checkId: 'real-idempotency',
    name: '真实重复入库幂等与 Chunk 数量',
    required: true,
    usedMock: false,
  }, async () => {
    const input = inputs[0];
    const first = results.get(input.documentId);
    assertCondition(first !== undefined, '幂等检查缺少首次入库结果');
    const before = await context.repository.countVersionChunks(indexKey(first), 'ready');
    const duplicate = await ingestDocument(input, options, {
      embedding: countingEmbedding,
      repository: context.repository,
      contentStore: context.contentStore,
      versionStore,
      jobStore: versionStore,
    });
    const after = await context.repository.countVersionChunks(indexKey(first), 'ready');
    assertCondition(duplicate.reused, '真实重复入库未返回 reused=true');
    assertCondition(before === after && after === first.chunkCount, '真实重复入库导致有效 Chunk 数量变化');
    return {
      summary: '真实重复入库复用了同一版本，Milvus 有效 Chunk 数量未增长',
      evidence: { documentId: input.documentId, before, after, reused: duplicate.reused },
    };
  });

  await makeCheck(checks, {
    checkId: 'real-version-update',
    name: '真实文档更新、版本区分与切换前保护',
    required: true,
    usedMock: false,
  }, async () => {
    const input = inputs[0];
    const old = results.get(input.documentId);
    assertCondition(old !== undefined, '版本检查缺少旧版本结果');
    const updatedInput = {
      ...input,
      documentVersion: 'v2',
      content: `${input.content}\n\n本次更新增加了新的风险复盘环节。`,
    };
    const next = await ingestDocument(updatedInput, options, {
      embedding: countingEmbedding,
      repository: context.repository,
      contentStore: context.contentStore,
      versionStore,
      jobStore: versionStore,
    });
    const oldCount = await context.repository.countVersionChunks(indexKey(old), 'ready');
    const nextCount = await context.repository.countVersionChunks(indexKey(next), 'ready');
    assertCondition(next.documentId === old.documentId, '版本更新改变了 documentId');
    assertCondition(next.documentVersion !== old.documentVersion && next.contentHash !== old.contentHash, '版本更新未产生新的版本或 Hash');
    assertCondition(oldCount === old.chunkCount && nextCount === next.chunkCount, '新旧版本 Chunk 数量校验失败');
    const versionSearch = await search.search({
      vector: (await countingEmbedding.embed([updatedInput.content]))[0],
      limit: 3,
      runId,
      filter: `document_id == "${escapeFilterValue(next.documentId)}" && document_version == "${escapeFilterValue(next.documentVersion)}"`,
    });
    assertCondition(versionSearch.every((result) => result.documentVersion === next.documentVersion), '版本过滤返回了错误版本');
    return {
      summary: '真实新版本写入成功，旧新版本可通过 documentVersion 区分；未执行删除或清空',
      evidence: {
        documentId: old.documentId,
        oldVersion: old.documentVersion,
        newVersion: next.documentVersion,
        oldChunkCount: oldCount,
        newChunkCount: nextCount,
        filteredResults: versionSearch.map(compactResult),
      },
    };
  });

  await makeCheck(checks, {
    checkId: 'real-visible-version-enforcement',
    name: '当前有效版本过滤接入',
    required: true,
    usedMock: false,
  }, async () => {
    throw new CheckSignal('BLOCKED', '当前 Dense Search Adapter 只能接收显式 filter，尚未接入持久化 visibleVersion 状态存储；不能宣称当前有效版本自动过滤通过');
  });

  await makeCheck(checks, {
    checkId: 'real-persistent-postgres-processes',
    name: 'PostgreSQL 持久化、独立进程读取、租约幂等和状态保护',
    required: true,
    usedMock: false,
  }, async () => {
    const result = await runPersistentStateProcessCheck(`${runId}-state`);
    return {
      summary: '独立 Node.js 进程完成 PostgreSQL 状态读取、幂等租约和未验证版本保护检查',
      evidence: result,
    };
  });

  await makeCheck(checks, {
    checkId: 'real-persistent-restart',
    name: '持久化状态与跨进程重启',
    required: true,
    usedMock: false,
  }, async () => {
    throw new CheckSignal('BLOCKED', '当前仅有 InMemoryDocumentVersionStore，未实现独立持久化后端，不能进行真实跨进程恢复验收');
  });
}

async function runPersistentStateProcessCheck(runId: string): Promise<Record<string, unknown>> {
  if (process.env.RAG_STATE_PROCESS_CHECK_ALLOW !== 'true') {
    throw new CheckSignal('BLOCKED', '需要显式设置 RAG_STATE_PROCESS_CHECK_ALLOW=true 才能执行独立进程 PostgreSQL 状态检查');
  }
  const script = fileURLToPath(new URL('./rag-state-process-check.ts', import.meta.url));
  const child = spawn(process.execPath, [
    '--experimental-strip-types',
    script,
    '--scenario=all',
    `--run-id=${runId}`,
  ], {
    cwd: process.cwd(),
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = await new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once('error', reject);
    child.once('close', (code) => resolve({ stdout, stderr, code }));
  });
  const line = output.stdout.trim().split('\n').at(-1) ?? '';
  let result: Record<string, unknown>;
  try {
    result = JSON.parse(line) as Record<string, unknown>;
  } catch (error) {
    throw new CheckSignal('FAIL', '独立进程状态检查未生成可解析的 JSON 结果', {
      childExitCode: output.code,
      stderr: safeMessage(output.stderr),
      parseError: safeMessage(error),
    });
  }
  if (result.status === 'BLOCKED') {
    throw new CheckSignal('BLOCKED', String(result.message ?? '独立进程状态检查被阻塞'), result);
  }
  if (result.status !== 'PASS' || output.code !== 0) {
    throw new CheckSignal('FAIL', String(result.message ?? '独立进程状态检查失败'), result);
  }
  return result;
}

function escapeFilterValue(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

function compactResult(result: DenseSearchResult): Record<string, unknown> {
  return {
    chunkId: result.id,
    textPreview: result.content.slice(0, 200),
    documentId: result.documentId ?? null,
    documentVersion: result.documentVersion ?? null,
    sourceId: result.sourceId,
    runId: result.runId,
    score: result.score,
  };
}

class CountingEmbedding implements EmbeddingClientPort {
  calls = 0;
  private readonly delegate: EmbeddingClientPort;

  constructor(delegate: EmbeddingClientPort) {
    this.delegate = delegate;
  }

  async embed(texts: string[]): Promise<number[][]> {
    this.calls += 1;
    const vectors = await this.delegate.embed(texts);
    assertCondition(vectors.length === texts.length, '真实 Embedding 返回数量不匹配');
    assertCondition(vectors.every((vector) => vector.every((value) => Number.isFinite(value))), '真实 Embedding 返回非有限数字');
    return vectors;
  }
}

function chooseOverallStatus(
  checks: AcceptanceCheck[],
  internalError: boolean,
  safetyAbort: boolean,
): { status: OverallStatus; exitCode: number } {
  if (safetyAbort) return { status: 'SAFETY_ABORT', exitCode: 4 };
  if (internalError) return { status: 'ERROR', exitCode: 3 };
  if (checks.some((check) => check.required && check.status === 'FAIL')) return { status: 'FAIL', exitCode: 1 };
  if (checks.some((check) => check.required && (check.status === 'BLOCKED' || check.status === 'NOT_RUN'))) {
    return { status: 'BLOCKED', exitCode: 2 };
  }
  return { status: 'PASS', exitCode: 0 };
}

function markdownReport(report: AcceptanceReport): string {
  const lines = [
    '# Dense RAG Acceptance Report',
    '',
    `- Status: **${report.status}** (exit ${report.exitCode})`,
    `- Mode: \`${report.mode}\``,
    `- Run ID: \`${report.runId}\``,
    `- Environment: \`${report.environmentTarget}\``,
    `- Collection: \`${report.collectionName}\``,
    `- Embedding model: \`${report.embeddingModel ?? 'not configured'}\``,
    `- Embedding dimensions: \`${report.embeddingDimensions ?? 'not configured'}\``,
    `- Duration: ${report.durationMs} ms`,
    '',
    '| Check | Required | Status | Mock | Duration | Summary |',
    '|---|---:|---|---:|---:|---|',
    ...report.checks.map((check) => `| ${check.checkId} | ${check.required ? 'yes' : 'no'} | ${check.status} | ${check.usedMock ? 'yes' : 'no'} | ${check.durationMs} ms | ${check.summary.replaceAll('|', '\\|')} |`),
    '',
    '## Failures',
    '',
    ...(report.failures.length > 0 ? report.failures.map((failure) => `- \`${failure.checkId}\`: ${failure.reason}`) : ['- None']),
    '',
    '## Blocked reasons',
    '',
    ...(report.blockedReasons.length > 0 ? report.blockedReasons.map((reason) => `- ${reason}`) : ['- None']),
    '',
    '## Artifacts',
    '',
    ...report.artifacts.map((artifact) => `- \`${artifact}\``),
    '',
    'Mock vectors are deterministic test fixtures and are not real semantic Embeddings. Real mode results are only valid when the report says `mode=real` and the corresponding checks are not blocked.',
    '',
  ];
  return lines.join('\n');
}

async function writeReports(report: AcceptanceReport): Promise<string[]> {
  const runJson = join(ARTIFACT_ROOT, 'runs', `${report.runId}.json`);
  const runMarkdown = join(ARTIFACT_ROOT, 'runs', `${report.runId}.md`);
  const latestJson = join(ARTIFACT_ROOT, 'latest.json');
  const latestMarkdown = join(ARTIFACT_ROOT, 'latest.md');
  await mkdir(join(ARTIFACT_ROOT, 'runs'), { recursive: true });
  const artifacts = [runJson, runMarkdown, latestJson, latestMarkdown];
  const finalReport = { ...report, artifacts };
  await writeFile(runJson, `${JSON.stringify(finalReport, null, 2)}\n`, 'utf8');
  await writeFile(runMarkdown, markdownReport(finalReport), 'utf8');
  await writeFile(latestJson, `${JSON.stringify(finalReport, null, 2)}\n`, 'utf8');
  await writeFile(latestMarkdown, markdownReport(finalReport), 'utf8');
  return artifacts;
}

async function main(): Promise<number> {
  const mode = parseMode(process.argv.slice(2));
  const started = Date.now();
  const startedAt = nowIso();
  const runId = `rag-acceptance-${Date.now()}-${randomUUID()}`;
  const checks: AcceptanceCheck[] = [];
  let internalError = false;
  let safetyAbort = false;
  let environmentTarget = mode === 'mock' ? 'local-mock' : process.env.RAG_ACCEPTANCE_ENVIRONMENT_TARGET?.trim() || 'unknown';
  let embeddingModel: string | null = null;
  let embeddingDimensions: number | null = null;
  let client: Awaited<ReturnType<typeof createMilvusClient>> | undefined;
  let versionStore: PostgresDocumentVersionStore | undefined;
  let contentStore: PostgresRagChunkStore | undefined;

  try {
    if (mode === 'mock') {
      await runMockAcceptance(runId, checks);
    } else {
      let context: RealContext;
      const preflightStarted = Date.now();
      try {
        context = await realPreflight();
        client = context.client;
        versionStore = context.versionStore;
        contentStore = context.contentStore;
        embeddingModel = context.embeddingModel;
        embeddingDimensions = context.embeddingDimensions;
        checks.push({
          checkId: 'real-preflight-and-collection',
          name: '真实授权、目标环境、正式 Collection 和索引前置检查',
          status: 'PASS',
          required: true,
          durationMs: Date.now() - preflightStarted,
          summary: '授权开关、测试地址、正式 Collection、Schema 和索引已核验',
          failureReason: null,
          usedMock: false,
          evidence: {
            environmentTarget,
            collectionName: EXPECTED_COLLECTION,
            embeddingDimensions,
            milvusAddress: `${EXPECTED_MILVUS_HOST}:${EXPECTED_MILVUS_PORT}`,
            stateDatabaseTarget: context.stateDatabaseTarget,
            writesAuthorized: true,
          },
        });
      } catch (error) {
        if (error instanceof SafetyAbortSignal) {
          safetyAbort = true;
          checks.push({
            checkId: 'real-preflight-and-collection',
            name: '真实授权、目标环境、正式 Collection 和索引前置检查',
            status: 'FAIL',
            required: true,
            durationMs: Date.now() - preflightStarted,
            summary: '安全检查中止',
            failureReason: error.message,
            usedMock: false,
            evidence: null,
          });
        } else if (error instanceof CheckSignal) {
          checks.push({
            checkId: 'real-preflight-and-collection',
            name: '真实授权、目标环境、正式 Collection 和索引前置检查',
            status: error.status,
            required: true,
            durationMs: Date.now() - preflightStarted,
            summary: '真实验收前置条件未满足',
            failureReason: error.message,
            usedMock: false,
            evidence: error.evidence,
          });
        } else {
          internalError = true;
          checks.push({
            checkId: 'real-preflight-and-collection',
            name: '真实授权、目标环境、正式 Collection 和索引前置检查',
            status: 'FAIL',
            required: true,
            durationMs: Date.now() - preflightStarted,
            summary: '真实验收程序出现未预期异常',
            failureReason: safeMessage(error),
            usedMock: false,
            evidence: null,
          });
        }
        for (const [checkId, name] of [
          ['real-embedding-and-ingest', '真实 Embedding、切片和 Milvus 入库'],
          ['real-dense-top-k-semantic', '真实 Dense COSINE Top-K 与语义相关性'],
          ['real-idempotency', '真实重复入库幂等与 Chunk 数量'],
          ['real-version-update', '真实文档更新、版本区分与切换前保护'],
          ['real-visible-version-enforcement', '当前有效版本过滤接入'],
          ['real-persistent-postgres-processes', 'PostgreSQL 持久化、独立进程读取、租约幂等和状态保护'],
          ['real-persistent-restart', '持久化状态与跨进程重启'],
        ] as const) {
          checks.push({
            checkId,
            name,
            status: 'NOT_RUN',
            required: true,
            durationMs: 0,
            summary: '因真实前置检查未完成而未执行',
            failureReason: 'real preflight did not complete',
            usedMock: false,
            evidence: null,
          });
        }
        return await finishReport({
          runId,
          mode,
          started,
          startedAt,
          environmentTarget,
          embeddingModel,
          embeddingDimensions,
          checks,
          internalError,
          safetyAbort,
        });
      }
      await runRealAcceptance(runId, checks, context);
    }
  } catch (error) {
    internalError = true;
    checks.push({
      checkId: 'acceptance-program',
      name: '验收程序完整性',
      status: 'FAIL',
      required: true,
      durationMs: 0,
      summary: '验收程序出现未预期异常',
      failureReason: safeMessage(error),
      usedMock: mode === 'mock',
      evidence: null,
    });
  } finally {
    if (client) {
      try {
        await client.closeConnection();
      } catch (error) {
        internalError = true;
        checks.push({
          checkId: 'milvus-close',
          name: 'Milvus 连接关闭',
          status: 'FAIL',
          required: true,
          durationMs: 0,
          summary: '关闭 Milvus 连接时出现异常',
          failureReason: safeMessage(error),
          usedMock: false,
          evidence: null,
        });
      }
    }
    if (versionStore) {
      try {
        await versionStore.close();
      } catch (error) {
        internalError = true;
        checks.push({
          checkId: 'state-store-close',
          name: 'PostgreSQL 状态连接关闭',
          status: 'FAIL',
          required: true,
          durationMs: 0,
          summary: '关闭 PostgreSQL 状态连接时出现异常',
          failureReason: safeMessage(error),
          usedMock: false,
          evidence: null,
        });
      }
    }
    if (contentStore) {
      try {
        await contentStore.close();
      } catch (error) {
        internalError = true;
        checks.push({
          checkId: 'content-store-close',
          name: 'PostgreSQL 正文连接关闭',
          status: 'FAIL',
          required: true,
          durationMs: 0,
          summary: '关闭 PostgreSQL 正文连接时出现异常',
          failureReason: safeMessage(error),
          usedMock: false,
          evidence: null,
        });
      }
    }
  }
  return finishReport({
    runId,
    mode,
    started,
    startedAt,
    environmentTarget,
    embeddingModel,
    embeddingDimensions,
    checks,
    internalError,
    safetyAbort,
  });
}

async function finishReport(input: {
  runId: string;
  mode: Mode;
  started: number;
  startedAt: string;
  environmentTarget: string;
  embeddingModel: string | null;
  embeddingDimensions: number | null;
  checks: AcceptanceCheck[];
  internalError: boolean;
  safetyAbort: boolean;
}): Promise<number> {
  const decision = chooseOverallStatus(input.checks, input.internalError, input.safetyAbort);
  const failures = input.checks
    .filter((check) => check.status === 'FAIL')
    .map((check) => ({ checkId: check.checkId, reason: check.failureReason ?? 'check failed' }));
  const blockedReasons = [...new Set(input.checks
    .filter((check) => check.status === 'BLOCKED' || check.status === 'NOT_RUN')
    .map((check) => check.failureReason ?? check.summary))];
  const report: AcceptanceReport = {
    runId: input.runId,
    mode: input.mode,
    status: decision.status,
    exitCode: decision.exitCode,
    startedAt: input.startedAt,
    finishedAt: nowIso(),
    durationMs: Date.now() - input.started,
    environmentTarget: input.environmentTarget,
    embeddingModel: input.embeddingModel,
    embeddingDimensions: input.embeddingDimensions,
    collectionName: EXPECTED_COLLECTION,
    checks: input.checks,
    failures,
    blockedReasons,
    artifacts: [],
  };
  try {
    const artifacts = await writeReports(report);
    report.artifacts = artifacts;
    console.log(JSON.stringify({
      ok: true,
      runId: report.runId,
      mode: report.mode,
      status: report.status,
      exitCode: report.exitCode,
      artifacts: report.artifacts,
    }));
    return report.exitCode;
  } catch (error) {
    console.error(JSON.stringify({
      ok: false,
      runId: report.runId,
      status: 'ERROR',
      exitCode: 3,
      message: `Acceptance report generation failed: ${safeMessage(error)}`,
    }));
    return 3;
  }
}

main().then((exitCode) => {
  process.exitCode = exitCode;
}).catch((error: unknown) => {
  console.error(JSON.stringify({ ok: false, status: 'ERROR', exitCode: 3, message: safeMessage(error) }));
  process.exitCode = 3;
});
