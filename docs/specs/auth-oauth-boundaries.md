---
title: Auth & OAuth Boundaries
status: active
owner: max
last_verified: 2026-10-09
summary: The buildd API MUST authenticate every request as either an api-key or an OAuth token, apply only that auth type's billing and concurrency limits, and reject ambiguous multi-workspace OAuth claims.
domain: auth
surfaces: [apps/web/src/lib/api-auth.ts, apps/web/src/lib/mcp-grants.ts, apps/web/src/lib/oauth/account-consent.ts, apps/web/src/app/api/oauth/token/route.ts]
related: [mcp-action-contracts, credential-isolation, team-namespace-scoping]
keywords: [bld_ api key, authtype, maxconcurrentsessions, budgetexhaustedat, device code, pkce]
verified_by: [apps/web/tests/db/mcp-oauth-grants.test.ts, apps/web/tests/db/mcp-oauth-consent.test.ts, apps/web/src/lib/oauth/account-consent.test.ts, apps/web/src/app/well-known-oauth-protected-resource-mcp-route.test.ts, apps/web/src/lib/api-auth.test.ts, apps/web/src/lib/oauth/tokens.test.ts, apps/web/src/app/api/oauth/token/route.test.ts]
supersedes: []
# Structural conformance only; passing does not certify every prose invariant.
assertions:
  - id: "authenticate-api-key"
    type: "symbol"
    name: "authenticateApiKey"
    path: "apps/web/src/lib/api-auth.ts"
  - id: "claim-worker"
    type: "route"
    method: "POST"
    path: "/api/workers/claim"
    file: "apps/web/src/app/api/workers/claim/route.ts"
  - id: "claim-auth-tests"
    type: "test_file"
    path: "apps/web/src/app/api/workers/claim/route.test.ts"
  - id: "resolve-granted-workspaces"
    type: "symbol"
    name: "resolveGrantedWorkspaces"
    path: "apps/web/src/lib/mcp-grants.ts"
  - id: "mcp-grant-tests"
    type: "test_file"
    path: "apps/web/tests/db/mcp-oauth-grants.test.ts"
  - id: "account-consent-validate"
    type: "symbol"
    name: "validateApproval"
    path: "apps/web/src/lib/oauth/account-consent.ts"
  - id: "account-consent-tests"
    type: "test_file"
    path: "apps/web/tests/db/mcp-oauth-consent.test.ts"
---
# Auth & OAuth Boundaries

**Capability statement**: The buildd API MUST authenticate every request using
either an `api`-type key (`bld_xxx`) or an `oauth`-type token, enforce the
correct billing and concurrency limits per auth type, and prevent ambiguous
multi-workspace routing for OAuth tokens that have access to more than one
workspace.

---

## Dual Auth Model

| Auth type | Credential format | Billing | Primary limits |
|-----------|------------------|---------|----------------|
| `api` | `bld_xxx` API key | Pay-per-token | `maxCostPerDay`, team monthly budget (`monthlyBudgetUsd`) |
| `oauth` | JWT in `secrets` table (`purpose = 'oauth_token'`) | Seat-based | `maxConcurrentSessions`, `budgetExhaustedAt`/`budgetResetsAt` |

**Invariants**:
- Every authenticated request resolves to exactly one `accounts` row via
  `authenticateApiKey()`. No request proceeds without a valid row.
- `accounts.authType` MUST be checked before applying any limit — applying
  `maxCostPerDay` to an OAuth account or `maxConcurrentSessions` to an API
  account MUST NOT occur.
- `accounts.level` (`trigger | worker | admin`) gates the MCP action set and
  some API routes independently of `authType`.
- `accounts.oauthToken` (the old plaintext column) is deprecated. New OAuth
  tokens are stored encrypted in `secrets` (`purpose = 'oauth_token'`). Both
  paths must authenticate correctly during the transition.

**Acceptance criteria**:
- AC-1: WHEN a request carries an unknown Bearer token THEN `authenticateApiKey`
  returns `null` and the route returns HTTP 401.
