# huahuo-agent

Standalone Mastra + TypeScript Agent Server for the Huahuo system.

The first phase keeps the official-style example agent, workflow, and tool as a smoke-test harness. Huahuo business integrations belong under `src/extensions/huahuo/`.

## Knowledge search direction

The knowledge store is Alibaba Cloud Milvus. Search orchestration depends on the provider contract in `src/contracts/rag-search.ts` and supports three modes: `keyword`, `semantic`, and `hybrid`. Semantic search is the current default; keyword search and keyword + semantic fusion are extension points that can be added behind the same provider contract.

Reranking is an optional injected `Reranker`. It is disabled by default; when configured, reranker errors are propagated instead of silently returning unreranked results.

The Milvus adapter is intentionally transport-neutral: an SDK or HTTP client can be injected through `MilvusSearchClient` when the actual collection schema and deployment endpoint are wired in.

No database or external service is contacted during startup by the current smoke-test harness.

## RAG stage 3B: document indexing foundation

The formal collection is `huahuo_chunks` and is intentionally separate from the
PoC collection. The indexer currently uses a deterministic Markdown chunker with
an estimated-token budget (`heuristic-v1`), an OpenAI-compatible Embedding API,
and HNSW + COSINE in Milvus. The checked-in example uses the selected
SiliconFlow `BAAI/bge-m3` model and its 1024-dimensional output; the API key
remains blank and must only be supplied through a local environment.

Run the local checks and deterministic mock flow with:

```bash
npm run typecheck
npm run build
npm run rag:test
npm run rag:ingest:mock
```

The mock flow does not need credentials and its hash-derived vectors are test
fixtures only. A real initialization requires `RAG_EMBEDDING_BASE_URL`,
`RAG_EMBEDDING_API_KEY`, `RAG_EMBEDDING_MODEL`, and
`RAG_EMBEDDING_DIMENSIONS`, then an explicit command:

```bash
RAG_MILVUS_INIT_ALLOW=true RAG_ACCEPTANCE_ENVIRONMENT_TARGET=milvus-huahuo-test npm run rag:milvus:init
npm run rag:ingest
```

Formal initialization additionally requires the explicit authorized target
`RAG_ACCEPTANCE_ENVIRONMENT_TARGET=milvus-huahuo-test`; it never deletes or
rebuilds an incompatible collection.

`rag:ingest` uses the PostgreSQL state adapter and canonical chunk-content store
by default. It requires an authorized `RAG_STATE_DATABASE_URL` plus
`RAG_STATE_DATABASE_TARGET`. Apply both the version-state and canonical-content
tables with:

```bash
RAG_STATE_MIGRATION_ALLOW=true npm run rag:state:migrate
```

The original uploaded file remains owned by `huahuo-server` or object storage;
the RAG database keeps normalized chunk text and citation metadata, while
Milvus keeps vectors and a rebuildable text/index projection.

`RAG_INGEST_PROCESS_LOCAL_STATE=true` is retained only for local/mock flows and
must not be used as evidence of durable recovery. Apply the state migration
explicitly with `RAG_STATE_MIGRATION_ALLOW=true npm run rag:state:migrate`.
The command reads document identity and tenant metadata from the `RAG_INGEST_*`
environment variables and never prints credentials.

## Dense RAG stage 3C acceptance

Run the deterministic acceptance without external services:

```bash
npm run rag:acceptance:dense:mock
```

The real acceptance is explicitly opt-in and restricted to the authorized test
Milvus and PostgreSQL targets. It requires the real Embedding settings,
`RAG_STATE_DATABASE_URL`, `RAG_STATE_DATABASE_TARGET=pgsql-huahuo-test`, plus
`RAG_ACCEPTANCE_ALLOW_REAL=true`, `RAG_ACCEPTANCE_ALLOW_WRITES=true`, and
`RAG_ACCEPTANCE_ENVIRONMENT_TARGET=milvus-huahuo-test`. Run it with:

```bash
npm run rag:acceptance:dense -- --mode=real
```

Missing model, credential, network, or durable-state prerequisites produce a
truthful `BLOCKED` result (exit code 2); the script never falls back to Mock.
Reports are written to `artifacts/rag-acceptance/` and are ignored by Git.
See `docs/architecture/rag-stage-3c.md` for the check and exit-code contract.
The SiliconFlow and PostgreSQL D1 implementation notes are in
`docs/architecture/rag-stage-3d1.md`.

For an independent-process PostgreSQL state check (without claiming Milvus
completeness), set `RAG_STATE_PROCESS_CHECK_ALLOW=true` and run:

```bash
npm run rag:state:process-check -- --scenario=all
```

This creates uniquely named test rows, verifies state visibility after a child
process restart, database-backed idempotency/lease fencing, and transactional
version switching. It never deletes rows or writes Milvus data.

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
