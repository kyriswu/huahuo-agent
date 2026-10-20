import type {
  KnowledgeSearchProvider,
  Reranker,
  SearchCandidate,
  SearchMode,
} from '../../contracts/rag-search.ts';

export interface SearchKnowledgeInput {
  query: string;
  limit?: number;
  mode?: SearchMode;
  filter?: string;
  rerankTopN?: number;
}

export interface SearchKnowledgeDependencies {
  provider: KnowledgeSearchProvider;
  /** Leave undefined to keep reranking disabled. Provider errors are propagated. */
  reranker?: Reranker;
}

/**
 * Search orchestration deliberately has no provider-specific assumptions. This
 * keeps Milvus today and future search/rerank adapters interchangeable.
 */
export async function searchKnowledge(
  input: SearchKnowledgeInput,
  dependencies: SearchKnowledgeDependencies,
): Promise<SearchCandidate[]> {
  const candidates = await dependencies.provider.search({
    text: input.query,
    limit: input.limit ?? 20,
    mode: input.mode ?? 'semantic',
    filter: input.filter,
  });

  if (!dependencies.reranker) {
    return candidates;
  }

  return dependencies.reranker.rerank({
    query: input.query,
    candidates,
    topN: Math.min(input.rerankTopN ?? candidates.length, candidates.length),
  });
}
