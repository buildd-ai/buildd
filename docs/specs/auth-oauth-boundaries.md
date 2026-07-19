---
title: Auth & OAuth Boundaries
status: active
owner: max
last_verified: 2026-07-18
supersedes: []
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

**Acceptance criteria**:
- AC-5: GIVEN an `admin` token WHEN `ListTools` is called on the MCP server
  THEN the `buildd` tool's `action` enum includes `trigger_release`.
- AC-6: GIVEN a `trigger` token WHEN `ListTools` is called THEN `trigger_release`
  is NOT in the `action` enum.
- AC-7: GIVEN a `worker` token WHEN `send_agent_message` is called THEN the
  response contains `isError: true` (admin-only action).

**Code surface**:
- Action lists: `packages/core/mcp-tools.ts` — `triggerActions`, `workerActions`,
  `adminActions`
- Level resolution: `apps/web/src/app/api/mcp/route.ts` —
  `getAccountLevel()`, `createMcpServer()`

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
- Authorization codes MUST be single-use (`consumedAt` set on redemption).
- Refresh tokens MUST rotate on each use (`revokedAt` set, new token issued).
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
concept). The `accounts.anthropicApiKey` deprecated column. Worker-level
concurrency limits beyond `maxConcurrentWorkers` (covered in
`runner-liveness.md`).
