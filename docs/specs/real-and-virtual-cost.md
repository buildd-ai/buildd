---
title: Real and Virtual Cost
status: draft
owner: max
last_verified: 2026-10-07
summary: Every worker's tokens and cost MUST carry a basis, real (charged per token) or virtual (list-price value of plan usage), and every rollup MUST report the two separately rather than as one sum.
domain: billing
surfaces: [apps/web/src/app/api/workers/[id]/route.ts, apps/runner/src/agent-model-env.ts, apps/runner/plugin/scripts/buildd-hook.mjs, packages/core/budget-alerts.ts]
related: [usage-and-cost-accounting, local-agent-presence, auth-oauth-boundaries, provider-failover]
keywords: [cost_basis, real cost, virtual cost, list price, metered, seat, modelAuth, costUsd, Agent SDK credit pool, per-worker billing mode]
verified_by: []
supersedes: []
---
# Real and Virtual Cost

**Capability statement**: buildd MUST record, for every unit of usage it
accounts, whether the cost is **real** or **virtual**, and MUST report the two
side by side wherever it reports cost or tokens.

- **Real**: usage charged per token to a credential the team pays for (an
  Anthropic or OpenAI API key, a team model endpoint, a cloud-provider model
  account). The dollar figure approximates money spent.
- **Virtual**: usage drawn from a plan allowance (a Claude or ChatGPT
  subscription login). The dollar figure is the list-price value of that usage,
  a measure of consumption, not of money spent.

Both are legitimate and both are tracked. Tokens are the same unit under either
basis; the basis says how to read the dollar figure attached to them.

`usage-and-cost-accounting.md` defines how usage is captured and rolled up. It
records that the credit-pool exclusion of metered work "waits on a per-worker
billing mode"; this spec defines that mode. Nothing here changes which limits
apply to an account (`auth-oauth-boundaries.md`).

---

## Why the account is not the source

`accounts.authType` describes the account that claimed, not the credential that
ran. The runner chooses a credential per worker (`applyModelEnv`,
`apps/runner/src/agent-model-env.ts:155`): a delivered API key, the machine's
own login, a delivered or tenant subscription token, or a team endpoint. CLI and
device logins create `api` accounts regardless of what the machine runs on. So
the basis MUST be reported by whoever chose the credential, per worker, and
MUST NOT be inferred from `authType`.

The `costUsd` column today mixes three things with no marker: a backend-reported
cost, a server list-price estimate from tokens
(`apps/web/src/app/api/workers/[id]/route.ts:303-320`), and a session's priced
transcript usage (`priceSessionUsage`, `packages/core/model-prices.ts:166`).
Whether a figure was estimated is a separate fact from its basis and is recorded
separately.

---

## Recording the basis

**Capability statement**: A worker row MUST say which basis its usage was
charged on, as reported by the party that picked the credential, and MUST say
"unknown" rather than guess.

**Invariants**:
- `workers.cost_basis` is one of `real`, `virtual`, `mixed`, `unknown`, or NULL.
  NULL means the row has recorded no usage: every report that carries usage
  sets a basis, and the migration that added the column classified every
  earlier row that had usage (see Historic rows).
- `unknown` means usage arrived and its reporter did not say how it was
  charged. It is a gap to close, not a category: it comes only from a reporter
  that predates this field (a runner or hook not yet upgraded), an interactive
  session whose environment does not settle the basis, or a self-report
  through the MCP that omits `costBasis`. The usage rollup reports the unknown
  share on its own so a trailing window shows whether any remain.
- The basis applies to the row's tokens and its cost together. A consumer MUST
  NOT split a row's tokens and its cost across bases.
- The server MUST NOT derive the basis from `accounts.authType`, the model id,
  the dollar amount, or whether the reported cost was zero. A report with no
  basis records `unknown`.
- The first reported basis is kept. A later report with a different known basis
  turns the row `mixed`; `unknown` never overwrites a known basis. This keeps the
  write order-independent, like the raise-only usage writes it sits beside.
