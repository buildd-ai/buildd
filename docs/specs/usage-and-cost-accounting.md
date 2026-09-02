---
title: Usage & Cost Accounting
status: active
owner: max
last_verified: 2026-08-30
summary: Worker usage MUST be recorded only from the worker's own report and attributed to one task, team-month and provider pool, and a budget-blocked claim MUST answer budget_exhausted with a reset time, not race_lost.
domain: billing
surfaces: [apps/web/src/app/api/workers/[id]/route.ts, apps/web/src/app/api/workers/claim/route.ts, packages/core/oauth-budget.ts, apps/web/src/lib/usage-stats.ts]
related: [auth-oauth-boundaries, provider-failover, mission-task-lifecycle, runner-liveness]
keywords: [cost_usd, input_tokens, monthly_cost_usd, oauth_budget_episodes, dailyBudgetPct, budget_exhausted, race_lost, estimateCostUsd, maxCostPerDay, costBudgetUsd]
verified_by: [apps/web/src/app/api/workers/claim/route.test.ts, apps/web/src/app/api/workers/[id]/route.test.ts, apps/web/src/lib/usage-stats.test.ts, packages/core/__tests__/oauth-budget.test.ts, packages/core/__tests__/budget-alerts.test.ts, apps/runner/__tests__/unit/usage-aggregate.test.ts, apps/runner/__tests__/unit/worker-manager-lifecycle.test.ts]
supersedes: []
---
# Usage & Cost Accounting

**Capability statement**: Every number buildd reports about consumption MUST be
traceable to a worker's own terminal report, attributed to exactly one task, one
team-month and one provider pool — and every limit that stops work MUST tell the
caller which limit stopped it and when it clears.

`auth-oauth-boundaries.md` fixes *which* limits apply to an auth type
(`api` ⇒ cost-limited, `oauth` ⇒ session-limited). This spec covers the other
side of that line: where the usage numbers come from, how they are attributed,
and what enforcement observably does.

---

## Usage capture

**Capability statement**: The server MUST NOT invent consumption numbers. A
worker's usage is whatever that worker reported, and absence MUST stay
distinguishable from zero.

**Invariants**:
- `workers.costUsd`, `inputTokens`, `outputTokens`, `turns` and `resultMeta` are
  written **only** from the `PATCH /api/workers/[id]` request body
  (`apps/web/src/app/api/workers/[id]/route.ts:383-388`). No server path derives
  usage from a transcript, a duration, or a model guess.
- There are exactly **two** writers of that body, and the second one exists
  because the first is unreachable for a whole cohort. When the agent completes
  the task itself through the MCP `complete_task`, the server terminalises the
  worker row first, so the runner's own terminal PATCH — the sole carrier of
  `resultMeta`, tokens, cost, model and git stats — arrives on a terminal row and
  is refused. `metricsOnly: true` is accepted there (`applyMetricsOnlyPatch`) and
  writes **measurement only**: it cannot write `status`, `error`, `summary`,
  `completedAt`, milestones, verification evidence or structured output, it does
  not bump `turns`, and it still refuses a worker the server itself expired
  (`isNonReactivatableError`). Values are **monotonic** — a late report may only
  raise a number another writer already recorded — and `resultMeta` is **merged**,
  never replaced. The write is a CAS on the status that was read, so a row moving
  underneath it returns a retryable conflict rather than a stale write.
- The metrics-only writer derives `costUsd` from token totals when the report
  carries `costUsd: 0`, using the same list-price estimate as the status
  transition. Seat/OAuth sessions always report `0`, so without this the tokens
  land and the cost column stays at zero permanently for that cohort.
- The metrics-only writer deliberately does **not** accumulate
  `teams.monthlyCostUsd` or fire budget-threshold notifications. Those are spend
  consequences, and back-filling spend that was never counted could cross a
  threshold and page on history rather than on activity. Consequence: this
  cohort's spend is visible per worker and in per-worker rollups, but does not
  consume team budget. Making it consume budget is a separate, deliberate change.
- Runner token totals resolve by precedence in `aggregateUsage`:
  `resultMeta.modelUsage` → `resultMeta.totalUsage` → the runner's per-turn
  tally. When every source is empty it returns `null` and the caller **omits**
  the fields rather than sending `0`
  (`apps/runner/src/usage-aggregate.ts:61-84`,
  `apps/runner/src/workers.ts:3112-3114` and `:3219-3220`).