- AC-2: GIVEN an `api`-type account at `maxCostPerDay` limit WHEN `claim_task`
  is called THEN the server returns HTTP 429 with `error: "Daily cost limit exceeded"`.
- AC-3: GIVEN an `oauth`-type account at `maxConcurrentSessions` limit WHEN
  `claim_task` is called THEN the server returns HTTP 429 with
  `error: "Max concurrent sessions limit reached"`.
- AC-4: GIVEN an API key whose account has `level = 'trigger'` WHEN `claim_task`
  is called THEN the server returns HTTP 403 with
  `error: "Trigger tokens cannot claim tasks"`.

**Code surface**:
- Auth helper: `apps/web/src/lib/api-auth.ts` — `authenticateApiKey()`
- Claim route: `apps/web/src/app/api/workers/claim/route.ts` (limit checks,
  lines ~80–119)
- Schema: `packages/core/db/schema.ts` — `accounts` table, `authType`,
  `level`, `maxCostPerDay`, `maxConcurrentSessions`
- Secrets: `packages/core/secrets/` — `getSecretsProvider()`, `oauth-token.ts`

---

## Account Levels and Action Gating

**Invariants**:
- `trigger`: can create tasks and artifacts, read tasks/schedules. MUST NOT
  claim, execute, or access admin actions.
- `worker`: full task execution lifecycle. MUST NOT access admin-only actions
  (manage_missions, trigger_release, send_agent_message, etc.).
- `admin`: all actions. Access to workspace management, release triggers,
  skill registration, secret management, spec_compare.
- The MCP server filters the exposed action list at server-creation time based on
  `accountLevel`; no level-downgrade is possible mid-request.
- An OAuth JWT session's level MUST come from the caller's current
  `team_members.role` on the token's workspace team: `owner`/`admin` →
  `admin`, `member` → `worker`, and any other or missing role → `worker`
  (`levelForTeamRole()`). A caller with no membership row MUST NOT
  authenticate. Both `/api/mcp` and `/api/mcp-oauth/[workspace]` act at that
  level, and so do the `/api/*` self-calls they make with the same bearer.
- The OAuth session cache MUST bound how long a role change or membership
  removal can go unseen: 30s in-process plus 30s in Redis, so ≤60s. `bld_`
  API keys keep their 5-minute cache.

**Acceptance criteria**:
- AC-5: GIVEN an `admin` token WHEN `ListTools` is called on the MCP server
  THEN the `buildd` tool's `action` enum includes `trigger_release`.
- AC-6: GIVEN a `trigger` token WHEN `ListTools` is called THEN `trigger_release`
  is NOT in the `action` enum.
- AC-7: GIVEN a `worker` token WHEN `send_agent_message` is called THEN the
  response contains `isError: true` (admin-only action).
- AC-7a: GIVEN an OAuth JWT for a user whose team role is `member` WHEN
  `authenticateApiKey` resolves it THEN `level` is `worker`; for `owner` or
  `admin` it is `admin`; with no membership row it returns `null`.
- AC-7b: GIVEN a member's OAuth session WHEN an admin-only action is called on
  `/api/mcp-oauth/[workspace]` THEN the result is `{"error":"forbidden",
  "requiredLevel":"admin"}`.

**Code surface**:
- Action lists: `packages/core/mcp-tools.ts` — `triggerActions`, `workerActions`,
  `adminActions`
- Level resolution: `apps/web/src/app/api/mcp/route.ts` —
  `getAccountLevel()`, `createMcpServer()`
- OAuth role → level: `apps/web/src/lib/oauth/session-level.ts` —
  `levelForTeamRole()`; applied in `apps/web/src/lib/api-auth.ts`
  (`authenticateOauthJwt()`)

---

## OAuth Multi-Workspace Guard

**Invariants**:
- An OAuth token with access to more than one workspace MUST NOT be used to
  claim tasks or write memories without an explicit `workspaceId`.
