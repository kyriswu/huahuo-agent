# huahuo-agent

Standalone Mastra + TypeScript Agent Server for the Huahuo system.

The first phase keeps the official-style example agent, workflow, and tool as a
smoke-test harness. Huahuo business integrations belong under
`src/extensions/huahuo/`.

The registered `huox` (HuoX) is the primary business-agent entry point. The
`weather-agent` remains available as the deterministic smoke-test harness;
future Huahuo tools should be attached to the primary agent through application
services.

## Deep positioning and user memory

HuoX includes `skills/an-deep-positioning`, adapted from the supplied skill
package. It retains the six entry modes, ten deep-consultation subjects,
quick consultation, and the first-person, thirteen-section account positioning
report. Ask HuoX “帮我做深度定位”, describe an initial idea to save, resume a
consultation, or request the saved report. The native `skill_search`, `skill`,
and `skill_read` tools load its methods and references on demand. HuoX also
includes the four creative skills described below. It allows up to twenty model
steps per request by default so loading the methods and saving a report do not
stop at the framework's five-step default; per-call options can override it.

HuoX's native `Working Memory` uses the schema in
`src/mastra/memory/positioning-schema.ts`, with `scope: 'resource'`:

- `positioningReport` is the current report, with thirteen separately editable
  narrative fields plus stage, adoption status, and sources. Unknown sections
  stay unset and are shown as not yet discussed in a complete report.
- `positioningConsultation` holds the current subject, confirmed material,
  dependencies, and resume point. An initial saved report does not complete
  the consultation or adopt the agent's recommendations.
- `languageStyleProfile` contains the current effective style: a short language
  world, active expression preferences, scenario differences, and source index.
- `languageStyleLearning` retains authorized source originals, correction
  comparisons, candidate/inactive preferences, learning records, and conflicts.

The authenticated user's ID is the resource ID. The same user can continue
with this memory in a new thread; a different user has a separate resource.
There is one current positioning report per user resource. Credentials are
kept in server-owned request context and are not fields in this memory schema.
Recent message history and title generation retain their existing settings.

The native `updateWorkingMemory` tool accepts an object under `memory` and
merges changed JSON fields. Saving follows the skill's authorization rules:
explicit requests and approval of a concrete proposal authorize that change;
viewing, comparison, and temporary creative choices do not. A save is reported
only after the native tool succeeds. PostgreSQL supports atomic resource JSON
merges; a model tool's in-memory test fallback does not prove cross-process
database concurrency.

Business clients can also read or update this memory using the existing
authenticated native routes:

```http
GET /agent/api/memory/threads/{threadId}/working-memory?agentId=huox
POST /agent/api/memory/threads/{threadId}/working-memory?agentId=huox
Authorization: Bearer <USER_JWT>
Content-Type: application/json

{"mode":"merge","workingMemory":"{\"positioningReport\":{\"corePositioning\":\"我的账号定位……\"}}"}
```

The thread must exist and belong to the authenticated resource. The HTTP body
uses a JSON **string**, unlike the model tool's `memory` object. HTTP merge
requires a schema-based resource memory and an atomic-merge storage adapter;
the configured PostgreSQL adapter supports it. Native routes do not treat a
unscoped internal calls as a user identity. A future background/admin integration
would need its own explicitly authorized identity mapping.
The model's memory tool validates the configured schema. Direct native HTTP
or programmatic memory writes do not enforce this business schema themselves;
business clients should validate with `huoxWorkingMemorySchema` before writing.

The package's Python session snapshots, local project files, immutable
version folders, and SHA receipts are replaced by native current JSON memory.
Chat messages retain the conversation and tool-call history; there is no claim
of file-based history or compare-and-swap versioning. Language-style learning
and maintenance use the two native JSON fields described below. No Python runtime, shell tool,
extra model provider, or public MCP endpoint is added.

Run commands from the project root so `./skills/an-deep-positioning` resolves.
The Docker build copies the same private skill directory to `/app/skills`;
it is not a publicly served asset directory. The isolated regression is:

```bash
pnpm exec vitest run test/positioning-memory.test.ts
```

## Creative skills

HuoX registers four additional native filesystem skills from the supplied
package. Their complete professional methods, examples, and supporting
references are bundled under `skills/`; the entry instructions route to the
matching skill and require its Mastra runtime protocol before applying it.
No workspace, shell, Python process, extra provider, or external MCP service
is needed. Docker copies all six skill directories into `/app/skills`.

| Skill | Default delivery and selection | Positioning use |
| --- | --- | --- |
| `an-opening-design` / 开头处理 | Sixteen methods in the original order, three candidates each: 48 total, with a separate two-column table per method. Standalone delivery stops after the candidates; full-draft integration follows the user's request or the skill's explicit full-workflow contract. | Audience-related material only. |
| `an-content-uplift` / 内容升华 | Offer rational lines, deeper theoretical explanations, and emotional lines at their actual insertion points. After selection, integrate only the selected changes into the latest complete draft. | Audience-related material only. |
| `an-situation-design` / 情境设计 | Four situations: two addressing the camera/audience, two interacting with people or events while a third party records. Compare audiences and tradeoffs, invite selection, then integrate the selected situation into the complete draft. | Relevant positioning; effective style for its spoken copy, supplied material, and current requirements. |
| `an-prop-design` / 道具设计 | Three metaphor props, three carrier props, and three preparation props: nine total. Explain presentation, relevance, strengths, and limitations for each; invite selection, then integrate into the complete draft. | Audience-related material only. |

For the three audience-only skills, the source protocol permits audience
information in `coreAudience`, `audienceNeeds`, `coreValue`,
`personaAndRelationship`, and `boundariesAndOpenQuestions`; only their relevant
audience portions may be used. These are model instructions about using the
injected memory, not field-level access controls. Authentication and resource
ownership remain enforced by the existing server boundary.

Usable current material is sufficient: missing positioning or style does not
force a new positioning interview. Reuse the newest draft and clear selection
from the conversation, respect requested local changes, and preserve the
author's meaning, facts, conditions, and expression strength. A creative choice
does not become a permanent preference or positioning decision. The original
opening workflow's two modes are preserved as a calling contract; the broader
IP/marketing workflow agents themselves are not installed by these skills.

Opening, uplift, and props do not propose or perform profile maintenance.
Situation design retains the positioning-maintenance protocol: an actual
long-term change can be proposed and, within the user's authorization, saved
as a native `updateWorkingMemory` patch to `positioningReport`. It does not
claim file snapshots, report-version history, or compare-and-swap protection.
Situation design can also use the saved effective style within its spoken-copy
scope. An authorized long-term style correction follows the language-style
skill's learning protocol; a selected situation or generated draft does not
automatically authorize learning. Provided material and current requirements
take precedence within their actual scope.
Drafts are delivered in the conversation; no draft file or business-content
save API is connected. The skills must not claim such a save occurred.

Each `references/mastra-runtime.md` documents the host adaptations and the
source files describe their original professional provenance. The regression
checks native discovery/loading, reference integrity, preserved method
content, and memory integration using a simulated model. It does not establish
that a real model follows every candidate count, adoption rule, or writing
quality requirement:

```bash
pnpm exec vitest run test/creative-skills.test.ts test/positioning-memory.test.ts
```

## Language style and resource memory

`skills/an-language-style` is registered on HuoX for profile building,
continued learning, preference correction/deactivation, checking saved
evidence, and explicit style writing/editing. It uses the original package's
learning, application, source classification, and meaning-preservation
methods. Its former filesystem storage is adapted to the native resource
schema in `src/mastra/memory/language-style-schema.ts`; the existing positioning
keys and authentication remain the same.

`languageStyleProfile` separates known background, tentative understanding,
and future expression goals. Active preferences distinguish observed habits
from adopted target preferences, with wording/avoidance/local-syntax types,
scopes, exceptions, and source references. The profile does not prescribe
topics, opinions, stories, explanations, article structure, or conclusions.
Only related background and active expression choices apply during writing.