- `workers.inputTokens` deliberately **includes** cache-read and cache-creation
  tokens: the context is re-sent every turn, so this column is a context-size
  proxy, not billable fresh input
  (`apps/runner/src/usage-aggregate.ts:40` and `:47-49`;
  `apps/runner/src/backends/claude-backend.ts:95-97`).
- `turns` is never left unknown: explicit `turns` → `resultMeta.numTurns` →
  `SQL workers.turns + 1`. A consumer MUST NOT read `turns` as an exact SDK turn
  count for MCP-driven workers
  (`apps/web/src/app/api/workers/[id]/route.ts:386-390`).
- `resultMeta.toolCounts` absent means **unknown**, not zero
  (`packages/core/db/schema.ts:565-573`).
- A per-session dollar cap (`workspaces.gitConfig.maxBudgetUsd`, else the
  runner's local config) is enforced *inside* the session, not by the API: the
  Claude backend hands it to the SDK and reacts to
  `result.subtype === 'error_max_budget_usd'`; the Codex backend enforces it
  itself and skips the check entirely on OAuth auth, where per-turn cost is not
  meaningful (`apps/runner/src/prompt-builder.ts:35-56`,
  `apps/runner/src/workers.ts:3015-3032`,
  `apps/runner/src/backends/codex-backend.ts:214-219`).

**Acceptance criteria**:
- AC-1: GIVEN a finished session whose SDK result carries no usable usage in any
  source WHEN the runner builds its terminal report THEN `aggregateUsage`
  returns `null` and the PATCH body omits `inputTokens`/`outputTokens` — the
  stored columns are not overwritten with `0`.
- AC-2: GIVEN an SDK result with top-level `usage` only (no `byModel` map) WHEN
  `extractResultUsage` runs THEN the returned `inputTokens` includes
  `cache_read_input_tokens` and `cache_creation_input_tokens`.
- AC-3: GIVEN a worker report with neither `turns` nor `resultMeta.numTurns`
  WHEN the PATCH is applied THEN `workers.turns` is incremented by exactly 1 and
  the numeric value passed to `recordTaskOutcome` is a number, never a SQL
  expression.

**Code surface**:
- Runner aggregation: `apps/runner/src/usage-aggregate.ts`
  (`extractResultUsage`, `aggregateUsage`)
- Runner result capture: `apps/runner/src/workers.ts:4221-4239`
  (`worker.resultMeta` build), `:3112-3114`, `:3210-3231`
- Report handler: `apps/web/src/app/api/workers/[id]/route.ts:346-392`
- Schema: `packages/core/db/schema.ts:1030-1034` (`workers.costUsd`,
  `inputTokens`, `outputTokens`, `turns`), `:517-523` (`ModelUsage`),
  `:546-574` (`ResultMeta`)

**Out of scope**: the runner's local SQLite session history
(`apps/runner/src/history-store.ts`) — an operator convenience, never an
accounting source.

---

## Attribution and rollups

**Capability statement**: Workers record usage; tasks are what people reason
about. The rollup MUST convert one into the other without letting an unrecorded
metric read as a measured zero.

**Invariants**:
- The accounting unit is the worker row; the reporting unit is the task.
  `aggregateByTask` sums every worker of a task, folds a retry attempt into its
  `parentTaskId`, and keeps a worker with `taskId = null` as its own bucket so
  its usage is never silently dropped (`apps/web/src/lib/usage-stats.ts:315-381`).
- The canonical task row's status decides a group's outcome; an attempt's
  `failed` MUST NOT mark a task that later succeeded. With only attempts in the
  window, a `completed` attempt wins regardless of row order
  (`apps/web/src/lib/usage-stats.ts:343-354`).
- A zero is never presented as a measurement. `measuredDistribution` drops
  non-positive values and returns `derivedUnavailable('no_scope', detail)` when
  nothing recorded the metric — seat/OAuth windows therefore read "no cost
  recorded", never `$0.00 per task` (`apps/web/src/lib/usage-stats.ts:199-206`,
  `:430-442`).