- The MCP server guard fires for `buildd_memory` write actions (see
  `mcp-action-contracts.md` AC-5).
- The claim route guard fires at the API boundary (not just MCP) for OAuth
  tokens with `>1` accessible workspace when no `workspaceId` is provided and
  `claimAcrossAccessible` is not set.
- `claimAcrossAccessible: true` is an explicit opt-in for multi-workspace
  runners that intentionally serve all workspaces.

**Acceptance criteria**:
- AC-8: GIVEN an OAuth token with access to 2 workspaces and no `workspaceId`
  in the claim body WHEN `POST /api/workers/claim` is called THEN the server
  returns HTTP 400 with `error` referencing "multiple workspaces".
- AC-9: GIVEN an OAuth token with `claimAcrossAccessible: true` in the request
  body WHEN `POST /api/workers/claim` is called THEN the multi-workspace guard
  is bypassed and claiming proceeds.

**Code surface**:
- Claim guard: `apps/web/src/app/api/workers/claim/route.ts` lines ~121–155
- MCP memory guard: `apps/web/src/app/api/mcp/route.ts` — `buildd_memory`
  handler, `getWorkspaceId()` check

---

## Budget Exhaustion (OAuth)

**Invariants**:
- An OAuth account with `budgetExhaustedAt` set MUST have the flag auto-cleared
  when `budgetResetsAt` is in the past (the budget window has expired).
- Auto-clearing happens at the start of the claim route (no manual intervention
  needed).
- Tasks with their own tenant API keys are still claimable even when the
  umbrella OAuth budget is exhausted (`tenantBudgets` table).

**Acceptance criteria**:
- AC-10: GIVEN `budgetResetsAt` in the past WHEN `claim_task` is called THEN
  `accounts.budgetExhaustedAt` and `budgetResetsAt` are set to `null` and
  claiming proceeds normally.

**Code surface**:
- Auto-clear: `apps/web/src/app/api/workers/claim/route.ts` lines ~107–118
- Schema: `packages/core/db/schema.ts` — `accounts.budgetExhaustedAt`,
  `budgetResetsAt`

---

## OAuth 2.1 PKCE (MCP Clients)

**Capability statement**: The buildd OAuth 2.1 server MUST issue
workspace-scoped access tokens to MCP clients (e.g. claude.ai) using the
authorization code + PKCE flow, and the `/api/mcp-oauth/[workspace]` endpoint
MUST reject tokens whose `workspaceId` claim does not match the URL path.

**Invariants**:
- Authorization codes MUST be single-use: redemption is one conditional
  `UPDATE ... WHERE consumed_at IS NULL RETURNING`, so concurrent exchanges of
  one code cannot both succeed.
- Refresh tokens MUST rotate on each use (`revokedAt` set by the same
  conditional-UPDATE pattern, new token issued).
- Both grants MUST re-check that the user is still a member of the
  workspace's team. On refresh, a non-member gets `invalid_grant` and every
  outstanding refresh token for that user and workspace is revoked.
- Access tokens carry `workspaceId` in the JWT claim; the workspace-scoped MCP
  endpoint rejects tokens for the wrong workspace.
- `oauthRefreshTokens.expiresAt` defines the absolute refresh lifetime.

**Acceptance criteria**:
- AC-11: GIVEN a valid authorization code WHEN it is exchanged at `/api/oauth/token`
  a second time THEN the server returns HTTP 400 (code already consumed).
- AC-12: GIVEN a valid refresh token WHEN `/api/oauth/token` is called with
  `grant_type=refresh_token` THEN a new access token and rotated refresh token
  are returned, and the old refresh token is marked `revokedAt`.
- AC-13: GIVEN an access token for `workspaceId = A` WHEN
  `/api/mcp-oauth/B` (workspace B) is called THEN the server returns HTTP 401.

