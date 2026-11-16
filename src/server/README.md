# Server boundary

External clients use one host Nginx origin: `/api/v1/...` reaches Server and
`/agent/api/...` reaches Agent's unchanged `/api/...` routes. Nginx calls Server via native
`auth_request` before stripping `/agent` from Agent API and custom login routes.
Native Studio pages/assets keep `/agent` and use Mastra `server.studioBase`.
Internal calls use `HUAHUO_SERVER_BASE_URL`, a stable private origin supplied
by the deployment. It follows Server releases and contains no API/path suffix.

Both internal listeners accept IP-based and service-name-based HTTP requests.
For Agent → Server, set `HUAHUO_SERVER_BASE_URL` to either
`http://<private-ip>:<port>` or `http://<service-name>:<port>`. In a shared Docker
network, `http://api-server:3000` reaches Server directly; callers can likewise
reach Agent at `http://agent:4111/api/...`, without the public `/agent` prefix.
Separate Compose projects need a shared network or explicitly configured DNS
to resolve one another's service names. Across hosts, use a reachable private
host IP and published port, or a resolvable internal DNS name. Container IPs
are not stable deployment addresses. Keep the public Studio origin separate.

A direct instance address does not ensure uninterrupted updates. Callers that
need release-independent routing use a stable logical service endpoint supplied
by the deployment. Future Agent replicas sit behind that endpoint; applications
do not select blue/green slots or maintain replica IP lists. Server currently has
no outbound Agent business client, so there is no unused reverse-call URL setting.
Agent's Server client has no automatic retry. The current single-port Agent
release allows a short interruption; IP/name support does not imply zero-loss
rolling updates or resumption of an interrupted model stream.

## Identity contract

Server's `/internal/v1/gateway/auth` alone authenticates user JWTs and validates
account/session state. Nginx removes incoming identity headers and injects:

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
it does not verify JWTs. Server admission reads those cookies and performs
refresh with single-instance concurrent-request deduplication. Studio is a test
tool: reconnect/login again after a release or restart if necessary; cross-instance
refresh coordination is intentionally not implemented. Studio routes are absent
on the main ingress. Nginx passes updated cookies
back to the browser. Cookie Path is `/agent`; old `Path=/` cookies are cleared.
Cookie requests keep same-origin checks. Public logout is routed directly to
Server's auth adapter so expired credentials can still clear browser cookies.

Native Studio assets, router and refresh-events use `server.studioBase`. The
application's `public-prefix.ts` middleware adapts only the served HTML runtime
API-prefix configuration to `/agent/api` and detects incompatible templates.
No Mastra source, package assets, or build outputs are patched. On upgrades run
typecheck, tests (including installed-template and native ownership tests),
build with Studio, and the installed-image HTTP smoke. Host ingress routing is
validated by its own maintenance process.

## Independent release

Agent releases independently. Before replacing Agent, its executor verifies the
configured Server readiness and admission contract. It does not read Server Git
refs, release records or containers. A missing/incompatible dependency blocks
the release before Mastra storage initialization or stopping the current Agent. Remove Agent `APP_JWT_*` and both directional `HUAHUO_*_API_KEY`
settings. Server retains its JWT issuance/verification keys for its admission endpoint.
The host keeps Nginx, certificates, routing and upstream selection outside both
application repositories. Server and Agent keep their own application listeners
and existing data connections. Local code changes do not install or reload the
host ingress.

Nginx auth subrequests receive only 204/401/403 (or fail-closed 5xx). Server
returns a separate login redirect hint on denied Studio HTML navigation and
four named Cookie headers when rotating/clearing browser tokens. Nginx turns
these into browser redirects and separate Set-Cookie headers. Agent receives
only trusted identity and does not interpret these internal response headers.
Public `/agent/studio-auth/logout` is handled entirely by Server. Agent has no
duplicate logout route or unauthenticated Studio redirect fallback.