- Every tool number is published alongside `tools.coverage`
  (`histogram | derived | none`, plus `truncated`). A task's source is the
  **weakest** of its workers': one derived worker makes the task total a floor
  (`apps/web/src/lib/usage-stats.ts:236-264`, `:483-495`).
- Scan scope is explicit: only workers with `completedAt >= windowStart`, capped
  at `USAGE_ROW_LIMIT`. When the cap is hit the response sets
  `truncatedScan: true` and its totals are a floor, not a total
  (`apps/web/src/lib/usage-stats-query.ts:13-47`,
  `apps/web/src/app/api/stats/usage/route.ts:81-82`).
- Both auth types resolve to the same team scope via `resolveAccountTeamIds`, so
  an API key cannot read a team it is not on even with an explicit `?workspace=`
  (`apps/web/src/app/api/stats/usage/route.ts:54-67`).

**Acceptance criteria**:
- AC-4: GIVEN a task with a parent task and a retry attempt, each with its own
  worker, WHEN `GET /api/stats/usage` is called THEN one task entry appears and
  its tokens are the sum of both workers.
- AC-5: GIVEN a window in which every worker reported `costUsd = 0` WHEN the
  rollup is computed THEN `perTask.costUsd` is
  `{ kind: 'unavailable', reason: 'no_scope' }` with a `detail` naming seat-based
  auth, and no `$0.00` distribution is returned.
- AC-6: GIVEN a caller whose teams do not include workspace `W` WHEN
  `GET /api/stats/usage?workspace=W` is called THEN the server returns HTTP 404
  and no usage figures for `W`.
- AC-7: GIVEN a task whose only tool signal is a `mcpCalls` log at the
  100-entry cap WHEN the rollup is computed THEN the task counts as `derived`
  and `coverage.truncated` includes it.

**Code surface**:
- Pure rollup: `apps/web/src/lib/usage-stats.ts`
  (`aggregateByTask`, `computeUsageStats`, `measuredDistribution`,
  `toolCountsForWorker`, `parseWindowMs`)
- Query: `apps/web/src/lib/usage-stats-query.ts` (`fetchUsageRows`,
  `USAGE_ROW_LIMIT`)
- Route: `apps/web/src/app/api/stats/usage/route.ts`
- MCP readout: `packages/core/mcp-tools.ts:2840-2900`

**Out of scope**: the health page's presentation of these numbers, and the
`DerivedMetric` availability contract itself
(`docs/design/derived-metric-availability.md`).

---

## Spend accumulation and the monthly pool

**Capability statement**: Team monthly spend MUST accumulate exactly once per
worker, survive concurrent completions, and alert on thresholds — and it MUST
NOT silently become a claim gate.

**Invariants**:
- Monthly spend accrues on the **teams** row, not the account: a team's token
  accounts share one credit pool, so the charge is applied to
  `teams.monthlyCostUsd` / `monthlyCostMonth` / `budgetAlertsSent`
  (`apps/web/src/app/api/workers/[id]/route.ts:1098-1147`,
  `packages/core/db/schema.ts:46-49`).
- The charge is `costUsd` when the worker reported a positive cost, otherwise
  `estimateCostUsd(resultMeta.modelUsage)` at published list prices
  (`packages/core/model-prices.ts:28-72`,
  `apps/web/src/app/api/workers/[id]/route.ts:1087-1093`).
- Accumulation runs only on the first terminal transition (`wasTerminal` guard),
  so a duplicate terminal PATCH MUST NOT double-charge
  (`apps/web/src/app/api/workers/[id]/route.ts:1084`).
- The read-modify-write is a compare-and-set on `(monthlyCostUsd,
  monthlyCostMonth)` retried up to 5 times — neon-http has no interactive
  transactions. A lost attempt MUST NOT notify; an exhausted retry budget logs
  and drops the charge rather than writing a stale total
  (`apps/web/src/app/api/workers/[id]/route.ts:1132-1167`).
- Threshold alerts fire once per threshold per month; a new UTC month resets
  both the running total and the alert set
  (`packages/core/budget-alerts.ts:49-75`, `BUDGET_ALERT_THRESHOLDS`).
