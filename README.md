# huahuo-agent

Standalone Mastra + TypeScript Agent Server for the Huahuo system.

The first phase keeps the official-style example agent, workflow, and tool as a
smoke-test harness. Huahuo business integrations belong under
`src/extensions/huahuo/`.

The registered `huox` (HuoX) is the primary business-agent entry point. The
`weather-agent` remains available as the deterministic smoke-test harness;
future Huahuo tools should be attached to the primary agent through application
services.

## Knowledge search direction

Search orchestration depends on the provider contract in
`src/contracts/rag-search.ts` and supports `keyword`, `semantic`, and `hybrid`
modes. The concrete vector backend is intentionally left behind an adapter
boundary; this project does not ship a direct vector-database SDK or make
external vector-store connections during startup.

Reranking is an optional injected `Reranker`. It is disabled by default, and
configured reranker errors are propagated to the caller.

## RAG indexing foundation

The indexing core provides Markdown normalization and chunking, an
OpenAI-compatible Embedding client, idempotent document-version state, and a
PostgreSQL canonical chunk-content store. `RagChunkRepositoryPort` is the
generic boundary for a future vector index implementation. No production
vector-store command is enabled until that adapter is selected.

Run the local checks and deterministic mock flow with:

```bash
pnpm run typecheck
pnpm run build
pnpm run rag:test
pnpm run rag:ingest:mock
```

The mock flow does not need credentials; its hash-derived vectors are test
fixtures only. PostgreSQL state tables can be applied to the explicitly
authorized state database with:

```bash
RAG_STATE_MIGRATION_ALLOW=true pnpm run rag:state:migrate
```

The original uploaded file remains owned by `huahuo-server` or object storage;
PostgreSQL stores normalized chunk text and citation metadata.

## Deterministic acceptance

Run the acceptance flow without credentials or external services:

```bash
pnpm run rag:acceptance:dense:mock
```

Reports are written to `artifacts/rag-acceptance/`, which is ignored by Git.
The acceptance verifies application orchestration, stable IDs, idempotency,
version switching, and failure recovery using in-memory adapters.

For an independent-process PostgreSQL state check, set
`RAG_STATE_PROCESS_CHECK_ALLOW=true` and run:

```bash
pnpm run rag:state:process-check -- --scenario=all
```

This verifies state visibility after a child-process restart, database-backed
idempotency and lease fencing, and transactional version switching. It does
not write to an external vector index.

## Development

Volta is a prerequisite and must manage the project's Node.js and npm
versions. pnpm is the package manager declared by the repository.

The Mastra packages are pinned to the November 4, 2026 release:

| Package | Version |
| --- | --- |
| `@mastra/core` | `1.82.0` |
| `@mastra/memory` | `1.41.0` |
| `@mastra/pg` | `1.35.0` |
| `mastra` CLI | `1.38.0` |

Update these packages together and commit `pnpm-lock.yaml` with the version
changes. Validate upgrades with `pnpm run typecheck`, `pnpm test`,
`pnpm run build`, and `pnpm run rag:acceptance:dense:mock`. Stop the development
server before building, because both commands use `.mastra/output`.

```bash
pnpm install
cp .env.example .env
pnpm run dev
pnpm run typecheck
```

Mastra Studio is served at <http://localhost:4111> by the Mastra development command.

### Agent Editor

`@mastra/editor@0.17.0` is registered on the Mastra instance. Open **Agents → HuoX → Editor**
to edit instructions and select project tools. HuoX and the weather example keep their
code-defined instructions and tools as defaults; the Editor supports stored overrides.
Both existing tools are registered on Mastra so they are available in the editor catalog.

Editor uses the existing `PostgresStore` configured by `MASTRA_POSTGRES_*`; no additional
database or LibSQL store is required. Save a draft to test changes, then publish it to
activate the configuration. Keep `MASTRA_POSTGRES_PASSWORD` configured for persistent
editing. Without configured storage, this project does not provide durable Editor state.

Local development retains the existing Studio access policy. In production, `/api/stored/*`
and `/api/editor/*` also require the trusted Server credential in `X-Huahuo-Service-Key`,
in addition to the existing user JWT requirement. Ordinary APP JWTs cannot administer
shared agents. Do not put the service key in browser configuration or request context;
remote human administration needs an appropriately protected trusted deployment path.

