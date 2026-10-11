---
title: Task Estimates (Rollout and Team Switch)
status: active
owner: max
last_verified: 2026-10-11
summary: Task estimates MUST be on for a team that turned them on, off for a team that turned them off, and follow a default that is on only when a pinned, evidence-backed quality gate passes; they never block or order work.
domain: tasks
surfaces: [packages/core/task-estimate-rollout.ts, packages/core/task-estimate-source.ts, apps/web/src/app/app/(protected)/settings/features/page.tsx, apps/web/src/app/app/(protected)/health/estimates/page.tsx]
related: [claim-ordering]
keywords: [task_estimates, taskEstimates, estimates-backtest, blend-v1, p50, p80, new-repo prior, cold start, default on, opt-out, TASK_ESTIMATES_ROLLOUT]
verified_by: [packages/core/__tests__/task-estimate-rollout.test.ts, packages/core/__tests__/task-estimate-source.test.ts, apps/web/src/app/api/teams/[id]/route.test.ts, apps/web/src/app/api/teams/[id]/task-estimates/route.test.ts, apps/web/src/app/app/(protected)/settings/features/TaskEstimatesFeature.dom.test.tsx, apps/web/src/app/app/(protected)/health/estimates/EstimatesOff.test.tsx, apps/web/src/lib/task-time-row.test.ts]
---

## Task Estimates (Rollout and Team Switch)

**Capability statement**: Every new work task on a team with estimates on gets
one frozen p50/p80 estimate, written after the creation response. Whether a team
has estimates on comes from its own stored choice, or, if it never chose, from a
platform default that turns on only when a quality gate measured on the running
estimator version has passed.

**Invariants**:

- `teams.task_estimates` is read as three states: `{ enabled: true }` is on,
  `{ enabled: false }` is off, anything else (NULL, `{}`, malformed) follows the
  default. New teams and teams that existed before this rollout are both NULL, so
  a default flip reaches both. No team is left disabled by accident.
- An explicit `{ enabled: false }` stays off whatever the default is.
- The default is on only when `TASK_ESTIMATES_ROLLOUT.verdict === 'go'` and its
  `estimatorVersion` equals the running `ESTIMATOR_VERSION`. A new estimator
  version reads as off until it is measured.
- A team read that fails reads as off: no estimate is written or shown. Pages
  show a load error, not "off".
- Estimate rows are insert-only, one per (task, estimator version). Turning
  estimates off or rolling back the default never deletes or rewrites them.
- The write runs after the response and never throws. A missing history,
  missing source or estimator error leaves the task unestimated and never fails
  task creation or a claim.
- Estimates are a forecast for people. The claim route, scheduler and mission
  planner do not read `task_estimates` as an input.
- Only a session user holding `manage_team_settings` (owner/admin) can change a
  team's switch, only for a team they belong to. API keys cannot.

**Quality gate** (`evaluateTaskEstimatesGate`, printed by
`packages/core/scripts/estimate-backtest.ts --blend`). All checks must pass:

| Check | Evidence | Bar |
|---|---|---|
| `blend_better` | recent run | blend beats the neighbour median (log error at least 0.05 lower, n ≥ 30) |
| `neighbours` | recent run, rows with similar history | n ≥ 30, median actual/p50 in 0.8–1.25, ≥ 80% within p80 |
| `prior_only` | recent run, rows only the prior answered | n ≥ 30, median actual/p50 in 0.8–1.25, ≥ 75% within p80 |
| `cold_start` | `--held-out <workspace>` run | n ≥ 30, median actual/p50 in 0.8–1.25, ≥ 70% within p80 |

Missing evidence fails its check. Figures live in the `estimates-backtest`
artifact, never in this repo.

**Current verdict (2026-10-09): no-go.** The blend beat the neighbour median and
was within the bar on tasks with similar history. Tasks with only the new-repo
prior ran well past their estimates, and cold start was not evidenced (almost all
scored tasks came from one long-lived workspace). A prior fix shipped afterwards
and has not been re-measured. Estimates stay opt-in. Prior-heavy estimates are
labelled "rough".

**Acceptance criteria**:

- AC-1: GIVEN the gate is no-go WHEN a team with NULL `task_estimates` files a task THEN no estimate row is written.
- AC-2: GIVEN the gate is go for the running version WHEN a team with NULL `task_estimates` files a task THEN one estimate row is written.
- AC-3: GIVEN the gate is go WHEN a team with `{ enabled: false }` files a task THEN no estimate row is written.
- AC-4: GIVEN a member without `manage_team_settings`, or an admin of another team, WHEN they PATCH `taskEstimates` THEN the response is 403 and nothing is stored.
- AC-5: GIVEN estimates are off WHEN an owner/admin opens Health › Estimates THEN the page links to Settings › Features. WHEN a member opens it THEN it says an owner or admin can turn them on, with no action of its own.
- AC-6: GIVEN an estimate whose prior weight is ≥ 0.5 WHEN the task page shows it THEN it is labelled "rough" with a one-line reason, and the range is rounded to a 1/5/15/30-minute step.
- AC-7: GIVEN the estimator throws or a source is unavailable WHEN a task is created THEN creation succeeds and the write returns `failed` or uses the remaining sources.

**Rollout**:

1. From an owner session with read-only production access, run both backtest
   commands in `packages/core/task-estimate-rollout.ts` and update the
   `estimates-backtest` artifact.
2. If every check passes, set `TASK_ESTIMATES_ROLLOUT` to
   `{ verdict: 'go', measuredOn, readoutRef, failing: [] }` and bump
   `last_verified` here. Teams that never chose get estimates from the next
   deploy. Teams that chose keep their choice.
3. Watch `[task-estimate] written … in Nms` and `write failed` log lines (the
   runtime cost per estimate) and Health › Estimates on the first teams.

**Rollback**: set `verdict: 'no_go'` and deploy. Teams that never chose go back
to off; teams that turned estimates on stay on. To stop one team: Settings ›
Features › Turn off. Rows are kept. Full removal: `packages/core/TASK-ESTIMATES-REMOVAL.md`.

**Code surface**:

- `packages/core/task-estimate-rollout.ts`: `TASK_ESTIMATES_GATE`, `evaluateTaskEstimatesGate`, `TASK_ESTIMATES_ROLLOUT`, `taskEstimatesDefaultOn`, `resolveTaskEstimatesState`, `defaultOffReason`
- `packages/core/task-estimate-source.ts`: `loadTaskEstimatesState`, `taskEstimatesEnabled`, `writeTaskEstimate`
- `packages/core/scripts/estimate-backtest.ts`: prints the gate
- `apps/web/src/app/api/teams/[id]/route.ts`: PATCH `taskEstimates`
- `apps/web/src/app/api/teams/[id]/task-estimates/route.ts`: readout with `enabled`, `source`, `defaultOn`
- `apps/web/src/app/app/(protected)/settings/features/`: the team switch
- `apps/web/src/app/app/(protected)/health/estimates/`: readout, off and error states
- `apps/web/src/lib/task-time-row.ts`: rounding and the "rough" label
- `apps/web/src/lib/task-estimate-hook.ts`: the after-response write
