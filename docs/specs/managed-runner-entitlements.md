---
title: Managed-Runner Entitlements
status: active
owner: builder
last_verified: 2026-10-07
summary: A Buildd-managed runner claim MUST leave a task queued, never failed, when the team's plan limit on parallel managed runs or monthly runner-hours is reached, and MUST start it once the limit lifts.
domain: billing
surfaces: [packages/shared/src/entitlements.ts, apps/web/src/lib/entitlements/managed-runner.ts, apps/web/src/lib/entitlements/plans.ts, apps/web/src/components/entitlements/EntitlementBlockedNotice.tsx, apps/web/src/lib/hosted-runner-usage.ts, apps/web/src/lib/hosted-runner-usage-store.ts]
related: [claim-ordering]
keywords: [plan limit, concurrency, runner-hours, managed runner, hosted, upgrade, entitlement_blocked, managed_concurrency, managed_runner_hours, hosted runner allowance, hosted_runner_hours, counted hours, runner_usage]
verified_by: [apps/web/src/lib/entitlements/entitlements.test.ts, apps/web/src/lib/hosted-runner-usage.test.ts, apps/web/src/lib/hosted-runner-usage-store.test.ts, apps/web/src/app/api/workers/claim/route.test.ts, apps/web/src/app/api/tasks/[id]/start/route.test.ts, apps/web/src/components/entitlements/EntitlementBlockedNotice.dom.test.tsx]
# Structural conformance only; passing does not certify every prose invariant.
assertions:
  - id: "evaluate-entitlement"
    type: "symbol"
    name: "evaluateManagedRunnerEntitlement"
    path: "packages/shared/src/entitlements.ts"
  - id: "claim-checks-entitlement"
    type: "symbol_reachable"
    symbol: "checkManagedRunnerEntitlement"
    entry: "apps/web/src/app/api/workers/claim/route.ts"
    as: "call"
  - id: "managed-runner-plan-column"
    type: "config_key"
    key: "managedRunnerPlan"
    file: "packages/core/db/schema.ts"
  - id: "entitlement-tests"
    type: "test_file"
    path: "apps/web/src/lib/entitlements/entitlements.test.ts"
  - id: "claim-checks-hosted-allowance"
    type: "symbol_reachable"
    symbol: "checkHostedRunnerAllowance"
    entry: "apps/web/src/app/api/workers/claim/route.ts"
    as: "call"
  - id: "hosted-runner-hours-column"
    type: "config_key"
    key: "hostedRunnerHours"
    file: "packages/core/db/schema.ts"
---

# Managed-Runner Entitlements

## Plan limits on Buildd-managed compute

**Capability statement**: A claim made with a Buildd-managed runner key MUST be
checked against the plan of the team that owns the task's workspace, and a
limit reached MUST hold the task in the queue with its reason recorded, never
fail it. Self-hosted runners MUST NOT be subject to any commercial limit.

Three things are kept apart:

- **Concurrency**: how many managed runs may execute at once, pooled across
  the team (hosted individual 3, team 10, enterprise custom).
- **Runner-hours**: managed wall-clock compute consumed in the current UTC
  month. Past the allowance, the plan's overage policy either holds new runs
  (`block`) or lets them run (`allow`).
- **Self-hosted capacity**: an operator's own runners, bounded only by
  `accounts.maxConcurrentWorkers` and `workspaces.maxConcurrentTasks`. These
  operational caps are independent of, and evaluated separately from, the
  entitlement.

**Invariants**:

- Only a claim whose account has `accounts.managed_runner = true` (or a
  per-task token minted by one) consults the entitlement.
- A team with no `teams.managed_runner_plan` and no `BUILDD_DEFAULT_MANAGED_PLAN`
  resolves to unlimited; an unknown plan id resolves to unlimited.
- Plan values live only in `MANAGED_RUNNER_PLANS`; `BUILDD_MANAGED_PLAN_CATALOG`
  (hosted config) may replace them without a code change.
- An entitlement deferral never writes `status = 'failed'` and is classified
  by the runner as a temporary deferral (`managed_concurrency`,
  `managed_runner_hours`), never a refusal.
- A deferred task carries `context.entitlementBlock` while pending; the claim
  that starts it removes the key.
- An entitlement is not forceable: no admin force claim and no "Start anyway"
  lifts it.

**Acceptance criteria**:

- AC-1: GIVEN a team on the individual plan with 3 live managed runs WHEN a
  managed key claims one of its pending tasks THEN the claim returns no worker,
  `diagnostics.deferrals.managed_concurrency` is 1, the task stays `pending`,
  and its context gains `entitlementBlock` with kind `concurrency`, limit 3.
- AC-2: GIVEN a team on the team plan with 10 live managed runs WHEN a managed
  key claims THEN the result is the same as AC-1 with limit 10.
- AC-3: GIVEN a task held by AC-1 WHEN one managed run ends THEN the oldest
  entitlement-held task in the team is woken (`capacity.freed`) and the next
  claim starts it with no manual retry.