This installs the standard Editor. Enterprise Agent Builder and model-powered Builder
agents are not enabled. See the [official Editor guide](https://mastra.ai/docs/studio/editor).

When `MASTRA_POSTGRES_PASSWORD` is configured, `PostgresStore` initializes and
upgrades its tables on startup. To check the built API with an isolated
in-memory store, run:

```bash
APP_ENV=test MASTRA_POSTGRES_PASSWORD='' PORT=4112 node .mastra/output/index.mjs
```

The built API exposes `/health`, `/api/agents`, and `/api/workflows` on that
port. This check does not verify PostgreSQL persistence.

In local development, Studio does not require a JWT just to open. The HuoX RAG
tool reads `HUAHUO_AGENT_TO_SERVER_API_KEY` from the Agent `.env`; do not put
that Service Key in Studio or in a prompt. For a user-scoped RAG run, add the
user token to Studio's Request Context:

```json
{ "huahuoUserJwt": "<USER_JWT>" }
```

The tool forwards that per-run JWT together with the environment Service Key.
Production keeps the Agent API routes protected by JWT.

## Docker service

Docker reads the project's `.env` file. For a new checkout, create it from
the example:

```bash
cp .env.example .env
```

Set the Server URL, JWKS URL, two distinct directional Service Keys (at least
43 characters each), and the model API key. Configure `MASTRA_POSTGRES_*` to
persist conversations; without a PostgreSQL password, storage is in memory and
is lost on restart. `PostgresStore` initializes and upgrades its tables on
startup, so the configured database user needs the corresponding permissions.

Build and start the service:

```bash
docker build -t huahuo-agent:local .
docker compose up -d --no-build
docker compose ps
docker compose logs -f agent
```

If `HUAHUO_AGENT_TAG` is set in `.env`, build the image with that tag instead
of `local`.

The image includes Studio by default. Set `MASTRA_STUDIO_PATH=/app/studio`
and `MASTRA_AUTO_DETECT_URL=true` in `.env`, then open `http://localhost:4111`.
Studio uses the browser's address to reach the API, including when the host
port differs from the container port. The API is at `http://localhost:4111/api`
and the health check is at `http://localhost:4111/health`.

`APP_ENV` in `.env` controls application authentication. With `development`
or `test`, Studio and the Agent API open without login; keep this local test
configuration bound to `127.0.0.1`. A user-scoped RAG run still needs its user
JWT in Request Context, as described above. Use `APP_ENV=production` for a
deployment that requires JWT on Agent API requests. Compose defaults to
`production` when `APP_ENV` is absent. The container continues to run the
compiled server with `NODE_ENV=production` in either case.

For an API-only image, set `MASTRA_BUILD_STUDIO=false` in `.env` and rebuild:

```bash
docker build --build-arg MASTRA_BUILD_STUDIO=false -t huahuo-agent:local .
docker compose up -d --no-build
```

`docker compose build` also reads this build argument from `.env` when Docker
Buildx is installed. Studio consists of static browser assets; bundling it
increases image size. Serving or using the UI adds HTTP requests, and using
its debugging tools runs the corresponding API operations.

If the development server already uses port 4111, choose another host port:

```bash
AGENT_PORT=4112 docker compose up -d --no-build
```

By default the published port binds to `127.0.0.1`. Set
`AGENT_BIND_ADDRESS=0.0.0.0` when the API needs to be reachable from other hosts.
These Compose variables can be supplied in the shell or `.env`.
The runtime env file uses Compose's `raw` format (Compose 2.30 or later), so
write values without surrounding quotes; dollar signs in passwords and keys
are preserved.

The Server and PostgreSQL run separately. For local container communication,
set these values in `.env` to join the existing Server network:

```dotenv
HUAHUO_SERVER_BASE_URL=http://api-server:3000
APP_JWT_JWKS_URL=http://api-server:3000/.well-known/jwks.json
HUAHUO_AGENT_NETWORK=huahuo-server-dev_backend
HUAHUO_AGENT_NETWORK_EXTERNAL=true
```

For deployment on separate hosts, set the Server and JWKS URLs to the remote
Server address, `HUAHUO_AGENT_NETWORK=huahuo-agent_default`, and
`HUAHUO_AGENT_NETWORK_EXTERNAL=false`. Compose then creates the Agent's own
network. Set `AGENT_BIND_ADDRESS` to the required listening address and fill
in the deployment's `MASTRA_POSTGRES_*` values. A `localhost` URL inside the
Agent would point back to the Agent container.

The image uses Node.js `26.12.1` (within the project's Node.js 26 engine range),
is built from locked dependencies in a separate build stage, and runs as the
non-root `node` user. Runtime configuration files, host
`node_modules`, `.mastra`, and repository metadata are excluded from the build
context. No host directory or database is mounted into the container.
The `/health` endpoint checks the HTTP process; it does not test the model,
business Server, or PostgreSQL connection.

Stop the service with:

```bash
docker compose down
```