- The monthly budget is **advisory**. Crossing it fires an alert and updates the
  forecast; no claim gate reads `teams.monthlyCostUsd`. The only spend-derived
  hard stops are the per-mission `costBudgetUsd` gate and the per-provider walls
  below.
- `getBudgetForecast` never throws: each block is independently `catch`-guarded
  and returns partial data, and burn rate is derived from workers with
  `costUsd > 0` in a 24h trailing window with an explicit confidence level
  (`apps/web/src/lib/budget-forecast.ts:92-140`, `:196-260`).

**Acceptance criteria**:
- AC-8: GIVEN a worker reporting `costUsd: 0` with a populated
  `resultMeta.modelUsage` WHEN it completes THEN `teams.monthlyCostUsd`
  increases by the list-price estimate of that usage.
- AC-8b: GIVEN a worker the agent already completed through the MCP WHEN the
  runner's refused terminal PATCH is re-sent with `metricsOnly: true` THEN
  `resultMeta`, tokens and a derived `costUsd` are persisted on the worker row,
  `status`/`error`/`summary` are unchanged, and `teams.monthlyCostUsd` does
  **not** move (see the Usage-capture invariant on spend consequences).
- AC-9: GIVEN a team whose `budgetAlertsSent` already contains the threshold a
  new charge crosses WHEN the charge is applied THEN the total updates and no
  notification is sent.
- AC-10: GIVEN the CAS write loses to a concurrent completion WHEN the handler
  retries THEN the committed total is computed from the re-read state (both
  charges present) and exactly zero duplicate alerts fire.
- AC-11: GIVEN an account with no `teamId` WHEN `GET /api/health/budget` is
  called THEN the server returns HTTP 400, and GIVEN a `workspaceId` that is not
  a UUID THEN it returns HTTP 400 naming the expected form.

**Code surface**:
- Pure logic: `packages/core/budget-alerts.ts` (`applyBudgetUsage`,
  `budgetMonthKey`), `packages/core/model-prices.ts` (`priceForModel`,
  `estimateCostUsd`)
- Accumulator: `apps/web/src/app/api/workers/[id]/route.ts:1080-1170`
- Forecast: `apps/web/src/lib/budget-forecast.ts`, route
  `apps/web/src/app/api/health/budget/route.ts`
- Schema: `packages/core/db/schema.ts:41-49` (teams monthly columns)

**Out of scope**: invoicing, external billing providers, and per-seat pricing —
none exist in this repo.

---

## Enforcement at claim time

**Capability statement**: A limit MUST stop work in a way the caller can act on:
account-wide exhaustion rejects the request outright, while a per-task limit
defers that task and reports the reason.

**Invariants**:
- Account-wide gates run before any task is examined and return HTTP 429 with a
  `limit`/`current` pair (`apps/web/src/app/api/workers/claim/route.ts:127-162`):
  `maxConcurrentWorkers` for every auth type,
  `maxCostPerDay` vs `totalCost` for `authType = 'api'`,
  `maxConcurrentSessions` vs `activeSessions` for `authType = 'oauth'`.
  A gate MUST NOT be applied to the other auth type.
- `activeSessions` is a seat counter, not a usage number: it is incremented by
  exactly the number of workers claimed and decremented on every path that moves
  a live worker to a terminal state, so it cannot ratchet upward and
  permanently block claims (`route.ts:1942-1950`;
  `apps/web/src/app/api/workers/[id]/route.ts:2059-2068`;
  `apps/web/src/lib/stale-workers.ts:364-371`, `:460-466`, `:702-708`).
- Per-task limits are **soft**: they `continue` the dispatch loop, increment a
  named counter in `deferrals`, and leave the task `pending`
  (`route.ts:1041-1054`). No soft limit may mark a task `failed`.
- One pressure signal drives model routing for both auth types. For `api` it is
  `totalCost / maxCostPerDay`; for `oauth` it is the learned window pressure;
  the router sees `max(both)` as `dailyBudgetPct`
  (`route.ts:932-987`). The router downshifts tiers in bands and returns
  `paused` for priority-0 work at ≥ 95%, which becomes a `routing_paused`
  deferral (`packages/core/model-router.ts:116-148`, `route.ts:1580-1585`).