- A `mixed` row MUST carry its per-basis split in
  `resultMeta.usageByBasis` (`{ real?, virtual? }`, each with tokens and
  `costUsd`) whenever the reporter can attribute usage to each basis. A `mixed`
  row without a split is reported as mixed with no breakdown, never divided
  evenly or assigned to one side.
- Whether `costUsd` was estimated by the server is recorded as
  `resultMeta.costEstimated: true`. It does not change the basis: a real-basis
  run whose backend reported no cost is still real.

**Reporters**:

| Reporter | Source of truth | real | virtual |
|---|---|---|---|
| Self-hosted runner, Claude | `applyModelEnv` result | injected API key; team endpoint | `hostSeatUsed`; injected subscription or tenant token |
| Self-hosted runner, Codex | `codex-auth.ts` | `OPENAI_API_KEY`; team endpoint | ChatGPT `auth.json` |
| Cloud runner | run report `modelAuth` | `metered` | `owner_seat` |
| Interactive session (plugin hook) | the hook's own environment | see below | see below |
| MCP `complete_task` / `update_progress` self-report | optional `costBasis` argument | as given | as given |

- The runner sends `costBasis` on every worker PATCH that carries usage,
  including `metricsOnly` reports. It reports what it injected, never what the
  account is.
- Provider failover that moves a running worker to a different credential
  reports the new basis on the next PATCH, which makes the row `mixed` when the
  two differ.
- The cloud runner's reported basis MUST agree with the `modelAuth` in its own
  run report for the same run. The container only holds a placeholder key, so
  its env cannot tell: the supervisor plans the route with the same resolution
  egress applies (`plannedModelAuth`) and passes it as `BUILDD_CLOUD_MODEL_AUTH`;
  the in-container runner reports `virtual` for `owner_seat` and `real` for
  `metered` (`cloudCostBasis`), ahead of anything its own env suggests. No hint
  (the team endpoint lookup was unavailable) falls back to the env.
- A runner derives the basis when it builds the agent env (`claudeCostBasis`,
  `codexCostBasis` in `apps/runner/src/cost-basis.ts`), keeps it on the local
  worker, and sends it on every terminal and metrics-only report.

**Interactive sessions** (`apps/runner/plugin/`). Rollout order matters: the
event endpoint refuses unknown fields, and the plugin installs from the
repository's default branch, so the hook MUST NOT send a basis until the
server that accepts `usage.costBasis` is serving production. the hook reports usage it
reads from the session's transcript, and the transcript does not record which
credential served it. The hook therefore reports a basis only when its
environment determines one, and `unknown` otherwise:
- real: `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX` or another
  cloud-provider switch is set; `ANTHROPIC_AUTH_TOKEN` or an apiKeyHelper is
  configured; `ANTHROPIC_BASE_URL` points away from Anthropic; or
  `ANTHROPIC_API_KEY` is set **and** approved for use in the client's own
  config.
- virtual: the client config shows a subscription login and none of the above
  holds.
- An `ANTHROPIC_API_KEY` that is set but not approved is not evidence of real
  usage, because the client does not use it.
- The hook sends the basis as `usage.costBasis` (`real`, `virtual` or
  `unknown`, never `mixed`) on `touch` and `end`. A hook build
  that predates this field sends none, and the server records `unknown`.
- The Codex and Cursor hooks report no usage today, so they report no basis.

**Acceptance criteria**:
- AC-1: GIVEN a runner whose `applyModelEnv` injected an API key WHEN it reports
  usage THEN the worker's `cost_basis` is `real`.
- AC-2: GIVEN a runner that ran on the machine's own login (`hostSeatUsed`) WHEN
  it reports usage THEN `cost_basis` is `virtual`, regardless of the account's
  `authType`.
- AC-3: GIVEN a usage report with no `costBasis` WHEN the server applies it THEN
  `cost_basis` is `unknown` and is not derived from `authType`.
- AC-4: GIVEN a worker with `cost_basis = 'virtual'` WHEN a later report says
  `real` THEN `cost_basis` is `mixed`; WHEN a later report says `unknown` THEN it
  stays `virtual`.
