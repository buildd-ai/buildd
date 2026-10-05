---
title: Provider Failover
status: active
owner: max
last_verified: 2026-10-04
summary: When a task's agent backend hits a budget or rate-limit wall or has its credential rejected, the system MUST re-queue that task on another enabled, un-walled backend, or park it until the earliest provider reset.
domain: runners
surfaces: [packages/core/backend-policy.ts, apps/web/src/lib/backend-failover.ts, apps/web/src/app/api/workers/claim/route.ts, apps/web/src/app/api/workers/[id]/route.ts]
related: [codex-backend-spec, credential-isolation, runner-liveness]
keywords: [backend_pauses, budget_exhausted_at, failoverpriority, rate limit, openrouter, oauth budget]
assertions:
  - id: backend-registry
    type: symbol
    name: BACKEND_REGISTRY
    path: packages/core/backend-policy.ts
  - id: pick-failover-backend
    type: symbol
    name: pickFailoverBackend
    path: packages/core/backend-policy.ts
  - id: failover-candidates
    type: symbol
    name: failoverCandidates
    path: packages/core/backend-policy.ts
  - id: backend-policy-test
    type: test_file
    path: packages/core/__tests__/backend-policy.test.ts
  - id: route-uses-oauth-seat
    type: symbol
    name: routeUsesOauthSeat
    path: apps/web/src/app/api/workers/claim/claude-model-route.ts
  - id: claude-model-route-test
    type: test_file
    path: apps/web/src/app/api/workers/claim/claude-model-route.test.ts
  - id: is-backend-pinned
    type: symbol
    name: isBackendPinned
    path: packages/core/backend-policy.ts
  - id: describe-backend-routing
    type: symbol
    name: describeBackendRouting
    path: packages/core/backend-policy.ts
supersedes: []
---
# Provider Failover

**Capability statement**: When a task's agent backend hits a budget/rate-limit
wall or has its credential rejected, buildd MUST move that task to another
enabled, configured, un-walled backend in either direction — and when no such
backend exists, MUST park the task no later than the first moment any provider
frees up.

---

## Backend registry

**Capability statement**: Every routing decision about "which provider can run
this" MUST derive from one declarative registry, so adding a provider is a
registry entry rather than a new branch at each call site.

**Invariants**:
- `BACKEND_REGISTRY` in `packages/core/backend-policy.ts` is the sole source of
  provider labels, credential purposes, failover order (`failoverPriority`) and
  dispatchability.
- A backend with `dispatchable: false` MUST NOT be written to `tasks.backend`,
  MUST NOT be offered as a failover target, and MUST NOT be reported as
  configured. `openrouter` is registered with `dispatchable: false` because the
  `agent_backend` enum has no such value and the runner has no per-task
  OpenRouter route; the runner-wide `llmProvider` config is a separate mechanism.
- Failover candidates for a task MUST exclude its current backend and any
  backend the team's `enabledBackends` mask disables.

**Acceptance criteria**:
- AC-1: WHEN `failoverCandidates('codex', null)` is called THEN it returns
  `['claude']`.
- AC-2: WHEN `failoverCandidates('codex', ['codex'])` is called (Claude disabled
  team-wide) THEN it returns `[]`.
- AC-3: WHEN a new provider's registry entry sets `dispatchable: true` and a
  credential purpose THEN it becomes a failover candidate with no change to the
  claim route, the worker-report route, or the task UI.

**Code surface**: `packages/core/backend-policy.ts`
(`BACKEND_REGISTRY`, `DISPATCHABLE_BACKENDS`, `failoverCandidates`,
`pickFailoverBackend`), `packages/core/__tests__/backend-policy.test.ts`.

**Out of scope**: model selection within a provider (see
`packages/core/model-tier-registry.ts`).

---

## Per-provider pause accounting

**Capability statement**: A provider's budget/rate-limit wall MUST be recorded
against that provider only.

**Invariants**:
- Each wall appends a row to `backend_pauses` (`packages/core/db/schema.ts`)
  carrying `teamId`, `backend`, `reason` and `resetsAt`. The active pause for a
  backend is the newest row with `resetsAt > now()`.
- `accounts.budget_exhausted_at` / `accounts.budget_resets_at`, the
  `tenant_budgets` row, and the `oauth_budget_episodes` measurement describe the
  **Claude** session pool only. A worker report whose task ran on any other
  backend MUST NOT write them.
- `getActiveBackendPauses` folds the legacy Claude signals into the same map, so
  callers never re-derive "is Claude walled" themselves.
