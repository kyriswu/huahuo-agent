# huahuo-agent

Standalone Mastra + TypeScript Agent Server for the Huahuo system.

The first phase keeps the official-style example agent, workflow, and tool as a smoke-test harness. Huahuo business integrations belong under `src/extensions/huahuo/`.

## Knowledge search direction

The knowledge store is Alibaba Cloud Milvus. Search orchestration depends on the provider contract in `src/contracts/rag-search.ts` and supports three modes: `keyword`, `semantic`, and `hybrid`. Semantic search is the current default; keyword search and keyword + semantic fusion are extension points that can be added behind the same provider contract.

Reranking is an optional injected `Reranker`. It is disabled by default; when configured, reranker errors are propagated instead of silently returning unreranked results.

The Milvus adapter is intentionally transport-neutral: an SDK or HTTP client can be injected through `MilvusSearchClient` when the actual collection schema and deployment endpoint are wired in.

No database or external service is contacted during startup by the current smoke-test harness.

## Milvus 2.6 dense-vector PoC

The PoC uses the official `@zilliz/milvus2-sdk-node@2.6.17` client and only the
dedicated `huahuo_rag_poc_dense` collection. Copy the blank settings from
`.env.example` into a local `.env`, fill in the test instance credentials, and
run:

```bash
npm run milvus:poc
```

Each run creates a unique `run_id`, retains the inserted test rows, and prints
the inserted IDs and Dense COSINE search results. A custom four-dimensional
query can be checked without changing the default data:

```bash
npm run milvus:poc -- --query-vector='[1,0,0,0]'
```

The script validates an existing collection schema before use and stops on an
incompatible schema or vector index. It does not delete collections or rows.

## Development

```bash
npm install
cp .env.example .env
npm run dev
npm run typecheck
```

Mastra Studio is served at <http://localhost:4111> by the Mastra development command.
