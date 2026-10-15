---
title: Usage & Cost Accounting
status: active
owner: max
last_verified: 2026-10-15
summary: Worker usage MUST be recorded only from the worker's own report and attributed to one task, team-month and provider pool, and a budget-blocked claim MUST answer budget_exhausted with a reset time, not race_lost.
domain: billing
surfaces: [apps/web/src/app/api/workers/[id]/route.ts, apps/web/src/app/api/workers/claim/route.ts, packages/core/oauth-budget.ts, apps/web/src/lib/usage-stats.ts]
related: [auth-oauth-boundaries, provider-failover, mission-task-lifecycle, runner-liveness]
keywords: [cost_usd, input_tokens, monthly_cost_usd, oauth_budget_episodes, dailyBudgetPct, budget_exhausted, race_lost, estimateCostUsd, maxCostPerDay, costBudgetUsd]
verified_by: [apps/web/src/app/api/workers/claim/route.test.ts, apps/web/src/app/api/workers/[id]/route.test.ts, apps/web/src/lib/usage-stats.test.ts, packages/core/__tests__/oauth-budget.test.ts, packages/core/__tests__/budget-alerts.test.ts, apps/runner/__tests__/unit/usage-aggregate.test.ts, apps/runner/__tests__/unit/worker-manager-lifecycle.test.ts]
supersedes: []
# Structural conformance only; passing does not certify every prose invariant.
assertions:
  - id: "usage-statistics"
    type: "symbol"
    name: "computeUsageStats"
    path: "apps/web/src/lib/usage-stats.ts"
  - id: "usage-aggregation"
    type: "symbol"
    name: "aggregateUsage"
    path: "apps/runner/src/usage-aggregate.ts"
  - id: "usage-accounting-tests"
    type: "test_file"
    path: "apps/web/src/lib/usage-stats.test.ts"
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
  (`apps/web/src/app/api/workers/[id]/route.ts`). No server path derives
  usage from a transcript, a duration, or a model guess. An interactive MCP
  session self-reports through `update_progress` / `complete_task`
  (`inputTokens`, `outputTokens`, `costUsd`, `costBasis`), which reach the same
  PATCH.
- The runner sends `costUsd` on its terminal report whenever the backend
  reported real spend, with `costBasis`, `actualModel` and its token tally
  (`buildTerminalAttributionPayload`, `apps/runner/src/terminal-attribution.ts`).
  A reported `0` is left out, so the server's token-derived estimate is not
  suppressed.
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
  (`apps/runner/src/usage-aggregate.ts`,
  `apps/runner/src/workers.ts`).
- `workers.inputTokens` deliberately **includes** cache-read and cache-creation
  tokens: the context is re-sent every turn, so this column is a context-size
  proxy, not billable fresh input
  (`apps/runner/src/usage-aggregate.ts`;
  `apps/runner/src/backends/claude-backend.ts`).
- `turns` is never left unknown: explicit `turns` → `resultMeta.numTurns` →
  `SQL workers.turns + 1`. A consumer MUST NOT read `turns` as an exact SDK turn
  count for MCP-driven workers
  (`apps/web/src/app/api/workers/[id]/route.ts`).
- `resultMeta.toolCounts` absent means **unknown**, not zero
  (`packages/core/db/schema.ts`).