- A per-session dollar cap (the SDK's `maxBudgetUsd`) is NOT a wall. It is the
  one task's own ceiling, reported with `sessionBudgetCapped: true` or the
  legacy `error_max_budget_usd` / "Budget limit exceeded" text, and it MUST
  fail that task only: no `backend_pauses` row, no `budget_exhausted_at`, no
  `oauth_budget_episodes` insert, no failover. The provider-wall detector
  (`isBudgetExhaustionError`, `packages/core/budget-error-classifier.ts`) does
  not match dollar-cap texts; `isSessionBudgetCapError` does.

**Acceptance criteria**:
- AC-4: GIVEN a task with `backend='codex'` WHEN its worker reports a
  budget/rate-limit failure THEN a `backend_pauses` row with `backend='codex'`
  is written AND no `accounts.budget_exhausted_at` update and no
  `oauth_budget_episodes` insert occur.
- AC-5: GIVEN an account whose `budget_resets_at` is in the past WHEN
  `getActiveBackendPauses` runs THEN Claude is reported as un-walled.
- AC-6: GIVEN no `teamId` in scope WHEN `recordBackendPause` is called THEN it
  writes nothing and does not throw.

**Code surface**: `apps/web/src/lib/backend-failover.ts`
(`recordBackendPause`, `getActiveBackendPauses`, `isBackendConfigured`),
`packages/core/db/schema.ts` (`backendPauses`),
`apps/web/src/app/api/workers/[id]/route.ts` (budget branch),
`apps/web/src/lib/backend-failover.test.ts`.

**Out of scope**: mission cost budgets (`apps/web/src/lib/mission-budget.ts`).

---

## Bidirectional dispatch failover

**Capability statement**: A walled task MUST be re-queued on a usable
alternative provider when one exists, in either direction, and MUST NOT be
dispatched onto a provider that is itself walled.

**Invariants**:
- Both failover sites — the worker report (`PATCH /api/workers/[id]`) and
  dispatch (`POST /api/workers/claim`) — resolve their target through
  `pickFailoverBackend`, so they cannot disagree.
- A failed-over task carries `context.failedOverFrom` and
  `context.failoverReason` and MUST NOT receive a `start_at` floor.
- When no target is usable, the task's `start_at` MUST be the earliest of its own
  provider reset and any blocked candidate's reset (an explicit later floor
  already on the task still wins).
- Codex dispatch remains capped at one active worker per workspace; a busy or
  walled Codex pool MUST NOT receive failover traffic.

**Acceptance criteria**:
- AC-7: GIVEN a Codex task whose worker reports a rate-limit AND an open Claude
  pool WHEN the report is processed THEN the task is re-queued with
  `backend='claude'`, `context.failedOverFrom='codex'` and no `start_at`.
- AC-8: GIVEN a Codex task whose worker reports a rate-limit AND a Claude pool
  walled until T WHEN the report is processed THEN the task stays on Codex with
  `start_at = min(codex_reset, T)`.
- AC-9: GIVEN a pending Codex task AND an active Codex pause WHEN a runner claims
  THEN the task is dispatched on Claude if the Claude pool is open, otherwise it
  is deferred with `deferrals.budget_paused` incremented — never claimed on Codex.
- AC-10: GIVEN a Claude-walled task AND an active Codex pause WHEN a runner
  claims THEN the task is NOT flipped to Codex.

**Code surface**: see the end of this section.

### Only seat-bound work is walled by the Claude seat

**Invariants**:
- A Claude wall (the account's OAuth session, a tenant budget, or a `claude`
  row in `backend_pauses`) blocks, defers or fails over a Claude task ONLY
  when that task's run would spend the OAuth seat. The claim decides this
  with ONE predicate, `routeUsesOauthSeat(resolveClaudeModelRoute(…))`
  (`apps/web/src/app/api/workers/claim/claude-model-route.ts`), computed
  BEFORE the failover decision and reused by the Codex-wall escape and the
  OAuth pacing cap.
- Not seat-bound: a cloud executor (credentials are added at egress, which
  never carries a seat token); a runner whose own provider wins
  (`llmProviderOverride`); a team agent model endpoint that wins
  `resolveAgentModelRoute` for a runner declaring the endpoint feature; a live
  `anthropic_api_key` visible to the task (metered, and preferred over an
  OAuth token at the runner). Every doubt — a lookup error, no
  `ENCRYPTION_KEY`, no team — answers "seat-bound", the prior behaviour.
- A tenant task is walled by its tenant's budget, as before.

**Acceptance criteria**:
- AC-14: GIVEN an exhausted Claude seat AND a team agent endpoint that wins
  the route for a runner declaring the endpoint feature WHEN it claims THEN the
  task is claimed on Claude, not flipped and not deferred.
- AC-15: GIVEN an exhausted Claude seat AND a live team `anthropic_api_key`
  WHEN a runner claims THEN the task is claimed on Claude.
- AC-16: GIVEN a Claude-pool pause AND a cloud executor claim THEN a Claude
  task is claimed on Claude.

### A flip to Codex only where Codex auth will exist

**Invariants**:
- A flip to Codex (budget failover or the provider toggle) and the capability
  filter for a task stored as Codex use the same predicate,
  `codexAuthReachesRunner` in the claim route, mirroring the runner's own
  preflight ("No Codex credential configured"): the caller advertises
  `backend:codex`; it is not a cloud executor (the claim strips credentials and
  egress credentials no OpenAI traffic); and it has local Codex auth
  (`OPENAI_API_KEY` / `CODEX_HOME`) or a server credential that can be
  delivered (`ENCRYPTION_KEY` set and a `codex_credential`, `openai_api_key` or
  OpenAI-compatible endpoint the runner applies).