**Code surface**:
- OAuth routes: `apps/web/src/app/api/oauth/` — `authorize`, `token`, `register`
- Workspace-scoped endpoint: `apps/web/src/app/api/mcp-oauth/[workspace]/route.ts`
- Schema: `packages/core/db/schema.ts` — `oauthClients`, `oauthCodes`,
  `oauthRefreshTokens`

---

## Account-level MCP grants

**Capability statement**: One MCP OAuth connection MUST be able to reach a
chosen set of workspaces across the user's teams. The token names a grant, not
workspaces; what it reaches is decided server-side on every request.

**Model** (`packages/core/db/schema.ts`):
- `mcp_oauth_grants`: `id`, `user_id`, `client_id`, `acts_as`
  (`'person' | 'agent'`, required), `scopes` (non-empty subset of
  `["read","write"]`), `expires_at`, `revoked_at`, `created_at`, `updated_at`.
- `mcp_oauth_grant_workspaces`: one row per granted workspace
  (`grant_id`, `workspace_id`), cascading on either side.
- `oauth_codes` and `oauth_refresh_tokens` carry exactly one of
  `workspace_id` (legacy) or `grant_id` (CHECK `num_nonnulls(...) = 1`).

**Invariants**:
- A grant access token's claims are `sub` (user), `client_id`, `scope` and
  `grant_id`, with the account-level audience. It never carries a workspace
  list. A token with both `workspace_id` and `grant_id`, or neither, is
  refused, and the workspace-bound verifier refuses any grant token.
- What a grant reaches is `resolveGrantedWorkspaces(grantId, userId)`: the
  grant's workspaces ∩ workspaces whose team the user is a member of now, for a
  grant that is the user's, not revoked and not expired. It is evaluated on
  every request (grant sessions are never cached) and at every refresh, so a
  revoked grant, a removed membership, a deleted workspace or a workspace moved
  to another team takes effect on the next call.
- A grant is also bound to its client: a code or refresh token presented by
  another client does not resolve.
- New workspaces are never added to a grant implicitly. Creating a grant
  refuses any workspace the user cannot reach, writes nothing, and names none.
- A grant session is confined to the workspaces it currently reaches
  (`account.workspaceIds`), so a self-call naming another workspace, even one
  in the same team, is refused. A grant that reaches workspaces in more than
  one team does not pick a team on the generic auth path; it authenticates
  only where the request names its workspace.
- Refusals at the token endpoint and in auth never name a grant, workspace or
  team id.
- A refresh mints a token for the same grant. The grant's workspaces and
  `acts_as` live only on the grant row, so a refresh cannot widen the set or
  change the kind. A refresh whose grant no longer resolves is refused and
  revokes every refresh token issued under that grant.
- `acts_as = 'person'`: the session carries `sessionUserId`, so
  `requestingPerson()` (`apps/web/src/lib/request-person.ts`) returns the user
  and person-only actions are allowed as `human:<userId>`.
- `acts_as = 'agent'`: the session is attributed to the user (`oauthUserId`,
  actor `agent:oauth:<userId>`) but carries no `sessionUserId`, and
  `requestingPerson()` returns null for it, so every person-only action
  (Abandon, forced review, landing override, merge override) refuses it.
- A legacy token (a `workspace_id` claim from the per-workspace connection) is
  an implicit single-workspace `'person'` grant, resolved with the same
  membership check as before and its historical reach (`workspaceIds = null`).
  Per-task `bldt_` tokens and `bld_` API keys are unchanged.

**Acceptance criteria**:
- AC-16: GIVEN a grant on workspaces in two teams WHEN
  `resolveGrantedWorkspaces` runs THEN it returns exactly those workspaces and
  no other workspace of either team.
- AC-17: GIVEN a live grant token WHEN the user leaves the team, or the grant
  is revoked, THEN the next `authenticateApiKey` call returns `null`.
- AC-18: GIVEN a grant refresh token WHEN the grant has been revoked, or the
  user has lost membership, THEN `/api/oauth/token` returns 400
  `invalid_grant`, the body names no id, and the grant's other refresh tokens
  are revoked.