- A per-session dollar cap (`workspaces.gitConfig.maxBudgetUsd`, else the
  runner's local config) is enforced *inside* the session, not by the API: the
  Claude backend hands it to the SDK and reacts to
  `result.subtype === 'error_max_budget_usd'`; the Codex backend enforces it
  itself and skips the check entirely on OAuth auth, where per-turn cost is not
  meaningful (`apps/runner/src/prompt-builder.ts`,
  `apps/runner/src/workers.ts`,
  `apps/runner/src/backends/codex-backend.ts`).

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
- Runner result capture: `apps/runner/src/workers.ts`
  (`worker.resultMeta` build)
- Report handler: `apps/web/src/app/api/workers/[id]/route.ts`
- Schema: `packages/core/db/schema.ts` (`workers.costUsd`,
  `inputTokens`, `outputTokens`, `turns`) (`ModelUsage`) (`ResultMeta`)

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
  its usage is never silently dropped (`apps/web/src/lib/usage-stats.ts`).
- The canonical task row's status decides a group's outcome; an attempt's
  `failed` MUST NOT mark a task that later succeeded. With only attempts in the
  window, a `completed` attempt wins regardless of row order
  (`apps/web/src/lib/usage-stats.ts`).
- A zero is never presented as a measurement. `measuredDistribution` drops
  non-positive values and returns `derivedUnavailable('no_scope', detail)` when
  nothing recorded the metric — a window with no recorded cost therefore reads
  "no cost recorded", never `$0.00 per task` (`apps/web/src/lib/usage-stats.ts`).
- Every tool number is published alongside `tools.coverage`
  (`histogram | derived | none`, plus `truncated`). A task's source is the
  **weakest** of its workers': one derived worker makes the task total a floor
  (`apps/web/src/lib/usage-stats.ts`).
- Scan scope is explicit: only workers with `completedAt >= windowStart`, capped
  at `USAGE_ROW_LIMIT`. When the cap is hit the response sets
  `truncatedScan: true` and its totals are a floor, not a total
  (`apps/web/src/lib/usage-stats-query.ts`,
  `apps/web/src/app/api/stats/usage/route.ts`).
- Both auth types resolve to the same team scope via `resolveAccountTeamIds`, so
  an API key cannot read a team it is not on even with an explicit `?workspace=`
  (`apps/web/src/app/api/stats/usage/route.ts`).

**Acceptance criteria**:
- AC-4: GIVEN a task with a parent task and a retry attempt, each with its own
  worker, WHEN `GET /api/stats/usage` is called THEN one task entry appears and
  its tokens are the sum of both workers.
- AC-5: GIVEN a window in which every worker reported `costUsd = 0` WHEN the
  rollup is computed THEN `perTask.costUsd` is
  `{ kind: 'unavailable', reason: 'no_scope' }` with a `detail` stating that
  no task recorded a cost, and no `$0.00` distribution is returned.
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
- MCP readout: `packages/core/mcp-tools.ts`

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
  (`apps/web/src/app/api/workers/[id]/route.ts`,
  `packages/core/db/schema.ts`).
- Codex and tenant-credential usage do not draw on the pool: a session whose
  task ran on Codex, or whose task carries a tenant credential, MUST NOT move
  `teams.monthlyCostUsd` or fire its alerts (`countsTowardAgentSdkCreditPool`,
  `packages/core/budget-alerts.ts`). The worker row's `costUsd` is still
  written for every session. `accounts.authType` records CLI-login accounts as
  `api` even on a seat, so it is not used; the worker's own `costBasis` is
  (`real-and-virtual-cost.md`): a `real` row does not draw on the pool, every
  other basis does.
- The charge is `costUsd` when the worker reported a positive cost, otherwise
  `estimateCostUsd(resultMeta.modelUsage)` at published list prices
  (`packages/core/model-prices.ts`,
  `apps/web/src/app/api/workers/[id]/route.ts`).
- Accumulation runs only on the first terminal transition (`wasTerminal` guard),
  so a duplicate terminal PATCH MUST NOT double-charge
  (`apps/web/src/app/api/workers/[id]/route.ts`).
- The read-modify-write is a compare-and-set on `(monthlyCostUsd,
  monthlyCostMonth)` retried up to 5 times — neon-http has no interactive
  transactions. A lost attempt MUST NOT notify; an exhausted retry budget logs
  and drops the charge rather than writing a stale total
  (`apps/web/src/app/api/workers/[id]/route.ts`).
- Threshold alerts fire once per threshold per month; a new UTC month resets
  both the running total and the alert set
  (`packages/core/budget-alerts.ts`, `BUDGET_ALERT_THRESHOLDS`).
- The monthly budget is **advisory**. Crossing it fires an alert and updates the
  forecast; no claim gate reads `teams.monthlyCostUsd`. The only spend-derived
  hard stops are the per-mission `costBudgetUsd` gate and the per-provider walls
  below.
- `getBudgetForecast` never throws: each block is independently `catch`-guarded
  and returns partial data, and burn rate is derived from workers with
  `costUsd > 0` in a 24h trailing window with an explicit confidence level
  (`apps/web/src/lib/budget-forecast.ts`).

**Acceptance criteria**:
- AC-8: GIVEN a worker reporting `costUsd: 0` with a populated
  `resultMeta.modelUsage` WHEN it completes THEN `teams.monthlyCostUsd`
  increases by the list-price estimate of that usage.
- AC-26: GIVEN a worker the agent already completed through the MCP WHEN the
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
- Accumulator: `apps/web/src/app/api/workers/[id]/route.ts`
- Forecast: `apps/web/src/lib/budget-forecast.ts`, route
  `apps/web/src/app/api/health/budget/route.ts`
- Schema: `packages/core/db/schema.ts` (teams monthly columns)

**Out of scope**: invoicing, external billing providers, and per-seat pricing —
none exist in this repo.

---

## Enforcement at claim time

**Capability statement**: A limit MUST stop work in a way the caller can act on:
account-wide exhaustion rejects the request outright, while a per-task limit
defers that task and reports the reason.

**Invariants**:
- Account-wide gates run before any task is examined and return HTTP 429 with a
  `limit`/`current` pair (`apps/web/src/app/api/workers/claim/route.ts`):
  `maxConcurrentWorkers` for every auth type,
  `maxCostPerDay` vs `totalCost` for `authType = 'api'`,
  `maxConcurrentSessions` vs `activeSessions` for `authType = 'oauth'`.
  A gate MUST NOT be applied to the other auth type. Nothing writes or resets
  `accounts.totalCost`, so the daily cost gate never trips today (see
  Verification gaps).
- `maxConcurrentWorkers` is the number of slots the account's runners are
  assigned, not a cap on a person. A verified interactive session (the
  `verifyInteractiveSession` marker) is never refused by it or by
  `maxConcurrentSessions`, and its workers (`runner = 'mcp'`) are left out of
  the count a runner claim is checked against, in the pre-check and in the
  atomic insert. `mcp-unverified` is an ordinary runner. `maxCostPerDay` still
  applies to every caller.
- `activeSessions` is a seat counter, not a usage number: it is incremented by
  exactly the number of workers claimed and decremented on every path that moves
  a live worker to a terminal state, so it cannot ratchet upward and
  permanently block claims (`route.ts`;
  `apps/web/src/app/api/workers/[id]/route.ts`;
  `apps/web/src/lib/stale-workers.ts`).
- Per-task limits are **soft**: they `continue` the dispatch loop, increment a
  named counter in `deferrals`, and leave the task `pending`
  (`route.ts`). No soft limit may mark a task `failed`.
- One pressure signal drives model routing for both auth types. For `api` it is
  `totalCost / maxCostPerDay`; for `oauth` it is the learned window pressure;
  the router sees `max(both)` as `dailyBudgetPct`
  (`route.ts`). The router downshifts tiers in bands and returns
  `paused` for priority-0 work at ≥ 95%, which becomes a `routing_paused`
  deferral (`packages/core/model-router.ts`, `route.ts`).
- OAuth pacing has exactly three exemptions, all deliberate: an explicit
  single-task claim (`taskId` present) always wins over pacing, a verified
  interactive session runs on the person's own credentials, and
  `OAUTH_BUDGET_PACING=off` makes it fully inert. Below `MIN_SAMPLES` episodes
  the window is not even measured (`route.ts`,
  `packages/core/oauth-budget.ts`).
- A mission whose summed worker spend reaches `costBudgetUsd` transitions to
  `budget_exhausted` at the reporting worker's terminal write, never by killing a
  running worker. That status is a one-way door cleared only by a human raising
  the budget, and it gates every task in the mission — so a single force-started
  task passes only via `context.bypassMissionBudget`
  (`apps/web/src/app/api/workers/[id]/route.ts`;
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
- Gates: `apps/web/src/app/api/workers/claim/route.ts` (account-wide) (mission gates) (provider walls)
  (router pause)
- Pressure inputs: `apps/web/src/lib/oauth-budget-window.ts`
  (`resolveSeatIdPeers`, `loadOauthEpisodes`, `measureOauthWindow`)
- Router: `packages/core/model-router.ts` (`resolveEffectiveModel`)
- Schema: `packages/core/db/schema.ts` (`maxCostPerDay`, `totalCost`,
  `maxConcurrentSessions`, `activeSessions`) (`missions.costBudgetUsd`)

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
  (`apps/web/src/app/api/workers/[id]/route.ts`,
  `apps/web/src/lib/budget-errors.ts`).
- `accounts.budgetExhaustedAt`/`budgetResetsAt`, the `tenant_budgets` row and the
  `oauth_budget_episodes` measurement describe the **Claude** session pool only.
  Any other backend's wall is recorded in `backend_pauses` and MUST NOT touch
  them (see `provider-failover`;
  `apps/web/src/app/api/workers/[id]/route.ts`).
- Exactly one episode per wall: only the request that wins the
  `isNull(budgetExhaustedAt)` CAS inserts into `oauth_budget_episodes`; siblings
  sharing a `seatId` receive the flag but no row, and losing the race MUST NOT
  stop the task from being re-queued
  (`apps/web/src/app/api/workers/[id]/route.ts`).
- An episode measures the whole `seatId` group's window — start inferred by
  sessionizing worker start times (not a rolling `now − 5h`), usage weighted into
  sonnet-equivalents via `MODEL_WEIGHTS`. A weighted value of `0` means "not
  weighted" and is dropped by the learner rather than treated as a real ceiling
  (`packages/core/oauth-budget.ts`).
- Capacity is the conservative quantile (default p25) of the most recent
  episodes and is only learned per metric once at least `MIN_SAMPLES` episodes
  reported a positive value for it; pressure is the **binding** (highest) ratio,
  clamped to `[0,1]` (`packages/core/oauth-budget.ts`).
- Exhaustion auto-clears: at the top of the claim route, an account whose
  `budgetResetsAt` is in the past has the flag cleared for itself and every
  `seatId` sibling — no operator action
  (`apps/web/src/app/api/workers/claim/route.ts`).
- A budget wall re-queues its task as `pending` with
  `context.budgetExhausted` + `context.budgetResetsAt`, sets `exitCause =
  'budget_limited'` (excluded from retry caps), and fires a distinct
  "paused until" alert instead of a failure notification. A `cancelled` task MUST
  NOT be revived by a budget report
  (`apps/web/src/app/api/workers/[id]/route.ts`).
- **The load-bearing distinction.** When a claim returns no workers:
  `reason: 'budget_exhausted'` plus a top-level `budgetResetsAt` when
  `accountBudgetExhausted || deferrals.budget_paused > 0`;
  `reason: 'all_candidates_deferred'` when `lockAttempts === 0` and every
  candidate was gated; `reason: 'race_lost'` **only** when at least one task
  reached the atomic claim UPDATE. `budgetResetsAt` is the earliest of the
  account reset and any provider pause this batch saw, because
  `accounts.budgetResetsAt` tracks Claude alone
  (`apps/web/src/app/api/workers/claim/route.ts`).
- A claim pause sized from a provider's own reset text MUST honour the stated
  minutes and meridiem, and MUST NOT outlast the instant that text quoted — a
  reset that has already gone by yields the 5-minute floor, never a rollover
  into the next day. Where no reset is readable the pause is the branch's named
  default, logged as such (`packages/core/reset-time.ts`,
  `apps/runner/src/claim-breaker.ts`).
- The runner turns that reset time into a one-shot resume poll at
  `budgetResetsAt + 5s`, guarded to ≤ 6h and ignoring unparseable values, so held
  work resumes without restarting the runner — the budget-reset re-queue emits
  `task:updated`, which no realtime subscriber acts on
  (`apps/runner/src/workers.ts`).

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
- Detection: `packages/core/budget-error-classifier.ts` (`isBudgetExhaustionError`,
  `BUDGET_EXHAUSTION_PATTERNS`) — the canonical pattern list, shared by the web
  route and the runner's claim breaker / worker-error reporting so the three
  call sites cannot drift into inconsistent per-provider wording.
- Reset-time parsing: `packages/core/reset-time.ts` (`extractResetTime`,
  `resetDelayMsFrom`, `clampPauseToQuotedReset`, `SESSION_WINDOW_MS`) — one
  parser for both consumers; `apps/web/src/lib/budget-errors.ts` re-exports it
  alongside `isBudgetExhaustionError`, and the runner's claim breaker imports it
  instead of carrying regexes of its own
- Wall handling: `apps/web/src/app/api/workers/[id]/route.ts`
- Learner: `packages/core/oauth-budget.ts` (`learnOauthCapacity`,
  `oauthBudgetPressure`, `inferWindowStart`, `summarizeWindowUsage`,
  `readPacingConfig`)
- Measurement: `apps/web/src/lib/oauth-budget-window.ts`
- Claim diagnostics: `apps/web/src/app/api/workers/claim/route.ts`
- Runner resume: `apps/runner/src/workers.ts`
  (`scheduleResumeAt`, also used for per-context breaker wake-ups)
- Readout: `apps/web/src/app/api/accounts/me/route.ts` (`budgetPacing`)
- Schema: `packages/core/db/schema.ts` (`oauthBudgetEpisodes`) (`tenantBudgets`) (account flags)

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

Unguarded claims and drift found while writing this spec, re-checked against the
code on dev. A fixed row stays so the history is readable; its evidence is the
symbol or test that closed it.

| Gap | Status | Evidence |
| --- | --- | --- |
| `accounts.totalCost` has no writer and nothing resets it daily. The `api` daily cost gate (`daily_cost_limit` in the claim route, refused through `accountLimitRefusal`) and the `api` branch of `dailyBudgetPct` read a column that never moves, so the gate never trips in practice. Tests pass only because they set `totalCost` on a mocked account. The daily cost gate criterion in `auth-oauth-boundaries.md` describes it as live. | open | Writers: none (`git grep totalCost` finds reads only, in the claim route and `pacing-stall.ts`). Readers: claim route, `pacing-stall.ts`, Settings runner tokens. |
| The account-level `monthlyBudgetUsd` / `monthlyCostUsd` / `budgetAlertsSent` columns have no writer. Only the `teams` copies are read and written; the account copies are dead duplicates a reader can mistake for truth. | open | `accounts` vs `teams` in `packages/core/db/schema.ts`; the accumulator in the worker PATCH route writes `teams` only. |
| The runner never reported `costUsd`, so `workers.costUsd` kept its `0` default for runner-executed work. | fixed | `buildTerminalAttributionPayload` (`apps/runner/src/terminal-attribution.ts`) sends `costUsd` whenever the backend reported real spend, plus `costBasis`, `actualModel` and the token tally; `METRICS_ONLY_FIELDS` re-sends them after a refused terminal PATCH. Pinned by `apps/runner/__tests__/unit/terminal-metrics-patch.test.ts`. |
| No test drives the mission budget gate (`getMissionSpendUsd`, `mission-budget-gate.ts`) from a real runner cost report; "mission budget exhausts" is asserted only against injected costs. | open | `apps/web/src/lib/mission-budget.ts`, `apps/web/src/app/api/workers/claim/mission-budget-gate.ts`. |
| The `$0` to estimate fallback could not fire on seat/OAuth auth, where `byModel` is empty and `estimateCostUsd(modelUsage)` returns `0`. | fixed | The worker PATCH route falls back to `estimateCostUsdFromTotals(resultMeta.totalUsage, actualModel)` when the per-model estimate is `0`; pinned by `packages/core/__tests__/model-prices.test.ts`. |
| No test asserts the monthly budget is advisory (crossing 100% of `teams.monthlyBudgetUsd` still allows claims). | open | No claim route test reads `monthlyBudgetUsd`. |
| The double-charge guard `wasTerminal` checks only `completed` / `failed`, narrower than the terminal set. Not a live hole: a repeated terminal PATCH is refused with 409 by the reactivation guard, and a concurrent one loses the terminal-ownership CAS, both before accumulation. Still no test sends a repeated terminal PATCH and asserts a single charge. | open | `wasTerminal` in `apps/web/src/app/api/workers/[id]/route.ts`. |
| `budgetExhaustedAt` with a null `budgetResetsAt` read as exhausted forever. | fixed | `effectiveBudgetResetAt` (`apps/web/src/lib/budget-errors.ts`) derives a missing reset as `exhaustedAt + SESSION_WINDOW_MS`, the writer's own fallback; the claim route uses it. A writer-side test checks every `budgetExhaustedAt:` write pairs a reset. |
| A truncated usage scan was an arbitrary, unordered sample. | fixed | `fetchUsageRows` (`apps/web/src/lib/usage-stats-query.ts`) orders by `completedAt DESC, id DESC`, and the response carries `scan: { rows, limit, truncated, completeSince }`. Follow-up not taken: no index on `workers.completed_at`, so the scan sorts. |
| Cache tokens were counted in two places that were never reconciled. | fixed | `byModel[].inputTokens` is cache-inclusive like `totals`; the cache-exclusive figure is `uncachedInputTokens` (`apps/web/src/lib/usage-stats.ts`). A test asserts `sum(byModel[].inputTokens) === totals.inputTokens`. |
| `oauth_budget_episodes.inputTokens` holds the combined window token total and `outputTokens` holds `0`. The learner sums the two, so it is correct, but any other reader misreads the split; only a code comment at the insert says so, not the schema or a test. | open | `insert(oauthBudgetEpisodes)` in the worker PATCH route; `oauthBudgetEpisodes` in `packages/core/db/schema.ts`. |

Renumbered: AC-8b to AC-26.