**Acceptance criteria**:
- AC-17: GIVEN an exhausted Claude seat AND a team Codex credential WHEN the
  caller does not advertise `backend:codex`, OR `ENCRYPTION_KEY` is unset, THEN
  the task is deferred, not flipped.
- AC-18: GIVEN a Claude task with Claude disabled team-wide WHEN a cloud
  executor claims THEN the task is deferred as `provider_unavailable`.
- AC-19: GIVEN an exhausted Claude seat, no server Codex credential, AND a
  runner advertising `backend:codex` with `OPENAI_API_KEY` WHEN it claims THEN
  the task is flipped to Codex.

### Pinned backends

**Invariants**:
- A backend named explicitly for the task — `backend` on create (API or
  `create_task`), or an operator switching it with `update_task` /
  `PATCH /api/tasks/[id]` — sets `context.backendPinned: true`
  (`BACKEND_PINNED_KEY`). A backend inherited from a mission, role or
  workspace default is not pinned; clearing the backend to null unpins.
- Failover never moves a pinned task, at either site or in either direction:
  it waits for its own provider's reset (`budget_paused`, with
  `detail.pinned`). The team provider mask still applies — a disabled provider
  runs nothing.

**Acceptance criteria**:
- AC-20: GIVEN a task created with `backend: 'claude'` AND an exhausted Claude
  seat AND a usable Codex WHEN a runner claims THEN it is deferred, not flipped.
- AC-21: GIVEN a task pinned to Codex AND a Codex wall WHEN its worker reports
  or a runner claims THEN it is not moved to Claude.

### Why a task ran on another backend

**Invariants**:
- A claim that runs a task on a backend other than the stored one stamps
  `context.backendRouting = { backend, from, reason, at }`
  (`BACKEND_ROUTING_KEY`; reasons `claude_seat_exhausted`, `claude_disabled`,
  `codex_disabled`, `codex_rate_limited`), and removes a stale stamp when it
  runs the stored backend.
- `describeBackendRouting` is the one reader: `explain` (`backendRouting`),
  `get_task` (the `Backend:` line) and the task summary render its sentence,
  e.g. "routed to Codex by budget failover (Claude seat exhausted)".

**Acceptance criteria**:
- AC-22: GIVEN a claim that flips a task to Codex on the Claude seat wall THEN
  the claim's context write carries `backendRouting.reason =
  'claude_seat_exhausted'` AND `explain` for the task reports it.

**Code surface**: `apps/web/src/app/api/workers/claim/route.ts`
(`teamPauses`, `tryFlipToCodex`, the Codex-wall escape),
`apps/web/src/app/api/workers/[id]/route.ts` (budget + auth-failure branches),
`apps/web/src/app/api/workers/[id]/route.test.ts`,
`apps/web/src/app/api/workers/claim/route.test.ts`,
`apps/web/src/app/api/workers/claim/claude-model-route.ts`
(`resolveClaudeModelRoute`, `routeUsesOauthSeat`),
`packages/core/backend-policy.ts` (`isBackendPinned`, `describeBackendRouting`),
`apps/web/src/lib/explain.ts` (`backendRouting`).

**Out of scope**: retry accounting for code failures (`exitCause` taxonomy);
the worker-report route still records a Claude wall from any Claude run, so a
wall hit on a non-seat route (an endpoint's own budget) is recorded against
the Claude pool.

---

## Manual provider switch

**Capability statement**: An operator switching a paused task's provider MUST
make it claimable immediately, not at the old provider's reset.

**Invariants**:
- `PATCH /api/tasks/[id]` and `POST /api/tasks/[id]/reassign` clear `start_at`
  and drop `context.budgetExhausted` / `context.budgetResetsAt` when `backend`
  changes on a task whose context carries `budgetExhausted`, recording
  `context.switchedBackendFrom`.
- The task detail pause banner offers a switch only for backends that
  `getBackendAvailability` reports as configured and un-walled; otherwise it
  states why the alternative cannot take the task.
- `update_task` accepts `backend` and rejects any value outside
  `DISPATCHABLE_BACKENDS` (or `null`, which clears the override).

**Acceptance criteria**:
- AC-11: GIVEN a pending task with `context.budgetExhausted` and a future
  `start_at` WHEN `PATCH /api/tasks/[id]` sets a different `backend` THEN
  `start_at` is `null`, `context.budgetExhausted` is absent, and
  `context.switchedBackendFrom` records the previous backend.
- AC-12: GIVEN the same task WHEN the PATCH sets the backend it already has THEN
  `start_at` and `context` are left untouched.
- AC-13: WHEN `update_task` is called with `backend: 'openrouter'` THEN it is
  rejected with an error naming the allowed values.

**Code surface**: `apps/web/src/app/api/tasks/[id]/route.ts` (PATCH backend
branch), `apps/web/src/app/api/tasks/[id]/reassign/route.ts`,
`apps/web/src/app/app/(protected)/tasks/[id]/SwitchBackendButton.tsx`,
`packages/core/mcp-tools.ts` (`update_task`).

**Out of scope**: workspace/role/mission default backend resolution.