`languageStyleLearning` preserves the exact authorized original text, plus
the before text for corrections. Sources retain the seven original kinds:
`author`, `oral`, `correction`, `external`, `preference`, `unknown`, and
`adopted-ai`, along with scope, source note, and lineage. Source entries have
required fields; correction sources require and exclusively accept
`beforeText`, and adopted AI sources require and exclusively accept
`adoptionNote`. The model memory tool enforces these schema constraints;
whether the claimed authorship or authorization is true still depends on
the actual user material. Source/rule IDs are local logical references,
not generated database message IDs or cryptographic digests.

Candidates, inactive/superseded rules, evidence comparisons, learning records,
and unresolved conflicts live in the learning field rather than the effective
profile. Same-draft revisions share lineage and do not become independent
samples. Ordinary generated copy, a one-time correction, or general approval
does not become the user's historical writing. Explicit continuing-learning
authorization applies only to its actual scope; without it, an ordinary edit
does not authorize saving the whole draft. Stop/replacement updates remove the
corresponding active entry and retain its actual reason and evidence in the
learning field. No model confidence percentage or automatic evidence count
is reported.

Saving uses native `updateWorkingMemory` with changed fields under `memory`.
Objects merge; arrays replace completely, so updates must keep valid old
sources and preferences. The two style fields and two positioning fields
coexist in one resource JSON. One user has one current style across threads;
there is no per-account/project store. New fields are optional, so existing
positioning memory needs no data migration or SQL change.

The two style fields are a **logical separation**: Mastra injects the entire
Working Memory, including source originals and learning records, each turn.
They are not an on-demand archive or physically hidden context. Longer source
material increases prompt size and model context use. Ordinary application
is instructed to use the effective profile; learning and specific calibration
use only relevant evidence. No separate source-retrieval service is added.
Independent opening design, content uplift, and prop design continue to
exclude saved personal style even when it is injected; explicit independent
style edits and situation-design spoken copy follow their own allowed scope.

The Python store's deterministic SHA deduplication/evidence grouping,
immutable snapshots, expected-hash conflict checks, automatic backup of manual
edits, and historical version rollback are not implemented. Native current
JSON and learning records do not replace that versioned archive. The skill
must not invent paths, hashes, versions, exact-history recovery, or save
receipts. Existing user-supplied material can be restored only when its actual
content is available and the user authorizes the current update.

The isolated regression checks the source schema, preserved professional
methods, local references, native skill loading, field merges/array replacement,
cross-thread reuse, and user isolation with scripted model responses:

```bash
pnpm exec vitest run test/language-style-memory.test.ts
```

These tests do not establish autonomous learning quality, user-confirmation
judgment, PostgreSQL cross-process concurrency, or native version-history
equivalence.

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

The Mastra packages are pinned to the November 12, 2026 release:

| Package | Version |
| --- | --- |
| `@mastra/core` | `1.83.0` |
| `@mastra/editor` | `0.17.1` |
| `@mastra/memory` | `1.41.1` |
| `@mastra/pg` | `1.36.0` |
| `mastra` CLI | `1.39.0` |

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

`@mastra/editor@0.17.1` is registered on the Mastra instance. Open **Agents → HuoX → Editor**
to edit instructions and select project tools. HuoX and the weather example keep their
code-defined instructions and tools as defaults; the Editor supports stored overrides.
The RAG, weather, and DeepSeek web tools are registered on Mastra so they are
available in the editor catalog.

Editor uses the existing `PostgresStore` configured by `MASTRA_POSTGRES_*`; no additional
database or LibSQL store is required. Save a draft to test changes, then publish it to
activate the configuration. Keep `MASTRA_POSTGRES_PASSWORD` configured for persistent
editing. Without configured storage, this project does not provide durable Editor state.

