import type {
  KnowledgeSearchProvider,
  SearchCandidate,
  SearchQuery,
} from '../../contracts/rag-search.ts';

/**
 * Transport port for the Alibaba Cloud Milvus deployment.
 * The concrete SDK/HTTP client can be added without changing application code.
 */
export interface MilvusSearchClient {
  search(query: SearchQuery): Promise<SearchCandidate[]>;
}

/**
 * Milvus-backed provider boundary. Retrieval mode is deliberately passed through
 * so semantic search can be used now and keyword/hybrid implementations can be
 * plugged in later.
 */
export class MilvusSearchProvider implements KnowledgeSearchProvider {
  private readonly client: MilvusSearchClient;

  constructor(client: MilvusSearchClient) {
    this.client = client;
  }

  search(query: SearchQuery): Promise<SearchCandidate[]> {
    return this.client.search({
      ...query,
      mode: query.mode ?? 'semantic',
    });
  }
}
