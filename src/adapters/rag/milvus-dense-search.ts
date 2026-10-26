import {
  ConsistencyLevelEnum,
  MetricType,
  type MilvusClient,
} from '@zilliz/milvus2-sdk-node';

export interface DenseSearchQuery {
  vector: number[];
  limit?: number;
  runId?: string;
  /** Optional trusted adapter-generated predicate for document/version checks. */
  filter?: string;
}

export interface DenseSearchResult {
  id: string;
  content: string;
  sourceId: string;
  score: number;
  runId: string;
  documentId?: string;
  documentVersion?: string;
}

export interface MilvusDenseSearchOptions {
  collection: string;
  vectorDim: number;
  vectorField?: string;
  searchEf?: number;
  idField?: string;
  contentField?: string;
  sourceIdField?: string;
  runIdField?: string;
  documentIdField?: string;
  documentVersionField?: string;
}

type SearchResponse = {
  status?: { error_code?: unknown; reason?: unknown };
  error_code?: unknown;
  reason?: unknown;
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
    code: String(response.status?.error_code ?? response.error_code ?? 'Success'),
    ...((response.status?.reason ?? response.reason) ? {
      reason: String(response.status?.reason ?? response.reason),
    } : {}),
  };
}

function asString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new Error(`Milvus search result field "${field}" is missing or not a string`);
  }
  return value;
}

function asOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return asString(value, field);
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
  private readonly client: MilvusClient;
  private readonly options: MilvusDenseSearchOptions;
  private readonly vectorField: string;
  private readonly searchEf: number;
  private readonly idField: string;
  private readonly contentField: string;
  private readonly sourceIdField: string;
  private readonly runIdField: string;
  private readonly documentIdField?: string;
  private readonly documentVersionField?: string;

  constructor(
    client: MilvusClient,
    options: MilvusDenseSearchOptions,
  ) {
    this.client = client;
    this.options = options;
    this.vectorField = options.vectorField ?? 'embedding';
    this.searchEf = options.searchEf ?? 64;
    this.idField = options.idField ?? 'id';
    this.contentField = options.contentField ?? 'content';
    this.sourceIdField = options.sourceIdField ?? 'source_id';
    this.runIdField = options.runIdField ?? 'run_id';
    this.documentIdField = options.documentIdField;
    this.documentVersionField = options.documentVersionField;
  }

  async search(query: DenseSearchQuery): Promise<DenseSearchResult[]> {
    validateQueryVector(query.vector, this.options.vectorDim);
    const limit = query.limit ?? 10;
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new Error('Dense search limit must be a positive integer');
    }

    const filters: string[] = [];
    if (query.runId !== undefined) {
      filters.push(`${this.runIdField} == "${escapeMilvusString(query.runId)}"`);
    }
    if (query.filter?.trim()) filters.push(`(${query.filter.trim()})`);
    const filter = filters.length > 0 ? filters.join(' && ') : undefined;
    const outputFields = [
      this.idField,
      this.runIdField,
      this.sourceIdField,
      this.contentField,
      ...(this.documentIdField ? [this.documentIdField] : []),
      ...(this.documentVersionField ? [this.documentVersionField] : []),
    ].filter((field, index, fields) => fields.indexOf(field) === index);
    const response = await this.client.search({
      collection_name: this.options.collection,
      data: [query.vector],
      anns_field: this.vectorField,
      limit,
      metric_type: MetricType.COSINE,
      params: { ef: this.searchEf },
      ...(filter ? { filter } : {}),
      output_fields: outputFields,
      consistency_level: ConsistencyLevelEnum.Strong,
    }) as SearchResponse;

    const status = responseStatus(response);
    if (status.code !== 'Success' && status.code !== '0') {
      throw new Error(`Milvus dense search failed (${status.code})${status.reason ? `: ${status.reason}` : ''}`);
    }

    return (response.results ?? []).map((result) => ({
      id: asString(result[this.idField], this.idField),
      content: asString(result[this.contentField], this.contentField),
      sourceId: asString(result[this.sourceIdField], this.sourceIdField),
      score: asScore(result.score),
      runId: asString(result[this.runIdField], this.runIdField),
      ...(this.documentIdField
        ? { documentId: asOptionalString(result[this.documentIdField], this.documentIdField) }
        : {}),
      ...(this.documentVersionField
        ? { documentVersion: asOptionalString(result[this.documentVersionField], this.documentVersionField) }
        : {}),
    }));
  }
}