- AC-4: GIVEN a team whose monthly runner-hours meet its allowance with
  overage `block` WHEN a managed key claims THEN the task is deferred as
  `managed_runner_hours` with the next UTC month as `resetsAt`, and the hourly
  dispatch floor wakes it once the allowance refills or the plan grows.
- AC-5: GIVEN any plan state WHEN a self-hosted runner key claims THEN the
  entitlement is not evaluated.
- AC-6: GIVEN a stamped task still over its limit WHEN a person presses Run now
  THEN `POST /api/tasks/[id]/start` rejects with HTTP 422, `gateReason:
  'entitlement_blocked'`, `blockClass: 'entitlement'`, `canForce: false` and the
  block, and writes nothing to the task.
- AC-7: GIVEN a held task WHEN the dashboard renders it THEN it shows the
  entitlement notice (an info chip, the limit, "starts automatically", an
  upgrade action and "Leave queued") and no error styling or alert role.

**Code surface**:

- `packages/shared/src/entitlements.ts`: `ENTITLEMENT_KEYS`,
  `evaluateManagedRunnerEntitlement`, `parseEntitlementBlock`, `EntitlementBlock`.
- `apps/web/src/lib/entitlements/plans.ts`: `MANAGED_RUNNER_PLANS`,
  `resolveManagedRunnerEntitlement`.
- `apps/web/src/lib/entitlements/managed-runner.ts`: `checkManagedRunnerEntitlement`,
  `stampEntitlementBlock`, `wakeEntitlementBlockedTasks`, `onManagedWorkerTerminal`,
  `sweepEntitlementBlockedTasks`.
- `apps/web/src/app/api/workers/claim/route.ts`: the in-loop gate, after the
  workspace cap.
- `apps/web/src/app/api/tasks/[id]/start/route.ts`: the start refusal.
- `apps/web/src/app/api/workers/[id]/route.ts`: the terminal wake.
- `apps/web/src/app/api/cron/dispatch-drain/route.ts`: the hourly sweep.
- `apps/web/src/components/entitlements/EntitlementBlockedNotice.tsx` and
  `apps/web/src/lib/entitlements/presentation.ts`: the one renderer and its copy.
- `packages/core/db/schema.ts`: `accounts.managedRunner`, `teams.managedRunnerPlan`.

## Hosted runner allowance (counted hours)

**Capability statement**: Every cloud run attempt's runner time MUST be kept
per attempt, weighted by container size (standard 1x, large 2x), and rolled up
per team and workspace for the current UTC month. When the team has a hosted
runner allowance and its counted hours reach it, a new cloud claim MUST leave
the task queued with the reason recorded, never fail it, and MUST NOT stop a
task already running.

**Invariants**:

- `runner_usage` holds one row per (worker, attempt), written when the
  attempt's run report arrives (`cloud-run-report:*` artifact). Re-delivery
  overwrites its own row; a resumed attempt adds one.
- An attempt spanning a month boundary is split between the months by the
  share of its running time on each side.
- `teams.hosted_runner_hours` NULL (the default) is no cap: the claim never
  reads usage, and no banner or hold appears.
- The hold applies to cloud claims only (`executor: 'cloud'` or a per-task
  token). A host runner may still take the task.
- The hold is stamped as `context.entitlementBlock` with kind `hosted_runner`
  and deferral key `hosted_runner_hours`; `explain` names it ("Hosted runner
  allowance used"). The hourly sweep wakes it once the allowance refills or
  grows.
- Hours only: no compute dollars are shown anywhere. Model spend is on the
  team's own key and is not part of the meter.

**Acceptance criteria**:

- AC-8: GIVEN a team with an allowance of 50 and 50 counted hours this month
  WHEN a cloud claim reaches one of its tasks THEN the claim returns no worker,
  `diagnostics.deferrals.hosted_runner_hours` is 1, the task stays `pending`,
  and its context gains `entitlementBlock` with kind `hosted_runner`.
- AC-9: GIVEN the same team WHEN a host runner claims THEN the allowance is not
  evaluated.
- AC-10: GIVEN counted hours at 80% of the allowance WHEN Home renders THEN it
  shows the hosted runner banner; at 100% the banner says new cloud runs wait.
- AC-11: GIVEN a held task WHEN it renders THEN the notice offers more hours,
  running on your own runner, and waiting for the reset.

**Code surface**:

- `apps/web/src/lib/hosted-runner-usage.ts`: roll-up, month split, forecast,
  thresholds and copy (pure).
- `apps/web/src/lib/hosted-runner-usage-store.ts`: `recordRunnerUsageFromReport`,
  `checkHostedRunnerAllowance`, `teamHostedRunnerSummary`, `teamHostedRunnerBanner`.
- `apps/web/src/app/api/workers/[id]/artifacts/route.ts`: records usage on report write.
- `apps/web/src/components/hosted-runner/`: the Usage page section and the Home banner.
- `packages/core/db/schema.ts`: `runnerUsage`, `teams.hostedRunnerHours`.

**Out of scope**: prices, product ids, checkout, plan assignment and overage
billing (hosted billing writes `teams.managed_runner_plan` and sets
`NEXT_PUBLIC_BUILDD_UPGRADE_URL`); provisioning managed runner keys; metering
self-hosted compute.