Test Studio uses gateway-authenticated user identity. On the main gateway branch,
`/agent/api/stored/*` and `/agent/api/editor/*` are excluded from external routing;
trusted internal management calls still require a user scope. Directional
ServiceKeys are no longer used.
This installs the standard Editor. Enterprise Agent Builder and model-powered Builder
agents are not enabled. See the [official Editor guide](https://mastra.ai/docs/studio/editor).

### Model endpoint

Agents default to `deepseek/deepseek-v4-flash` with `MODEL_PROVIDER=deepseek`.
Set `DEEPSEEK_API_KEY` and `DEEPSEEK_MODEL` (default `deepseek-v4-flash`);
the existing DeepSeek key also serves the shared Search/Fetch tools.

The official OpenAI provider remains available with `MODEL_PROVIDER=openai`:
configure `OPENAI_API_KEY` and `OPENAI_MODEL` (default `gpt-6.1-sol`).
Mastra's native `openai/<model>` router uses the official OpenAI API.

The existing `CLIPROXY_API_KEY`, `CLIPROXY_BASE_URL`, and `CLIPROXY_MODEL`
remain available. To restore CLIProxy, set `MODEL_PROVIDER=cliproxy` and recreate
the container with `docker compose up -d --no-build --force-recreate agent`;
the retained credentials do not need to be re-entered. Changing
the provider or model does not change the Agent ID or its chat history.

### Shared web Search and Fetch tools

`src/mastra/tools/mcp/` exports ordinary, reusable Mastra tools for project
agents. It does not register an MCP server or add an external MCP endpoint.
The framework's built-in MCP transport is explicitly disabled with
`server.mcp.enabled=false`, including on authenticated deployments.
Use the existing `DEEPSEEK_API_KEY` in `.env`; no other web-search configuration
is required. Credentials are read on the server when a tool is invoked, and
are never tool arguments.

- `onlineSearch` returns ranked public-web results,
  including URLs, snippets, summaries, source information, and optional content.
  It accepts `query`, `count` (1–50, default 10), `ori_question`, `localization`,
  and `need_content` (default false). Query operators are passed through intact.
- `urlFetch` accepts an HTTP/HTTPS `url` and returns
  the page title and Markdown content. URLs with embedded credentials are rejected.

Other code-defined agents can opt in to either tool, or reuse both:

```typescript
import { deepseekWebTools } from '../tools/mcp/index.ts';

// Add to the agent's existing configuration:
tools: { ...deepseekWebTools }
```

HuoX includes both web tools by default, alongside its Huahuo RAG tool. Its
instructions cover public-web research, reading URLs, and citing sources.
The same tools are available in the Agent Editor catalog for other stored
agent configurations.

Each invocation has a 60-second deadline and propagates Agent cancellation.
One short retry is allowed for explicit HTTP 408, 429, or 5xx responses;
network failures and timeouts are not automatically replayed. Invalid input,
missing credentials, authentication/balance failures, and malformed responses
produce tool errors instead of fabricated search results. Empty search results
remain a successful response.

DeepSeek bills successful Search/Fetch requests separately from model tokens.
Search results and fetched pages are untrusted external content; agents should
cite the original URLs and treat page text as evidence rather than instructions.
See the [DeepSeek Search & Fetch guide](https://api-docs.deepseek.com/guides/search.md).

When `MASTRA_POSTGRES_PASSWORD` is configured, `PostgresStore` initializes and
upgrades its tables on startup. To check the built API with an isolated
in-memory store, run:

```bash
APP_ENV=test MASTRA_POSTGRES_PASSWORD='' PORT=4112 node .mastra/output/index.mjs
```

The built API exposes `/health`, `/api/agents`, and `/api/workflows` on that
port. This check does not verify PostgreSQL persistence.

For test Studio, enable `HUAHUO_STUDIO_AUTH_ENABLED=true` on both Agent and
Server with `APP_ENV=development` or `test`, then open `/agent/studio-login` on
the gateway origin. The existing Server SMS/login APIs issue the tokens;
Agent writes HttpOnly cookies without local JWT verification. Server admission
performs account/session checks and cookie refresh. Authenticated identity,
not the token, flows to tools and native resource-scoped memory.

The login form retains `clientType=web`, a persistent browser client ID, and
agreement/privacy versions (`2026-08-20`). Update
`HUAHUO_STUDIO_AGREEMENT_VERSION`, `HUAHUO_STUDIO_PRIVACY_VERSION` and the copied
legal documents together if the product agreements change. The consent
checkbox is unchecked by default.

Set `HUAHUO_STUDIO_ORIGIN` to the browser-facing origin without a path and
`HUAHUO_AGENT_PUBLIC_PATH=/agent` consistently on both services and gateway.
Logout is mapped to Server's cookie-aware auth adapter so an expired login can
still clear cookies and revoke its session. Native Studio assets use the
framework's subpath support; no package files are patched. See the
[identity contract](src/server/README.md) for independent release configuration and
upgrade verification. Phone login remains disabled in production.

## Docker service

Docker reads the project's `.env` file. For a new checkout, create it from
the example:

```bash
cp .env.example .env
```

The service configuration covers DeepSeek, the model gateway, Server address and trusted identity settings,
Docker/Studio, and Mastra PostgreSQL/Memory. RAG parsing, chunking, embedding,
and reranking belong to `huahuo-server`. The older standalone RAG scripts in
this repository require explicit `RAG_*` configuration when invoked; those
settings are omitted from the Agent service's `.env` and example file.

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
and `HUAHUO_AGENT_PUBLIC_PATH=/agent` in `.env`, then open `/agent/` on the shared
Nginx origin. Studio uses native `studioBase` for its pages and assets; a small
application middleware sets its browser API prefix to `/agent/api`. Internal API
routes remain `/api`; health remains `/health`. The installed Studio template is
checked by `test/studio-prefix.test.ts` on Mastra upgrades.

All user APIs require trusted gateway identity in every environment.
`APP_ENV` in `.env` controls whether the test phone-login UI can be enabled. Test Studio uses
`development` or `test` with `HUAHUO_STUDIO_AUTH_ENABLED=true`; keep this local
configuration bound to `127.0.0.1`. Production uses `APP_ENV=production`,
`HUAHUO_STUDIO_AUTH_ENABLED=false`, and an API-only image. Compose defaults to
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

By default the published port binds to `127.0.0.1`. Use a restricted private bind address and source access controls when trusted
ingress needs to reach Agent from another host.
These Compose variables can be supplied in the shell or `.env`.
The runtime env file uses Compose's `raw` format (Compose 2.30 or later), so
write values without surrounding quotes; dollar signs in passwords and keys
are preserved.

The Server and PostgreSQL run separately. Set `HUAHUO_SERVER_BASE_URL` to the
stable private origin maintained by the deployment, without `/api` or `/agent`.
Public and internal API traffic must follow the same selected Server instance
when a release switches. Do not pin Agent to a temporary release container.

The Agent may keep its own Docker network. Use the existing shared network only
when that deployment requires it; a stable private IP and port work across
hosts. Keep the Agent listener restricted to trusted ingress/internal callers.
A `localhost` URL inside the Agent container points back to Agent itself.

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

## Git release workflow

Development uses `test`; PRs merge after the required `Agent CI` through native
GitHub Auto-merge. Successful push CI for the exact test SHA triggers the release
workflow from protected `main`. main merges remain owner-controlled; production
only prepares a release summary and retains the owner approval gate.
See [team releases](docs/runbooks/team-releases.md) and the
[standard release procedure](docs/runbooks/standard-release.md).

## Unified identity and single-domain routing

External requests authenticate through the Server auth_request endpoint at host Nginx. Agent no
longer verifies JWTs or uses directional ServiceKeys. User/session identity is
passed in reserved headers and mapped to Mastra native resource ownership; model
inputs cannot choose a different identity. Internal calls use a stable private Server origin. See [identity contract](src/server/README.md) for routing, independent release
configuration, Studio cookies, and upgrade checks.