- AC-5: GIVEN a report with `costUsd: 0` and token usage WHEN the server prices
  the tokens THEN `costUsd` holds the estimate, `resultMeta.costEstimated` is
  true, and `cost_basis` is the reported basis.
- AC-6: GIVEN an interactive session whose environment sets `ANTHROPIC_API_KEY`
  that the client config has not approved, and that is logged in to a
  subscription, WHEN the hook reports usage THEN the basis is `virtual`.
- AC-7: GIVEN a hook build that sends `usage` without a basis WHEN the server
  applies it THEN `cost_basis` is `unknown`.
- AC-8: GIVEN a report whose `costBasis` is not one of the four values WHEN the
  server applies it THEN the request is rejected with HTTP 400 and no usage is
  written.

---

## Reporting

**Capability statement**: Every surface that shows cost or tokens MUST show real
and virtual separately, and MUST show `unknown` and `mixed` usage as what they
are.

**Invariants**:
- Rollups (`computeUsageStats`, the Insights flow series, the budget forecast)
  carry per-basis totals: `real`, `virtual`, `mixed`, `unknown`, each with
  tokens and `costUsd`. A single combined dollar total is shown only when labelled
  as combined, next to the split.
- A `mixed` row with a `usageByBasis` split contributes its parts to `real` and
  `virtual`. Without a split it contributes to `mixed` only.
- Interactive-session workers (`workers.runner = 'mcp'`) and runner workers are
  separable in every split, so session usage never disappears into runner usage.
- Virtual dollars are labelled as list-price value, not spend, wherever they
  are shown.
- The surfaces that today switch between cost and tokens on
  `accounts.authType` (`WorkerStats.tsx`, `LiveWorkerActivity.tsx`) switch on
  the worker's basis instead.
- The "no cost recorded" state (`usage-and-cost-accounting.md` AC-5) still
  applies per basis: a basis with no recorded cost reads as unavailable, not
  `$0.00`.

**Acceptance criteria**:
- AC-9: GIVEN one real worker at $2 and one virtual worker at $5 in a window
  WHEN `GET /api/stats/usage` is called THEN the response reports real $2 and
  virtual $5 separately, and no unlabelled $7 total.
- AC-10: GIVEN a `mixed` worker with a `usageByBasis` split of real $1 and
  virtual $3 WHEN the rollup is computed THEN real includes $1 and virtual
  includes $3, and `mixed` is zero.
- AC-11: GIVEN a window whose only cost is on `unknown` rows WHEN the Insights
  page renders THEN that cost appears under unknown, not under real or virtual.
- AC-12: GIVEN an interactive-session worker and a runner worker with the same
  basis WHEN usage is grouped by executor THEN each appears in its own bucket.

---

## Spend consequences

**Capability statement**: A spend limit MUST count only the basis it is meant to
measure.

**Invariants**:
- The team Agent SDK credit pool (`teams.monthlyCostUsd`,
  `countsTowardAgentSdkCreditPool`) measures plan usage: a `real` row MUST NOT
  draw on it. `virtual` rows draw on it as today. `unknown` and NULL rows draw
  on it as today, so the cutover changes nothing until bases are reported.
- A `mixed` row draws only its virtual part, when a split exists; without a
  split it draws its whole cost, as today.
- The mission `costBudgetUsd` gate (`getMissionSpendUsd`, and the mission
  block of `getBudgetForecast`) guards money: `virtual` rows never count toward
  it, so plan usage, including interactive sessions on a subscription, is not
  stopped by a dollar budget. `real`, `mixed`, `unknown` and NULL rows count,
  so real spend cannot slip past it unlabelled (`countsTowardMissionBudget`).

**Acceptance criteria**:
- AC-12b: GIVEN a mission whose workers are all `virtual` WHEN its spend is
  computed for the `costBudgetUsd` gate THEN it is 0, and GIVEN one `real`
  worker at $2 THEN it is $2.
