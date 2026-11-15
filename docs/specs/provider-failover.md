---
title: Provider Failover
status: active
owner: max
last_verified: 2026-11-14
summary: When a task's agent backend hits a budget or rate-limit wall or has its credential rejected, the system MUST re-queue that task on another enabled, un-walled backend, or park it until the earliest provider reset.
domain: runners
surfaces: [packages/core/backend-policy.ts, apps/web/src/lib/backend-failover.ts, apps/web/src/app/api/workers/claim/route.ts, apps/web/src/app/api/workers/[id]/route.ts]
related: [codex-backend-spec, credential-isolation, runner-liveness]
keywords: [backend_pauses, budget_exhausted_at, failoverpriority, rate limit, openrouter, runner seat wall, subscription wall fallback, maxCostPerDay]
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
  - id: resolve-runner-seat-wall-key
    type: symbol
    name: resolveRunnerSeatWallKey
    path: apps/web/src/lib/runner-seat-wall.ts
  - id: runner-seat-wall-test
    type: test_file
    path: apps/web/src/lib/runner-seat-wall.test.ts
  - id: claude-login-used
    type: symbol
    name: claudeLoginUsed
    path: apps/runner/src/terminal-attribution.ts
  - id: claude-login-used-test
    type: test_file
    path: apps/runner/__tests__/unit/claude-login-used.test.ts
  - id: held-for-wall
    type: symbol
    name: heldForWall
    path: packages/core/wall-fallback.ts
  - id: wall-fallback-test
    type: test_file
    path: packages/core/__tests__/wall-fallback.test.ts
  - id: resolve-team-wall-fallback
    type: symbol
    name: resolveTeamWallFallback
    path: apps/web/src/lib/provider-wall-fallback.ts
  - id: apply-wall-fallback-credentials
    type: symbol
    name: applyWallFallbackCredentials
    path: apps/web/src/app/api/workers/claim/wall-fallback-injection.ts
  - id: wall-fallback-cover
    type: symbol
    name: WallFallbackCover
    path: apps/runner/src/provider-limit.ts
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
  and the `tenant_budgets` row describe the **Claude** session pool only. A worker report whose task ran on any other
  backend MUST NOT write them.
- `getActiveBackendPauses` folds the legacy Claude signals into the same map, so
  callers never re-derive "is Claude walled" themselves.
- A per-session dollar cap (the SDK's `maxBudgetUsd`) is NOT a wall. It is the
  one task's own ceiling, reported with `sessionBudgetCapped: true` or the
  legacy `error_max_budget_usd` / "Budget limit exceeded" text, and it MUST
  fail that task only: no `backend_pauses` row, no `budget_exhausted_at`, no
  failover. The provider-wall detector
  (`isBudgetExhaustionError`, `packages/core/budget-error-classifier.ts`) does
  not match dollar-cap texts; `isSessionBudgetCapError` does.

**Acceptance criteria**:
- AC-4: GIVEN a task with `backend='codex'` WHEN its worker reports a
  budget/rate-limit failure THEN a `backend_pauses` row with `backend='codex'`
  is written AND no `accounts.budget_exhausted_at` update occurs.
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

### A runner's own login limit holds only that runner

**Invariants**:
- Several host runners can share one runner account, each running Claude on
  its own machine's login. A session, weekly or extra-usage limit that one of
  those logins hits is that runner's wall. The worker report MUST record it as
  a `backend_pauses` row carrying the runner's `seat_key`, and MUST NOT write
  `accounts.budget_exhausted_at` for it.
- The decision is `resolveRunnerSeatWallKey`
  (`apps/web/src/lib/runner-seat-wall.ts`). A team never shares a subscription
  wall (Living Spec "Parallelism limits" R-10): every Claude subscription
  limit (by its text) that is not tenant work and whose worker names its runner
  (`workers.runner`, the id every runner sends on claim) is runner-scoped,
  whatever the team stores and whatever login the run reports. A subscription
  wall whose worker names no runner writes no `backend_pauses` row at all,
  only its own account's `budget_exhausted_at`. Codex walls, API rate limits
  and tenant work stay shared.
- A reset quoted in an IANA zone ("resets 12pm (America/New_York)") is read in
  that zone (`extractResetTime`). Refusing it sent the pause to the full
  session-window fallback, hours past the real reset.
- The limit belongs to the login, and runners can share one (two processes
  reading one `~/.claude`). A runner on its machine's `claude login` reports
  `claudeLoginId` on the claim and the worker PATCH: a one-way hash it computes
  locally of the CLI profile's account id (`claudeLoginIdentity`,
  `apps/runner/src/host-seat.ts`), never the account id, a token or anything
  read from the credentials file. A runner-scoped wall is then keyed
  `login:<hash>` (`claudeLoginSeatKey`) and holds every runner on that login.
