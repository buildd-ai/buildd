# MCP connections: operator notes

How the one-connection MCP endpoint works for the people who run buildd, how to
check it end to end, and what a hosted MCP client (Claude, ChatGPT) controls
rather than buildd. User-facing guide: [mcp-connect.md](mcp-connect.md). The
contract is `docs/specs/auth-oauth-boundaries.md` (sections "Account-level MCP
grants" through "Managing connections").

## Endpoints

| Path | What it is |
|---|---|
| `POST /api/mcp` | The MCP endpoint. Answers 401 with a challenge when there is no valid credential. |
| `GET /.well-known/oauth-protected-resource/api/mcp` | Protected-resource metadata (RFC 9728). `resource` is exactly `<issuer>/api/mcp`. |
| `GET /.well-known/oauth-authorization-server` | Authorization-server metadata (RFC 8414). |
| `POST /api/oauth/register` | Dynamic client registration (RFC 7591). Public clients only, no secret. |
| `GET/POST /api/oauth/authorize` | Authorize + consent. `resource=<issuer>/api/mcp` selects the account-level consent page. |
| `POST /api/oauth/token` | Code exchange and refresh. |
| `GET/PATCH/DELETE /api/mcp-grants[/id]` | Settings › Connected apps. Dashboard session only. |
| `POST /api/mcp-oauth/<workspace-id>` | Legacy per-workspace endpoint. Deprecated, still served. |

The unauthenticated challenge is:

```
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer realm="buildd", resource_metadata="<issuer>/.well-known/oauth-protected-resource/api/mcp"
```

`scopes_supported` lists `mcp`, `buildd:read` and `buildd:write`. `buildd:act-as-person`
is accepted but deliberately not listed (see "Kinds" below).

## Configuration that matters

- **Issuer.** `OAUTH_ISSUER`, else `NEXTAUTH_URL` / `AUTH_URL`, else the
  production domain on Vercel production. Every metadata URL, the token audience
  and the challenge use it. Clients cache it, so it must be the stable public
  origin.
- **Self-call base URL.** The MCP route calls its own REST API over HTTP and
  forwards the caller's bearer token, so it only ever calls this server. The
  origin is `https://$VERCEL_URL` on Vercel, else `NEXTAUTH_URL`, else
  `AUTH_URL`. A local dev server (not `NODE_ENV=production`) reached on a
  loopback host also falls back to the request's own origin. There is no
  hardcoded fallback host: **on a deployment that is not Vercel, set
  `NEXTAUTH_URL` to the deployment's own origin**, or every MCP call answers
  500 `self_origin_unconfigured` and nothing is sent anywhere.
- **Signing secret.** `OAUTH_JWT_SECRET`, else `AUTH_SECRET`. Rotating it ends
  every access token at once (clients refresh; refresh tokens are stored hashed
  and are not affected).

## How a request resolves

1. The access token names a grant, not a workspace.
2. On every request the grant is resolved to its workspaces ∩ the person's current
   team memberships. Grant sessions are not cached, so revoke, shrink, read-only
   and membership loss apply on the next request.
3. The request acts in exactly one workspace: the one the tool call names, else
   the connection URL's `?workspace=` / `?repo=`, else a `?worker=`'s workspace,
   else the only granted workspace. Otherwise it is refused (`workspace_required`,
   `workspace_ambiguous`, `workspace_not_granted`, `workspace_conflict`).
4. The session is that workspace's team account at the person's role there
   (owner/admin → admin, member → worker), confined to that one workspace. Every
   self-call carries `x-buildd-workspace: <id>`, which only grant tokens honour.
5. A grant without write is a read-scoped session on MCP and REST alike.

A grant reaches its workspaces whatever their access mode: it is an explicit
consent by a current member. API keys, legacy OAuth tokens and task tokens keep
the restricted-mode rule.

## Kinds: "acts as you" and "agent working for you"

The kind is stored on the grant row only. A refresh token carries the grant id,
so no token request can change the kind.

- **Agent** (the default): no person on the session. Person-only actions refuse
  it: Abandon on a closed PR, a forced re-review of a head that already has a
  verdict, a landing-override grant on `create_task`, and merge/landing
  overrides.
- **Person**: offered only when the client requests `buildd:act-as-person`, and
  then preselected and downgradable. Because the scope is not advertised, a
  generic client that requests every advertised scope gets an agent.
- A person grant can be downgraded to agent in Settings. Agent to person needs a
  fresh consent.

## Running the live E2E

`apps/web/tests/integration/mcp-multi-workspace.test.ts` drives the whole flow
over HTTP against a real production build: discovery, DCR, authorize with PKCE,
consent POST, code exchange, MCP calls in two teams, the resolution errors, both
kinds, refresh rotation and replay, Settings edits, membership loss, revoke,
reconnect, and the legacy endpoint. It seeds users, teams and workspaces straight
into the server's database, so it refuses any database or server that is not on
loopback. It is opt-in and is not in CI's integration file list.

Never point it at a shared or production database. A local stack:

```bash
# Postgres with pgvector, on a free port
docker run -d --name buildd-e2e-pg -e POSTGRES_USER=demo -e POSTGRES_PASSWORD=demo \
  -e POSTGRES_DB=buildd_test -p 55432:5432 pgvector/pgvector:pg17

export DATABASE_URL=postgres://demo:demo@localhost:55432/buildd_test
export NEON_SQL_SHIM_PORT=44444
export NEON_LOCAL_FETCH_ENDPOINT=http://127.0.0.1:44444/sql
bun scripts/ci/neon-sql-shim.ts &            # the app's neon-http driver talks to this
(cd packages/core && bun db:migrate)

# A production build: `next dev` signs everyone in as a mock user
export AUTH_SECRET=<any long random string> AUTH_TRUST_HOST=true
export NEXTAUTH_URL=http://localhost:3999 AUTH_URL=http://localhost:3999 OAUTH_ISSUER=http://localhost:3999
(cd apps/web && bun run build:only && node node_modules/next/dist/bin/next start -p 3999) &

BUILDD_LIVE_MCP_E2E=1 BUILDD_TEST_SERVER=http://localhost:3999 \
  bun test apps/web/tests/integration/mcp-multi-workspace.test.ts
```

The test signs in as a seeded person by minting an Auth.js session cookie with
the server's `AUTH_SECRET`, so the test and the server need the same value. Stop
the server and the shim by their own PIDs, and remove the container, when done.

## Smoke test with hosted clients (Claude, ChatGPT)

buildd cannot drive these UIs from a test, and some of the behaviour belongs to
the host. Use this checklist on a deployment you are about to ship.

### What the host controls

- **The connector UI.** Where you paste the address, whether "advanced" OAuth
  settings exist, and what the host shows after sign-in.
- **How the client registers.** Hosts register with dynamic client registration
  today. A host may prefer client ID metadata documents (CIMD) when an
  authorization server advertises support; buildd does not, so the host should
  fall back to registration. Some hosts register once per connector, others once
  per user or per add, so the number of registered clients is not ours to choose.
- **Which scopes it asks for.** A hosted connector usually requests the
  advertised scopes, so it gets an **agent** connection. buildd cannot make a host
  ask for `buildd:act-as-person`, and that is intended: a hosted connector is not
  your own machine.
- **The redirect URI**, the `client_name` shown on the consent page, and when
  the host refreshes or decides to sign in again (for example after a 401).
- **Workspace choice.** Whether the model calls `list_workspaces` before acting
  is up to the model and the host's tool handling. buildd refuses calls without a
  workspace instead of guessing.

### What to click

1. In the host, add a custom connector with the address `https://<host>/api/mcp`.
   No client id or secret.
2. Start the sign-in. Expect the buildd consent page, not a per-workspace picker.
   Check: the app name and the return address are the host's; your teams are
   listed; **Agent working for you** is selected; **Acts as you** is disabled with
   "This app did not ask to act as you".
3. Tick a workspace in each of two teams. Approve. Expect to land back in the host
   with the connector connected.
4. Ask: "List my buildd workspaces." Expect both workspaces and nothing else.
5. Ask it to list tasks in each workspace by name. Expect each workspace's own
   tasks.
6. Ask it to create a task without naming a workspace. Expect it to come back with
   the choices (`workspace_required`) or to ask you which one.
7. Ask it to mark a closed PR abandoned. Expect a refusal saying only a person can.
8. In buildd, open **Settings › Connected apps**. Expect the host's app listed as
   "agent for you" with the two workspaces. Remove one. Ask the host to list
   workspaces again: one is left, with no reconnect.
9. Revoke the connection in Settings. Expect the host's next call to fail and the
   host to ask you to sign in again.

For Claude Code, run the same steps after `buildd install --global --oauth`
(acts as you: step 2 shows **Acts as you** selected, and step 7 succeeds) and
after `buildd install --global --as-agent` (agent, as above).

## Per-workspace URLs: deprecation

`/api/mcp-oauth/<workspace-id>` is **deprecated now; the removal date will be
announced.** Until then it serves legacy tokens exactly as before. Each response
carries `Deprecation: true`, `Link: <<issuer>/api/mcp>; rel="successor-version"`
and a notice in the server instructions. A grant token is refused there, and a
legacy token is refused on any other workspace's URL. Settings lists legacy
connections separately with a hint to switch.

## Limitations and known issues

- CIMD is not implemented. It needs an SSRF-safe fetch and cache, redirect
  checks against the fetched document, and an origin display on the consent page.
- Registration is open, as MCP clients need. The consent page shows a
  self-declared app name and the return host; it is not a verified identity.
- Access tokens last one hour. Refresh tokens rotate on every use, are stored
  as SHA-256 hashes, and end 90 days after sign-in. Replaying a spent refresh
  token revokes its whole family.
- Each team a connection reaches needs a shared `type='user'` session account.
  It is created at code exchange and refresh, when Settings adds a workspace in
  a team that has none (a team joined after connecting), and by `/api/mcp` when
  a granted workspace's team still has none. That team's workspace works on the
  next request, with no refresh.
- `list_workspaces` is not a chat tool.