- OAuth pacing has exactly two exemptions, both deliberate: an explicit
  single-task claim (`taskId` present) always wins over pacing, and
  `OAUTH_BUDGET_PACING=off` makes it fully inert. Below `MIN_SAMPLES` episodes
  the window is not even measured (`route.ts:953-987`,
  `packages/core/oauth-budget.ts:57-67`, `:187-229`).
- A mission whose summed worker spend reaches `costBudgetUsd` transitions to
  `budget_exhausted` at the reporting worker's terminal write, never by killing a
  running worker. That status is a one-way door cleared only by a human raising
  the budget, and it gates every task in the mission — so a single force-started
  task passes only via `context.bypassMissionBudget`
  (`apps/web/src/app/api/workers/[id]/route.ts:126-145`, `:2076-2095`;
  `apps/web/src/lib/mission-budget.ts`;
  `apps/web/src/app/api/workers/claim/mission-budget-gate.ts`).

**Acceptance criteria**:
- AC-12: GIVEN an `api` account whose `totalCost` is at or above
  `maxCostPerDay` WHEN `POST /api/workers/claim` is called THEN the server
  returns HTTP 429 with `error: "Daily cost limit exceeded"` and no worker row
  is created.
- AC-13: GIVEN an `oauth` account at `maxConcurrentSessions` WHEN a claim is
  attempted THEN the server returns HTTP 429 with
  `error: "Max concurrent sessions limit reached"`.
- AC-14: GIVEN a learned OAuth capacity and a current window at 100% of it WHEN
  a priority-0 background claim runs THEN no worker is claimed, `deferrals`
  carries `routing_paused: 1`, and `diagnostics.budgetPressure` reports `pct`,
  `limiter`, `confidence` and `samples`.
- AC-15: GIVEN the same 100%-pressure account WHEN the claim names a specific
  `taskId` THEN the task is claimed anyway.
- AC-16: GIVEN fewer than `MIN_SAMPLES` recorded episodes WHEN a claim runs THEN
  `measureOauthWindow` is not called and `diagnostics.budgetPressure` is absent.
- AC-17: GIVEN a running worker on an `oauth` account WHEN it reports a terminal
  status THEN `accounts.activeSessions` is decremented, and GIVEN the same
  transition on an `api` account THEN it is not.
- AC-18: GIVEN a task whose mission is `budget_exhausted` WHEN a runner claims
  THEN the task is deferred with `deferrals.mission_budget` incremented, unless
  the task context carries `bypassMissionBudget`, in which case it is claimed.

**Code surface**:
- Gates: `apps/web/src/app/api/workers/claim/route.ts:118-181` (account-wide),
  `:1177-1420` (mission gates), `:1441-1500` (provider walls), `:1570-1586`
  (router pause)
- Pressure inputs: `apps/web/src/lib/oauth-budget-window.ts`
  (`resolveSeatIdPeers`, `loadOauthEpisodes`, `measureOauthWindow`)
- Router: `packages/core/model-router.ts` (`resolveEffectiveModel`)
- Schema: `packages/core/db/schema.ts:116-125` (`maxCostPerDay`, `totalCost`,
  `maxConcurrentSessions`, `activeSessions`), `:665` (`missions.costBudgetUsd`)

**Out of scope**: which concrete model/tier a claim resolves to
(`packages/core/model-router.ts`, `packages/core/model-tier-registry.ts`), and
the non-budget deferral reasons
(`connector_mismatch`, `path_overlap`, `subject_dead`, …).

---

## Budget walls, episodes and resumability

**Capability statement**: A provider wall MUST be recorded once, attributed to
the pool that actually ran dry, and reported back to the runner with the time it
clears — so the queue restarts itself.

**Invariants**:
- A wall is detected from the worker report only: `body.budgetExhausted === true`
  or `isBudgetExhaustionError(error)`. The reset time is
  `extractResetTime(error) ?? now + SESSION_WINDOW_MS`, and a reset stated in a
  timezone the parser will not guess at yields `null` (falling back to a full
  window) rather than a misread clock time
  (`apps/web/src/app/api/workers/[id]/route.ts:640-699`,
  `apps/web/src/lib/budget-errors.ts`).
