import {
  ConsistencyLevelEnum,
  MetricType,
  type MilvusClient,
} from '@zilliz/milvus2-sdk-node';

export interface DenseSearchQuery {
  vector: number[];
  limit?: number;
  runId?: string;
}

export interface DenseSearchResult {
  id: string;
  content: string;
  sourceId: string;
  score: number;
  runId: string;
}

export interface MilvusDenseSearchOptions {
  collection: string;
  vectorDim: number;
  vectorField?: string;
  searchEf?: number;
}

type SearchResponse = {
  status?: { error_code?: unknown; reason?: unknown };
  results?: Array<Record<string, unknown>>;
};

function validateQueryVector(vector: unknown, dim: number): asserts vector is number[] {
  if (
    !Array.isArray(vector) ||
    vector.length !== dim ||
    vector.some((value) => typeof value !== 'number' || !Number.isFinite(value))
  ) {
    throw new Error(`Query vector must be a finite numeric array with dimension ${dim}`);
  }
}

function escapeMilvusString(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

function responseStatus(response: SearchResponse): { code: string; reason?: string } {
  return {
    code: String(response.status?.error_code ?? 'Success'),
    ...(response.status?.reason ? { reason: String(response.status.reason) } : {}),
  };
}

function asString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new Error(`Milvus search result field "${field}" is missing or not a string`);
  }
  return value;
}

function asScore(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error('Milvus search result score is missing or not finite');
  }
  return value;
}

/**
 * Dense-only Milvus adapter for the 3A PoC and the next application boundary.
 * Query embedding is intentionally supplied by the caller.
 */
export class MilvusDenseSearchAdapter {
  private readonly vectorField: string;
  private readonly searchEf: number;

  constructor(
    private readonly client: MilvusClient,
    private readonly options: MilvusDenseSearchOptions,
  ) {
    this.vectorField = options.vectorField ?? 'embedding';
    this.searchEf = options.searchEf ?? 64;
  }

  async search(query: DenseSearchQuery): Promise<DenseSearchResult[]> {
    validateQueryVector(query.vector, this.options.vectorDim);
    const limit = query.limit ?? 10;
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new Error('Dense search limit must be a positive integer');
    }

    const filter = query.runId === undefined
      ? undefined
      : `run_id == "${escapeMilvusString(query.runId)}"`;
    const response = await this.client.search({
      collection_name: this.options.collection,
      data: [query.vector],
      anns_field: this.vectorField,
      limit,
      metric_type: MetricType.COSINE,
      params: { ef: this.searchEf },
      ...(filter ? { filter } : {}),
      output_fields: ['id', 'run_id', 'source_id', 'content'],
      consistency_level: ConsistencyLevelEnum.Strong,
    }) as SearchResponse;

    const status = responseStatus(response);
    if (status.code !== 'Success' && status.code !== '0') {
      throw new Error(`Milvus dense search failed (${status.code})${status.reason ? `: ${status.reason}` : ''}`);
    }

    return (response.results ?? []).map((result) => ({
      id: asString(result.id, 'id'),
      content: asString(result.content, 'content'),
      sourceId: asString(result.source_id, 'source_id'),
      score: asScore(result.score),
      runId: asString(result.run_id, 'run_id'),
    }));
  }
}

