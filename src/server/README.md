# Server boundary

External clients use one Traefik origin: `/api/v1/...` reaches Server and
`/agent/api/...` reaches Agent's unchanged `/api/...` routes. Traefik performs
ForwardAuth before stripping `/agent` from Agent API and custom login routes.
Native Studio pages/assets keep `/agent` and use Mastra `server.studioBase`.
Internal calls use `HUAHUO_SERVER_BASE_URL=http://api-server:3000` directly.

## Identity contract

Server's `/internal/v1/gateway/auth` alone authenticates user JWTs and validates
account/session state. Traefik removes incoming identity headers and injects:

- `X-Huahuo-User-Id`: UUID.
- `X-Huahuo-Session-Id`: UUID.
- `X-Huahuo-Auth-Method`: `bearer` or `cookie`.
- `X-Trace-Id`: request correlation ID (generated if absent).

Agent reads these headers in every environment and retains native Mastra auth
and `mapUserToResourceId`. Tools obtain identity from the reserved Mastra
provider-user context, never ordinary body/model input. `ragQuery()` forwards
this identity to `/internal/v1/rag/query` without Authorization or ServiceKey.
Server retains workspace/document ownership and transaction-level session
checks. Missing identity does not fall back to a JWT or anonymous user.

`serviceRequest()` is for explicit system operations and does not manufacture
a user session; user-scoped operations must use the trusted request context.
Backend networking is unchanged by this implementation. Internal endpoints and
production stored/editor management are excluded from public gateway routing.

## Studio

Set `HUAHUO_AGENT_PUBLIC_PATH=/agent` in Agent, Server and gateway. Set
`HUAHUO_STUDIO_ORIGIN` to the external origin only (for example
`https://api.example.com`, without `/agent`). Phone login is opt-in through
`HUAHUO_STUDIO_AUTH_ENABLED=true` on both Agent and Server, development/test only.

Agent serves the login/legal UI and uses Server's existing login/SMS APIs. It
writes HttpOnly/SameSite cookies using the token expiry returned by Server;
it does not verify JWTs. Server ForwardAuth reads those cookies and performs
refresh with single-instance concurrent-request deduplication. Studio is a test
tool: reconnect/login again after a blue/green cutover if necessary; cross-instance
refresh coordination is intentionally not implemented. Studio routes are absent
on the main gateway branch. Gateway passes updated cookies
back to the browser. Cookie Path is `/agent`; old `Path=/` cookies are cleared.
Cookie requests keep same-origin checks. Public logout is routed directly to
Server's auth adapter so expired credentials can still clear browser cookies.

Native Studio assets, router and refresh-events use `server.studioBase`. The
application's `public-prefix.ts` middleware adapts only the served HTML runtime
API-prefix configuration to `/agent/api` and detects incompatible templates.
No Mastra source, package assets, or build outputs are patched. On upgrades run
typecheck, tests (including installed-template and native ownership tests),
build with Studio, and gateway smoke for login, HTML/assets/API and streaming.

## Coordinated rollout

This is an internal authentication contract change. Ship matching Server,
Agent and gateway configurations together; do not deploy Agent alone against an
old Server. Remove Agent `APP_JWT_*` and both directional `HUAHUO_*_API_KEY`
settings. Server retains its JWT issuance/verification keys for ForwardAuth.
Update the persisted gateway auth configuration using Server's documented
`sync-auth-config` operation while retaining the selected API slot. Preserve
existing application networking. This local change does not perform deployment.