- `accounts.budgetExhaustedAt`/`budgetResetsAt`, the `tenant_budgets` row and the
  `oauth_budget_episodes` measurement describe the **Claude** session pool only.
  Any other backend's wall is recorded in `backend_pauses` and MUST NOT touch
  them (see `provider-failover`;
  `apps/web/src/app/api/workers/[id]/route.ts:714-731`).
- Exactly one episode per wall: only the request that wins the
  `isNull(budgetExhaustedAt)` CAS inserts into `oauth_budget_episodes`; siblings
  sharing a `seatId` receive the flag but no row, and losing the race MUST NOT
  stop the task from being re-queued
  (`apps/web/src/app/api/workers/[id]/route.ts:749-826`).
- An episode measures the whole `seatId` group's window — start inferred by
  sessionizing worker start times (not a rolling `now − 5h`), usage weighted into
  sonnet-equivalents via `MODEL_WEIGHTS`. A weighted value of `0` means "not
  weighted" and is dropped by the learner rather than treated as a real ceiling
  (`packages/core/oauth-budget.ts:81-99`, `:187-229`, `:293-316`).
- Capacity is the conservative quantile (default p25) of the most recent
  episodes and is only learned per metric once at least `MIN_SAMPLES` episodes
  reported a positive value for it; pressure is the **binding** (highest) ratio,
  clamped to `[0,1]` (`packages/core/oauth-budget.ts:187-273`).
- Exhaustion auto-clears: at the top of the claim route, an account whose
  `budgetResetsAt` is in the past has the flag cleared for itself and every
  `seatId` sibling — no operator action
  (`apps/web/src/app/api/workers/claim/route.ts:165-181`).
- A budget wall re-queues its task as `pending` with
  `context.budgetExhausted` + `context.budgetResetsAt`, sets `exitCause =
  'budget_limited'` (excluded from retry caps), and fires a distinct
  "paused until" alert instead of a failure notification. A `cancelled` task MUST
  NOT be revived by a budget report
  (`apps/web/src/app/api/workers/[id]/route.ts:640-660`, `:860-925`).
- **The load-bearing distinction.** When a claim returns no workers:
  `reason: 'budget_exhausted'` plus a top-level `budgetResetsAt` when
  `accountBudgetExhausted || deferrals.budget_paused > 0`;
  `reason: 'all_candidates_deferred'` when `lockAttempts === 0` and every
  candidate was gated; `reason: 'race_lost'` **only** when at least one task
  reached the atomic claim UPDATE. `budgetResetsAt` is the earliest of the
  account reset and any provider pause this batch saw, because
  `accounts.budgetResetsAt` tracks Claude alone
  (`apps/web/src/app/api/workers/claim/route.ts:1767-1830`).
- The runner turns that reset time into a one-shot resume poll at
  `budgetResetsAt + 5s`, guarded to ≤ 6h and ignoring unparseable values, so held
  work resumes without restarting the runner — the budget-reset re-queue emits
  `task:updated`, which no realtime subscriber acts on
  (`apps/runner/src/workers.ts:898-914`, `:1027-1062`).

**Acceptance criteria**:
- AC-19: GIVEN every pending task is Claude-budget-blocked and no failover
  backend is usable WHEN a runner claims THEN the response contains
  `diagnostics.reason = 'budget_exhausted'` and a non-null `budgetResetsAt` —
  never a bare `race_lost`.
- AC-20: GIVEN both the Claude and Codex pools are walled with different reset
  times WHEN a runner claims THEN `budgetResetsAt` is the earlier of the two.
- AC-21: GIVEN a concurrent report already flipped `budgetExhaustedAt` WHEN a
  second budget report arrives THEN no `oauth_budget_episodes` row is inserted
  and the task is still re-queued to `pending`.
- AC-22: GIVEN an account whose `budgetResetsAt` is in the past WHEN a claim runs
  THEN `budgetExhaustedAt` and `budgetResetsAt` are set to `null` for the account
  and its `seatId` siblings and claiming proceeds.
- AC-23: GIVEN a `cancelled` task whose worker reports a budget wall WHEN the
  report is processed THEN the task is not returned to `pending`.
- AC-24: GIVEN a claim response carrying `budgetResetsAt` one minute out WHEN the
  runner handles it THEN a resume poll is scheduled slightly after that instant,
  and GIVEN a reset more than 6h out THEN no timer is scheduled (the hourly
  fallback covers it).