- AC-19: GIVEN an `'agent'` grant WHEN its token is refreshed (even with an
  `acts_as` form field) THEN the new token names the same grant and the kind is
  still `'agent'`.
- AC-20: GIVEN an `'agent'` grant WHEN it asks to Abandon a closed PR, or to
  force a review, THEN the request is refused (403 / 409) and the delivery is
  unchanged; GIVEN a `'person'` grant THEN both are allowed, as
  `human:<userId>`.
- AC-21: GIVEN a legacy workspace-claim token WHEN it authenticates THEN it
  acts as the person with `workspaceIds = null`, and its refresh still rotates
  a workspace-bound pair.

**Code surface**:
- Resolver: `apps/web/src/lib/mcp-grants.ts` — `createGrant()`,
  `resolveGrantedWorkspaces()`, `resolveGrant()`, `resolveTokenGrant()`,
  `grantPrincipal()`, `revokeGrant()`
- Tokens: `apps/web/src/lib/oauth/tokens.ts` — `signGrantAccessToken()`,
  `verifyAccessTokenAnyAudience()`; storage bindings in
  `apps/web/src/lib/oauth/storage.ts`
- Per-request auth: `apps/web/src/lib/api-auth.ts` — `authenticateOauthJwt()`
- Token endpoint: `apps/web/src/app/api/oauth/token/route.ts`
- Tests: `apps/web/tests/db/mcp-oauth-grants.test.ts` (real Postgres)

**Out of scope here**: the account-level MCP transport, grant management UI
and refresh-token storage hardening (hashing, rotation families) are separate
tasks of the same mission. The consent page that creates grants is below.

---

## Account-level consent

**Capability statement**: A person MUST be able to connect one MCP client to a
chosen set of workspaces across their teams from a single consent page, and
the server MUST grant exactly what the client asked for and the person chose,
re-validated on submit.

**Entry point**: `/api/oauth/authorize` with `resource=<issuer>/api/mcp`
(RFC 8707). Without that resource the per-workspace flow is unchanged
(`workspace` param or the single-workspace picker, workspace-bound code).
Protected-resource metadata for the account resource is served at
`/.well-known/oauth-protected-resource/api/mcp`; the per-workspace metadata,
the authorization-server metadata and dynamic client registration are
unchanged apart from the advertised scopes.

**Scopes** (`apps/web/src/lib/oauth/account-consent.ts`):
- `mcp` or `buildd:write`: read and write. `buildd:read` alone: read only. No
  read/write scope: read and write, as before. Unknown scopes are ignored and
  never granted.
- `buildd:act-as-person`: the client asks for a connection that acts as the
  person (`buildd install --oauth` sends it). It is accepted but deliberately
  not listed in `scopes_supported`, so a generic client that requests every
  advertised scope does not ask to act as the person by default.
- The code and token carry the granted scope string (`buildd:read`, plus
  `buildd:write`, plus `buildd:act-as-person` for a person grant). The grant
  row stays the authority.

**Invariants**:
- The page lists every team the user is a member of now, each with its
  workspaces, sorted by name. Each team is a collapsible group paged at 20
  workspaces; search filters by workspace or team name. Select all (or all
  matches while searching), Clear all, and per-team select/clear are
  available. Search, page turns and selection actions are form posts that
  carry the selection, so the page needs no script.
- Exactly one workspace is preselected: the `workspace` hint when the user can
  reach it, else the first workspace of the first team.
- The kind defaults to **Agent working for you**. **Acts as you** is selectable
  only when the client sent `buildd:act-as-person`; it is then preselected and
  the person can downgrade it. Write is preselected only when requested and
  can be unticked.
- Every post (page action or decision) needs a same-origin `Origin` and a
  consent token: an HMAC over the signed-in user and every authorize
  parameter (client, redirect, PKCE challenge and method, scope, state,
  workspace hint, resource), valid for 10 minutes. Changing any parameter,
  another user's token, or a forged one is refused with 403.
