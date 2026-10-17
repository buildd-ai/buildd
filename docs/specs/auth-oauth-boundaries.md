---
title: Auth & OAuth Boundaries
status: active
owner: max
last_verified: 2026-10-15
summary: Inbound credentials MUST resolve to an account and apply claim limits according to how the runner pays for model usage.
domain: auth
surfaces: [apps/web/src/lib/api-auth.ts, apps/web/src/app/api/workers/claim/route.ts]
related: [oauth-provider-and-jwks, credential-isolation, team-namespace-scoping]
keywords: [bld_ api key, authtype, maxconcurrentsessions, budgetexhaustedat, billing limits]
verified_by: [apps/web/src/lib/api-auth.test.ts, apps/web/src/app/api/workers/claim/route.test.ts]
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
---
# Auth & OAuth Boundaries

**Capability statement**: The buildd API MUST authenticate every request to
one `accounts` row (a `bld_xxx` key, or an OAuth 2.1 access token buildd
issued to an MCP client), apply the claim limits that match how the account's
**model** usage is paid (`authType`), and refuse ambiguous multi-workspace
routing for OAuth tokens that reach more than one workspace.

---

## Dual Auth Model

`accounts.authType` says how a runner account's model usage is paid, and so
which claim limits apply. It does not say how the account authenticates to
buildd: both types authenticate with a `bld_xxx` key, which is unrelated to
model billing. buildd coordinates the agent; it does not provide model access.

| Auth type | What pays for the model | Billing | Primary limits |
|-----------|-------------------------|---------|----------------|
| `api` | An API key (the team's, from buildd's `secrets` table, or the runner's own) | Pay-per-token | `maxCostPerDay`, team monthly budget (`monthlyBudgetUsd`) |
| `oauth` | A subscription login on the runner's **own machine** (`claude login` or `CLAUDE_CODE_OAUTH_TOKEN`; `codex login`) | Plan-based | `maxConcurrentSessions`, `budgetExhaustedAt`/`budgetResetsAt` |

**Invariants**:
- Every authenticated request resolves to exactly one `accounts` row via
  `authenticateApiKey()`. No request proceeds without a valid row.
- `accounts.authType` MUST be checked before applying any limit. Applying
  `maxCostPerDay` to an `oauth` account or `maxConcurrentSessions` to an `api`
  account MUST NOT occur.
- `accounts.level` (`trigger | worker | admin`) gates the MCP action set and
  some API routes independently of `authType`.
- A subscription login stays on the machine or interactive session that owns
  it. Who supplies a task's model credential, in what order, is the approved
  spec "Model credentials: the runner's own login first, API keys from buildd"
  (a8d1eb82): the machine's own login first, then an API key buildd delivers
  on the claim, then nothing. buildd never stores a new subscription login,
  never refreshes, leases or writes one back, and a claim delivers only API
  keys (and a team agent model endpoint where one is set).
- Server-stored subscription credentials (`secrets` purposes `oauth_token`,
  `claude_credential`, `codex_credential`, and the old plaintext
  `accounts.oauthToken` column) are legacy. They are being removed under
  a8d1eb82 (R-2, R-8): the claim stops reading them first, and the rows are
  deleted only in a later, owner-approved step. No new code may read, refresh
  or hand them out.

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
- Auth helper: `apps/web/src/lib/api-auth.ts`: `authenticateApiKey()`
- Claim route: `apps/web/src/app/api/workers/claim/route.ts` (the per-`authType`
  limit checks) and `claim-limits.ts` (`accountLimitRefusal`, which writes the
  `daily_cost_limit` and `max_concurrent_sessions` refusals)
- Schema: `packages/core/db/schema.ts`: `accounts` table, `authType`,
  `level`, `maxCostPerDay`, `maxConcurrentSessions`
- Credential order on the runner: a8d1eb82 and its build task

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
  `team_members.role` in the team the request acts in: the team of the
  workspace the request is bound to for a grant token (one granted team, or
  the workspace the request names), the token's workspace team for a legacy
  token. `owner`/`admin` give `admin`, `member` gives `worker`, and any other
  or missing role gives `worker` (`levelForTeamRole()`). A caller with no membership row MUST NOT
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
- AC-70: GIVEN an OAuth JWT for a user whose team role is `member` WHEN
  `authenticateApiKey` resolves it THEN `level` is `worker`; for `owner` or
  `admin` it is `admin`; with no membership row it returns `null`.
- AC-71: GIVEN a member's OAuth session WHEN an admin-only action is called on
  `/api/mcp-oauth/[workspace]` THEN the result is `{"error":"forbidden",
  "requiredLevel":"admin"}`.

**Code surface**:
- Action lists: `packages/core/mcp-tools.ts`: `triggerActions`, `workerActions`,
  `adminActions`
- Level resolution: `apps/web/src/app/api/mcp/route.ts`:
  `getAccountLevel()`, `createMcpServer()`
- OAuth role → level: `apps/web/src/lib/oauth/session-level.ts`:
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
- Claim guard: `apps/web/src/app/api/workers/claim/route.ts`, `POST` (the
  `claimAcrossAccessible` check, `isGrantSession` first, then `authType === 'oauth'`)
- MCP memory guard: `apps/web/src/app/api/mcp/route.ts`: `buildd_memory`
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
- Auto-clear: `apps/web/src/app/api/workers/claim/route.ts`, `POST` (the
  `budgetExhaustedAt` branch, using `isBudgetExhausted` from `lib/budget-errors.ts`)
- Schema: `packages/core/db/schema.ts`: `accounts.budgetExhaustedAt`,
  `budgetResetsAt`

---

## MCP OAuth

Provider tokens, consent, grants, transport confinement and connection
management are defined in [OAuth Provider & Signing Keys](oauth-provider-and-jwks.md).

## Device-code authentication

The CLI device-code flow is defined once in
[OAuth Provider & Signing Keys](oauth-provider-and-jwks.md#cli-and-device-code-key-issuance).
This contract covers inbound account authentication and model-billing claim
limits; it does not redefine provider token or device-code issuance.

## Renumbered

Renumbered on 2026-10-15 so every criterion parses: AC-7a to AC-70, AC-7b to AC-71.