- AC-25: GIVEN a window whose usage exceeds the learned capacity WHEN
  `oauthBudgetPressure` is computed THEN `pct` is exactly `1` (clamped) and
  `limiter` names the binding metric.

**Code surface**:
- Detection/parsing: `apps/web/src/lib/budget-errors.ts`
  (`isBudgetExhaustionError`, `extractResetTime`, `SESSION_WINDOW_MS`)
- Wall handling: `apps/web/src/app/api/workers/[id]/route.ts:640-925`
- Learner: `packages/core/oauth-budget.ts` (`learnOauthCapacity`,
  `oauthBudgetPressure`, `inferWindowStart`, `summarizeWindowUsage`,
  `readPacingConfig`)
- Measurement: `apps/web/src/lib/oauth-budget-window.ts`
- Claim diagnostics: `apps/web/src/app/api/workers/claim/route.ts:1767-1830`
- Runner resume: `apps/runner/src/workers.ts:1027-1062`
  (`scheduleBudgetResume`)
- Readout: `apps/web/src/app/api/accounts/me/route.ts:21-73` (`budgetPacing`)
- Schema: `packages/core/db/schema.ts:2035-2061` (`oauthBudgetEpisodes`),
  `:1980-1990` (`tenantBudgets`), `:128-129` (account flags)

**Out of scope**: choosing the failover target and the `backend_pauses`
lifecycle — that is `provider-failover`.

---

## Out of scope

- Auth-type resolution and which limit set applies (`auth-oauth-boundaries`).
- Failover target selection, `backend_pauses` reads, manual provider switch
  (`provider-failover`).
- Model/tier resolution and the tier registry (`packages/core/model-router.ts`,
  `packages/core/model-tier-registry.ts`) — this spec only defines the budget
  pressure fed into it.
- Task retry accounting and the `exitCause` taxonomy beyond `budget_limited`.
- Runner-local session history and its cost UI
  (`apps/runner/src/history-store.ts`, `apps/runner/ui/`).
- Invoicing, payment, external billing providers — none exist.

---

## Verification gaps

Unguarded claims and drift found while writing this spec. Each is a real hole,
not a stylistic note.

1. **`accounts.total_cost` has no writer.** Grepping `apps`, `packages` and
   `scripts` finds only reads (`claim/route.ts:141-148` and `:933-935`) plus the
   schema/migration definition. The `api`-key daily-cost gate and the `api`
   branch of `dailyBudgetPct` therefore read a column that never moves: the gate
   is structurally inert in production even though the tests pass, because they
   set `totalCost` directly on the mocked account. `auth-oauth-boundaries.md`
   AC-2 asserts this gate as live behaviour. Nothing resets it daily either,
   despite the `maxCostPerDay` name.
2. **`accounts.monthly_cost_usd` / `monthly_budget_usd` / `budget_alerts_sent`
   have no writer.** Only the `teams` copies are read or written
   (`packages/core/db/schema.ts:132-137` vs `:41-49`). The account-level columns
   are dead duplicates that a future reader can easily mistake for truth.
3. **The runner never reports `costUsd`.** `apps/runner/src/buildd.ts:150-230`
   defines the worker-update payload and has no `costUsd` field, so
   `workers.cost_usd` keeps its `'0'` default for runner-executed workers. Three
   consumers are built on `SUM(workers.cost_usd)` or `cost_usd > 0`:
   `getMissionSpendUsd` (`apps/web/src/lib/mission-budget.ts:10-17`), the
   burn-rate window (`budget-forecast.ts:250-259`) and the team page total
   (`team/[slug]/page.tsx:114`). No test exercises the mission-budget gate from a
   real runner report, so "mission budget exhausts" is asserted only against
   directly-injected costs.