- PKCE is S256 only, checked before the page renders; the token endpoint
  verifies the verifier.
- On approval the server re-reads the user's teams and refuses the whole
  approval when any chosen workspace is not reachable now (403), when the kind
  is `person` without `buildd:act-as-person`, when the kind is unknown, or when
  write is chosen but was not requested (400). Nothing is dropped silently,
  nothing is written, and no refusal names an id. An empty choice shows the
  page again with a message.
- Approval creates one grant (`createGrant`) and one code bound to it
  (`createAuthCode({ grantId })`); the token endpoint binds the code to the
  grant as in "Account-level MCP grants". Cancel redirects with
  `access_denied` and the client's `state`.

**Client ID metadata documents (CIMD)**: not supported. Accepting an https URL
as `client_id` needs a server-side fetch with SSRF protection and caching,
redirect validation against the fetched document and a consent display of the
document's origin; that is not small. Clients keep using dynamic client
registration (`/api/oauth/register`).

**Acceptance criteria**:
- AC-22: GIVEN an authorize request for the account resource WHEN the page
  renders THEN it lists only the user's teams' workspaces, preselects one,
  selects the agent kind and issues no code.
- AC-23: GIVEN an approval naming a workspace outside the user's teams WHEN it
  is posted THEN the response is 403, names no id, and no grant row exists.
- AC-24: GIVEN a request without `buildd:act-as-person` WHEN an approval posts
  `acts_as=person` THEN the response is 400 and no grant row exists.
- AC-25: GIVEN a request with `buildd:act-as-person` WHEN the person approves
  as agent with write unticked THEN the grant is `agent` with `["read"]`.
- AC-26: GIVEN a consent post with a missing or forged consent token, another
  user's token, a changed `state` or `scope`, or a foreign or missing Origin
  THEN it is refused with 403 and nothing is written.
- AC-27: GIVEN a team with more than one page of workspaces WHEN the person
  turns the page and ticks another THEN both the earlier and the new choice
  are in the grant.

**Code surface**:
- Consent logic and page: `apps/web/src/lib/oauth/account-consent.ts` —
  `parseRequestedAccess()`, `initialConsentState()`, `applyNav()`,
  `validateApproval()`, `renderAccountConsentPage()`
- Authorize endpoint: `apps/web/src/app/api/oauth/authorize/route.ts`
- Metadata: `apps/web/src/app/.well-known/oauth-protected-resource/api/mcp/route.ts`
- Fixture for visual review: `/app/dev/oauth-consent` (fake data)
- Tests: `apps/web/tests/db/mcp-oauth-consent.test.ts` (real Postgres),
  `apps/web/src/lib/oauth/account-consent.test.ts`

---

## CLI Device-Code Auth

**Capability statement**: CLI clients MUST be able to obtain an API key via a
device-code flow without a browser redirect — the CLI polls while the user
approves in the dashboard.

**Invariants**:
- Device codes expire; an expired code MUST NOT be approved.
- A code transitions `pending → approved` exactly once.
- The API key is stored temporarily in `deviceCodes.apiKey` and cleared after
  the CLI retrieves it.

**Acceptance criteria**:
- AC-14: GIVEN an expired device code WHEN the user attempts to approve it THEN
  the server returns an error.
- AC-15: GIVEN an approved device code WHEN the CLI polls `/api/auth/device/token`
  THEN the response contains the API key and subsequent polls return an error
  (key cleared).

**Code surface**:
- Routes: `apps/web/src/app/api/auth/device/` — `code`, `approve`, `token`
- Schema: `packages/core/db/schema.ts` — `deviceCodes` table

**Out of scope**: Per-team `notificationPreferences` (a related auth-adjacent
concept). Worker-level concurrency limits beyond `maxConcurrentWorkers` (covered
in `runner-liveness.md`).