- AC-13: GIVEN a terminal report with `costBasis: 'real'` and a positive cost
  WHEN it is applied THEN `teams.monthlyCostUsd` does not move and the worker
  row still carries the cost.
- AC-14: GIVEN a terminal report with `costBasis: 'virtual'` WHEN it is applied
  THEN `teams.monthlyCostUsd` rises by the cost, exactly as before this spec.

---

## Historic rows

**Capability statement**: Rows that predate this capability MUST read as a
basis the owner has stated, by a rule, and the rule MUST NOT name observed
values.

**Invariants**:
- Before cutover, the deployment's usage ran on plan logins except for
  cloud-runner runs, which were charged per token. Historic rows with usage
  therefore read as `virtual`, except cloud-runner rows, which read as `real`.
- The rule is structural. Cloud-runner runs are `--once` runs and register as
  `headless://<host>/once/<taskId>` (`apps/runner/src/run-once.ts`), so the
  migration that adds the column sets `real` on rows of that shape and
  `virtual` on every other row with usage. It MUST NOT carry a list of runner
  names, worker ids or workspace ids (`CLAUDE.md`, "This Repo Is Public").
- Rows with no usage stay NULL, and the backfill only touches NULL rows, so a
  re-run changes nothing.

**Acceptance criteria**:
- AC-15: GIVEN a pre-cutover row with usage whose runner is not of the
  `--once` shape WHEN the migration runs THEN its basis is `virtual`, and GIVEN
  one of that shape THEN `real`.
- AC-16: GIVEN the backfill migration's SQL WHEN `bun run no-prod-data:check`
  runs THEN it passes: the migration contains no literal ids or runner names.

---

## Code surface

Existing, to change:
- Report handler and server estimate:
  `apps/web/src/app/api/workers/[id]/route.ts:303-320` (metrics-only),
  `:1283-1330` (terminal transition and pool)
- Credential choice: `apps/runner/src/agent-model-env.ts` (`applyModelEnv`,
  `hostSeatUsed`, `injected`), `apps/runner/src/codex-auth.ts`
- Runner report payload: `apps/runner/src/buildd.ts:280-300`
- Cloud runner: `apps/cloud-runner/src/owner-seat.ts` (`modelAuth`),
  `apps/cloud-runner/src/run-report.ts`
- Session usage: `apps/runner/plugin/scripts/buildd-hook.mjs` (`buildBody`,
  `collectUsage`), `apps/web/src/lib/local-session.ts`
- MCP self-report: `packages/core/mcp-tools.ts` (`complete_task`,
  `update_progress` usage arguments)
- Pool: `packages/core/budget-alerts.ts` (`countsTowardAgentSdkCreditPool`)
- Rollups: `apps/web/src/lib/usage-stats.ts`, `apps/web/src/lib/insights-flow.ts`,
  `apps/web/src/lib/insights-flow-query.ts`, `apps/web/src/lib/budget-forecast.ts`
- Schema: `packages/core/db/schema.ts` (`workers`, `ResultMeta`)

New: `workers.cost_basis`, `resultMeta.usageByBasis`,
`resultMeta.costEstimated`, the `costBasis` field on the worker PATCH, the hook
body and the MCP usage arguments.

---

## Out of scope

- Invoicing or reconciling against a provider bill. Real cost stays a list-price
  figure; provider discounts and cloud-provider rates are not modelled.
- Which limits apply to an account (`auth-oauth-boundaries.md`) and OAuth
  window pacing (`usage-and-cost-accounting.md`).
- Choosing which credential a run uses.
- Reporting usage from the Codex and Cursor hooks.

---

## Decisions

Recorded from the owner's review of the draft:

1. Cloud-runner rows are identified by the `--once` runner shape (Historic
   rows). No cloud-runner run before cutover used an owner seat.
2. Mission budgets count every basis except `virtual`. The expected use is
   teams bringing their own API key, where real dollars are what a budget is
   for; plan usage, interactive sessions especially, is not throttled by it.
3. `unknown` keeps drawing on the credit pool as before. The goal is that
   `unknown` stops occurring, and the usage rollup shows whether it does.