4. **The `$0 → estimate` fallback cannot fire on the case it documents.**
   `effectiveCost` falls back to `estimateCostUsd(resultMeta.modelUsage)` and the
   comment names the OAuth case, but the runner sets
   `modelUsage: result.usage?.byModel ?? {}`
   (`apps/runner/src/workers.ts:4222-4230`) and every other comment in the tree
   states that seat/OAuth auth never populates `byModel`
   (`usage-aggregate.ts:6-9`, `usage-stats.ts:270-273`). On seat auth the
   estimate is therefore `0`. The passing test supplies a populated `modelUsage`,
   so it proves the arithmetic, not the OAuth path. `resultMeta.totalUsage`
   carries the tokens but has no model attribution, and `estimateCostUsd` reads
   only `modelUsage`.
5. **No test asserts the monthly budget is advisory.** Nothing pins that
   crossing 100% of `teams.monthlyBudgetUsd` still allows claims. If a gate is
   added, no test fails; if one is expected, none exists.
6. **The double-charge guard is narrower than the terminal set, but nothing
   reaches it.** `wasTerminal` checks `'completed' | 'failed'`
   (`apps/web/src/app/api/workers/[id]/route.ts:1084`) while the terminal set
   includes `'error'`. This does NOT permit a double charge: a repeated terminal
   PATCH is rejected with 409 by the reactivation guard (`:254`, `:278-291`)
   roughly 800 lines before accumulation, and the concurrent variant is caught by
   the CAS status reservation (`:626-635`). `wasTerminal` is therefore dead
   defence rather than a hole — recorded here because it reads like a gap, and a
   future change that relaxes either earlier guard would make it one. Still
   unguarded: no test sends a repeated terminal PATCH and asserts a single
   charge.
7. **FIXED** — `budgetExhaustedAt` with a null `budgetResetsAt` is unrecoverable.**
   Auto-clear requires a non-null reset in the past
   (`claim/route.ts:168-181`) while `accountBudgetExhausted`
   (`:219-222`) treats a null reset as exhausted indefinitely. Today's only
   writer always supplies a reset, so the state is unreachable — but nothing
   guards it, and the claim response would also carry `budgetResetsAt: null`,
   giving the runner nothing to schedule against.

   Closed here: `effectiveBudgetResetAt()` derives a missing reset as `exhaustedAt + SESSION_WINDOW_MS` — the same fallback the writer uses — so a null reset heals after the window instead of reading as permanent. A writer-side test greps every `budgetExhaustedAt:` write and prints `{writes, offenders}`, since the pairing cannot be a schema `notNull` (the column is legitimately NULL for healthy accounts).

8. **FIXED** — A truncated usage scan is an unspecified sample.** `fetchUsageRows` applies
   `USAGE_ROW_LIMIT` with no `ORDER BY`
   (`apps/web/src/lib/usage-stats-query.ts:27-47`), so which rows survive
   truncation is arbitrary. `truncatedScan` warns that totals are a floor but not
   that the sample is unordered, and no test covers the truncated path.

   Closed here: the scan is ordered `(completedAt DESC, id DESC)`, so a truncated scan is the COMPLETE population of a narrower window rather than an arbitrary sample. The response carries `scan: {rows, limit, truncated, completeSince}` and the MCP formatter states that medians and p90 cover only since `completeSince`. Follow-up not taken: there is no index on `workers.completed_at`, so this sorts.

9. **FIXED** — Cache tokens are counted in two places that are never reconciled.**
   `workers.inputTokens` includes cache-read and cache-creation tokens by design,
   while `MetricBlock` also publishes `cacheReadTokens`/`cacheCreationTokens`
   derived independently from `resultMeta.modelUsage`
   (`usage-stats.ts:271-284`, `:395-404`). Any consumer adding `inputTokens +
   cacheReadTokens` double-counts. No test states the intended relationship
   between the two.

   Addressed here: the two definitions now agree. `byModel[].inputTokens` is cache-inclusive, matching the containment `totals` already used, and the cache-exclusive figure is kept under the self-describing `uncachedInputTokens`. Pinned by a test asserting `sum(byModel[].inputTokens) === totals.inputTokens`. `share` still uses the uncached basis, documented in place.

10. **Episode token split is lossy on purpose, unflagged in reads.**
    `oauth_budget_episodes.inputTokens` is written with the *combined* window
    token total and `outputTokens` with `0`
    (`apps/web/src/app/api/workers/[id]/route.ts:812-816`). The learner sums the
    two, so it is correct — but any other reader of those columns will misread
    the split, and nothing in the schema comment or a test prevents that.
