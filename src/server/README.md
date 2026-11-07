# Server boundary

Mastra owns the HTTP/SSE runtime. Authentication is configured in
`src/auth/mastra-auth.ts`; this directory contains the outbound Server client.

Set `HUAHUO_SERVER_BASE_URL` to the Server root URL. Use
`http://localhost:3000` for a host process, or the Compose service name such as
`http://api-server:3000` when Agent and Server share a network. Set
`APP_JWT_JWKS_URL` separately to the Server JWKS endpoint; localhost is accepted
only for local development.

## Server authentication

The Agent uses the shared user JWT issued by `huahuo-server` for user requests.
It verifies the token locally through `APP_JWT_JWKS_URL` using EdDSA/Ed25519,
issuer `huahuo-server`, audience `huahuo-agent`, and the `kid` selected from JWKS.

When the Agent calls a user-scoped Server API, it sends both headers:

```http
Authorization: Bearer <USER_JWT>
X-Huahuo-Service-Key: <HUAHUO_AGENT_TO_SERVER_API_KEY>
```

The user ID comes only from the verified JWT `sub` claim. Legacy user-id headers
and Bearer-encoded service keys are not supported.

Server-to-Agent internal routes, when registered under `/internal/`, additionally
require `X-Huahuo-Service-Key: <HUAHUO_SERVER_TO_AGENT_API_KEY>`. APP-facing
Agent routes do not require a service key.

In local development (`APP_ENV=development`), Mastra Studio and its API routes
are available without a user JWT. This only affects entry to the local Studio;
the Service Key remains read from the Agent environment and is never supplied
by the model or Studio. For a user-scoped RAG run, add the user's JWT to that
run's RequestContext:

```json
{ "huahuoUserJwt": "<USER_JWT>" }
```

The RAG tool combines that per-run JWT with
`HUAHUO_AGENT_TO_SERVER_API_KEY` from the environment. Production keeps
`/api/*` protected by JWT, and the Server still requires the JWT on the RAG
request to resolve the user's workspace.

`HuahuoServerClient.ragQuery()` is a user-scoped call. It reads the verified
JWT from the current Mastra `RequestContext` and sends both credentials.
`serviceRequest()` is for system calls and sends only the Agent→Server Service
Key; the model and Tool input never choose this mode.