- With no login identity the key is a hash of the runner id (`runnerSeatKey`),
  never a credential. That covers `CLAUDE_CODE_OAUTH_TOKEN`, whose account is
  not known offline, `CLAUDE_CONFIG_DIR`, a missing profile and older runners.
- A claim reads shared pauses plus only the pauses keyed to its own login or
  its own runner (`callerSeatKeys`). A
  caller with no seat key (the client's default id, a cloud run) reads every
  pause, seat-scoped ones included. Interactive sessions stay exempt from both.
- A runner-scoped wall re-queues the task with no `start_at` floor, no
  `context.budgetExhausted` and no report-time failover: other runners take it
  now, and the walled runner's own claims defer it (`budget_paused`, wall kind
  `runner_seat`) or fail it over in memory, with `budgetResetsAt` set to that
  runner's own reset.

**Acceptance criteria**:
- AC-23: GIVEN two runners on one account AND a Claude pause keyed to runner
  A WHEN runner B claims a Claude task THEN it is claimed, AND WHEN runner A
  claims THEN it is deferred with wall kind `runner_seat` and `budgetResetsAt`
  equal to that pause's reset.
- AC-24: GIVEN a Claude pause with no seat key, OR the account's
  `budget_exhausted_at` set, WHEN either runner claims THEN the task is
  deferred.
- AC-25: GIVEN a weekly-limit report from a named runner WHEN it is processed
  THEN the pause carries the seat key, `accounts.budget_exhausted_at` is not
  written and the task is pending with no `start_at`. GIVEN the same report
  from a worker that names no runner THEN no `backend_pauses` row is written.
- AC-26: GIVEN the team stores a Claude credential AND a session-limit report
  from a named runner, whatever `claudeLoginUsed` says, WHEN it is processed
  THEN the pause carries that runner's seat key.
- AC-27: GIVEN "resets 12pm (America/New_York)" reported at 10:10 New York
  time THEN the pause lifts at 12:00 New York time, not five hours later.
- AC-28: GIVEN a Claude pause keyed to login identity L WHEN two runners that
  both report `claudeLoginId` L claim THEN both are deferred with wall kind
  `runner_seat`, AND WHEN a runner reporting another identity claims THEN it is
  claimed. GIVEN a run that reports no identity THEN its wall is keyed to its
  runner id, as before.

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

## A usage wall is a wait

**Capability statement**: When a runner's model login hits a usage wall
(Claude's 5-hour, session, weekly or extra-usage cap; Codex's usage limit), the
work MUST wait for the quoted reset and continue by itself: no attempt spent,
nobody paged, no review failed, and every surface says what it waits for and
when it resumes.

**Invariants**:
- A wall is recognised whatever status it arrives with: `failed`, `error`, or
  a `completed` session that delivered nothing (no PR, no structured output)
  but the wall message, in `error` or as its fallback summary
  (`usageWallFromReport`, `apps/web/src/lib/provider-wall.ts`). The worker PATCH
  route reads the latter two as the `failed` wall before anything else runs.
