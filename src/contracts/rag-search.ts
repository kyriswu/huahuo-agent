/** The three supported retrieval strategies. */
export type SearchMode = 'keyword' | 'semantic' | 'hybrid';

export interface SearchQuery {
  text: string;
  limit: number;
  mode?: SearchMode;
  filter?: string;
}

export interface SearchDocument {
  id: string;
  title: string;
  content: string;
  sourceUri?: string;
  metadata?: Record<string, unknown>;
}

export interface SearchCandidate extends SearchDocument {
  score: number;
  keywordScore?: number;
  semanticScore?: number;
}

/** The search store is injected behind this provider port. */
export interface KnowledgeSearchProvider {
  search(query: SearchQuery): Promise<SearchCandidate[]>;
}

/** Capability marker for a provider that can fuse keyword and semantic scores. */
export interface HybridSearchProvider extends KnowledgeSearchProvider {
  readonly supportsHybridSearch: true;
}

/** Optional reranking seam. No reranker is used unless one is explicitly injected. */
export interface Reranker {
  rerank(input: {
    query: string;
    candidates: SearchCandidate[];
    topN: number;
  }): Promise<SearchCandidate[]>;
}