- A wall MUST NOT consume one of a task's attempts (`exitCause
  budget_limited`, excluded by `consumesRetryAttempt`), mark the task failed,
  advance `context.retryCount`, end a kernel attempt or review round, open a
  failure incident (`budget_limited` is in the sentinel's `NON_FAILURE_EXITS`),
  or send a priority push.
- The requeue keeps the work: `context.resumeBranch`, `lastCommitSha` and the
  runner's checkpoint `recoveryRef` are written on the requeue, so the next
  attempt continues on the same branch and is told it is resuming.
- The requeue records `context.usageWall` (`USAGE_WALL_CONTEXT_KEY`:
  backend, quoted reset, `login` or `pool` scope, runner), for a runner-scoped
  wall too. The task page renders it as "Waiting for the usage limit to reset
  at <time> (<login>)"; the fleet view's runner row (`FleetRunner.usageWall`,
  from seat-keyed `backend_pauses` rows by their reporting worker's runner,
  `loadRunnerUsageWalls`) and the runner lane (`usageWallSentences`) say which
  runner waits and until when. A deferral with wall kind `runner_seat` reads
  "waiting for the runner's usage limit".
- One wall episode is one notice: a quiet (priority -1) line on the first
  report of a wall; a later report on the same backend and seat key whose
  reset is within 30 minutes of a pause already in force sends nothing
  (`isRepeatWallEpisode`). Genuine task failures still alert as before.
- The runner's claim breaker holds that login's claims until the quoted reset
  for every wall the shared detector knows, the 5-hour and weekly caps
  included (`classifyClaimError`, `apps/runner/src/claim-breaker.ts`).
- A reviewer task on a wall is requeued like any other (and taken sooner by a
  runner whose login still has budget, for a runner-scoped wall). Its PR's
  `Buildd / Review approval` status is written `pending` with "Review waiting
  for model budget: resumes <time>" (`publishReviewBudgetWait`,
  `apps/web/src/lib/provider-wall-status.ts`), never "review unavailable" or a
  person's decision.
- The task's own per-session dollar cap is not a wall and still fails that
  task (see Per-provider pause accounting).

**Acceptance criteria**:
- AC-29: GIVEN a worker report of each wall (Claude 5-hour, session, weekly,
  extra usage; Codex usage) WHEN it is processed THEN the task is pending with
  `context.usageWall`, the worker's `exitCause` is `budget_limited`,
  `context.retryCount` is unchanged and no notice above priority -1 is sent.
- AC-30: GIVEN the same wall reported as `error`, or as `completed` with only
  the wall text as its fallback summary THEN the outcome is the same as AC-29.
- AC-31: GIVEN a pause already in force for the same backend, seat key and
  reset WHEN another task reports that wall THEN no notice is sent.
- AC-32: GIVEN a reviewer task whose session ends on a wall THEN it is
  requeued, no review round fails, no escalation is filed, and the PR's
  Review approval status is pending with the cause and the resume time.
- AC-33: GIVEN twelve tasks failing with `budget_limited` in the sentinel's
  window THEN no `repeated_failure` incident is opened.
- AC-34: GIVEN a session-cost-cap report THEN the task fails with
  `session_budget_capped` and no `context.usageWall` is written.

**Code surface**: `apps/web/src/lib/provider-wall.ts`,
`apps/web/src/lib/provider-wall-status.ts`,
`apps/web/src/app/api/workers/[id]/route.ts` (wall normalisation, budget
branch), `apps/web/src/lib/failure-pattern-sentinel.ts`,
`apps/runner/src/claim-breaker.ts`, `apps/web/src/lib/home-fleet.ts`
(`loadRunnerUsageWalls`), `apps/web/src/lib/fleet-view.ts`,
`apps/web/src/components/fleet/runner-lanes.tsx`,
`apps/web/src/app/app/(protected)/settings/runners/FleetOverview.tsx`,
`apps/web/src/app/app/(protected)/tasks/[id]/page.tsx`.

**Out of scope**: resuming the provider's own SDK session in place (a requeued
task is a fresh claim that continues from the branch and checkpoint); a worker
reaped or lost before it reports its wall still ends as a lost session.

---

## Subscription wall fallback

**Capability statement**: A team admin MUST be able to choose what a runner
on its own subscription login does when that login hits a usage wall: wait
for the reset (the default, "A usage wall is a wait"), or run the work on a
credential the team stored for it (its Anthropic API key, its OpenRouter key,
its LiteLLM gateway or its agent model endpoint), bounded by an optional daily
spend cap, after which the work waits again.

**Invariants**:
- The setting is `teams.subscription_wall_fallback`
  (`{ fallback, maxCostPerDayUsd }`, packages/core/wall-fallback.ts). NULL is
  `wait`. It is edited on Settings › Models, "When the subscription limit is
  reached" (`WallFallbackSection`, `GET`/`PUT /api/teams/[id]/wall-fallback`,
  `manage_team_settings`), which names the credential each choice would use
  (last four characters only) and refuses (400) to save a fallback the team
  has no usable credential for.
- Only an `authType: 'oauth'` runner falls back, never a cloud run, an
  interactive session, tenant work or a run on a person's own key or a Coding
  policy's native login. An `api` runner is unaffected: nothing is held from
  it and nothing is read for it.
- The fallback is only ever a credential in `secrets`. A subscription login is
  never stored, read or handed out. Naming the Anthropic key or the agent
  endpoint reserves it (`heldForWall`): a subscription runner's ordinary runs
  no longer receive it (`resolveClaudeModelRoute` `held`, and the claim strips
  it in `applyWallFallbackCredentials`), so they spend the login first.
  OpenRouter and LiteLLM reach an agent run only through the fallback (a
  synthesized reference resolved against the stored key or gateway), so
  naming them reserves nothing.
- At claim, a seat-bound Claude task on a walled login (`claudeBudgetBlocked`)
  takes the fallback before Codex failover when the team's setting resolves a
  credential for its workspace and the day's fallback spend is under the cap
  (`resolveTeamWallFallback`). An endpoint fallback needs a runner that applies
  endpoints (and their headers, when the route has them). Otherwise the task
  takes the existing paths; a deferral says why in `detail.wallFallback`
  (`cap_reached`, `no_credential`, `runner_unsupported`).
- A fallback run is labelled: `context.wallFallback` on the task (what served
  it, whose login hit the wall: `login` + runner or the account `pool`, the
  reset) and `workers.wall_fallback` plus `workers.model_route` on the worker.
  The task page renders `describeWallFallback` on that worker with its cost;
  `get_task` prints it. `context.usageWall` is dropped: the task no longer waits.
- The cap meters `workers.cost_usd` of the team's `wall_fallback` rows since
  UTC midnight (`wallFallbackSpentToday`). It is checked at claim and at the
  worker report; a run already started may finish past it. An unreadable sum
  reads as the cap reached.
- The worker report applies the setting to the requeue: a subscription
  runner's Claude wall on an unpinned task whose team would fall back now is
  requeued with no `start_at` floor and no `budgetExhausted` flag, so the next
  claim falls back. A wall on a run that was itself the fallback waits.
- A task created or updated with `subscriptionOnly: true`
  (`context.subscriptionPinned`, `SUBSCRIPTION_PINNED_KEY`; API, `create_task`,
  `update_task`) never falls back.
- Every claim answer to a subscription runner carries `wallFallback: { claude:
  true }` while its team's fallback would serve a walled run (cached one minute
  per team). The runner (`WallFallbackCover`) then keeps claiming Claude work
  while its own login is held, still reporting the hold in `limitWalls`; an
  answer without it ends the cover, and it lapses by itself after 15 minutes.

**Acceptance criteria**:
- AC-35: GIVEN a team whose fallback is its Anthropic key AND a subscription
  runner whose login is walled WHEN it claims an unpinned Claude task THEN the
  task is claimed on Claude with that key as the run's only model credential,
  `context.wallFallback` names the key and the wall, the worker row carries
  `wall_fallback`, and no Codex flip happens.
- AC-36: GIVEN the same team WHEN the task carries `subscriptionPinned` THEN it
  is deferred `budget_paused`, as with no fallback.
- AC-37: GIVEN the day's fallback spend at the cap WHEN the walled runner claims
  THEN the task is deferred and the claim answer carries no `wallFallback`.
- AC-38: GIVEN a fallback that reserves the team's key WHEN a subscription
  runner with an open login claims THEN its run gets no `serverApiKey` and its
  route is `oauth_seat`.
- AC-39: GIVEN an `api` runner THEN the setting is not read and nothing changes.
- AC-40: GIVEN a pool wall reported by a subscription runner's worker AND a team
  that would fall back THEN the task is pending with no `start_at`; GIVEN the
  walled run was itself a fallback THEN it waits for the reset.
- AC-41: GIVEN `PUT` with a fallback the team has no credential for THEN 400 and
  nothing is saved.
- AC-42: GIVEN a Claude-only runner whose login is held AND a claim answer with
  `wallFallback.claude` THEN it keeps claiming; GIVEN an answer without it THEN
  the hold pauses its claims as before.

**Code surface**: `packages/core/wall-fallback.ts`,
`apps/web/src/lib/provider-wall-fallback.ts`,
`apps/web/src/app/api/workers/claim/wall-fallback-injection.ts`,
`apps/web/src/app/api/workers/claim/claude-model-route.ts` (`held`),
`apps/web/src/app/api/workers/claim/route.ts`,
`apps/web/src/app/api/workers/[id]/route.ts` (budget branch),
`apps/web/src/app/api/teams/[id]/wall-fallback/route.ts`,
`apps/web/src/app/app/(protected)/settings/providers/WallFallbackSection.tsx`,
`apps/runner/src/provider-limit.ts` (`WallFallbackCover`),
`apps/runner/src/workers.ts`.

**Out of scope**: a fallback to Codex (that is the existing failover); a
per-workspace fallback setting (the team-wide setting resolves a workspace's
own stored credential first, then the team's); capping a single fallback run's
own spend mid-run; a fallback for a Codex login's wall.

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
