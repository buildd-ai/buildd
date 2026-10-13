---
title: Task Estimates (Rollout and Team Switch)
status: active
owner: max
last_verified: 2026-10-12
summary: Estimates follow the team's switch or a default gated on measured quality, never order work; teams see one plain accuracy line, the platform owner the calibration and gate detail.
domain: tasks
surfaces: [packages/core/task-estimate-rollout.ts, packages/core/task-estimate-source.ts, apps/web/src/app/app/(protected)/settings/features/page.tsx, apps/web/src/app/app/(protected)/health/estimates/page.tsx]
related: [claim-ordering, bug-intake-and-quality]
keywords: [task_estimates, taskEstimates, estimates-backtest, blend-v1, p50, p80, new-repo prior, cold start, default on, opt-out, TASK_ESTIMATES_ROLLOUT, estimate accuracy, within upper estimate, insufficient evidence, operator estimation, calibration]
verified_by: [packages/core/__tests__/task-estimate-rollout.test.ts, packages/core/__tests__/task-estimate-source.test.ts, apps/web/src/app/api/teams/[id]/route.test.ts, apps/web/src/app/api/teams/[id]/task-estimates/route.test.ts, apps/web/src/app/app/(protected)/settings/features/TaskEstimatesFeature.dom.test.tsx, apps/web/src/app/app/(protected)/health/estimates/EstimatesOff.test.tsx, apps/web/src/app/app/(protected)/health/estimates/EstimatesClient.test.tsx, apps/web/src/app/app/(protected)/health/estimates/estimates-view.test.ts, apps/web/src/lib/task-time-row.test.ts, packages/core/__tests__/task-estimate-operator.test.ts, apps/web/src/app/api/admin/platform-owner-routes.test.ts, apps/web/src/app/api/admin/tenant-privacy.test.ts]
assertions:
  - id: "pinned-rollout"
    type: "symbol"
    name: "TASK_ESTIMATES_ROLLOUT"
    path: "packages/core/task-estimate-rollout.ts"
  - id: "gate-evaluator"
    type: "symbol"
    name: "evaluateTaskEstimatesGate"
    path: "packages/core/task-estimate-rollout.ts"
  - id: "write-reads-team-state"
    type: "symbol_reachable"
    symbol: "taskEstimatesEnabled"
    entry: "packages/core/task-estimate-source.ts"
    as: "call"
  - id: "features-page-reads-state"
    type: "symbol_reachable"
    symbol: "loadTaskEstimatesState"
    entry: "apps/web/src/app/app/(protected)/settings/features/page.tsx"
    as: "call"
  - id: "health-page-reads-state"
    type: "symbol_reachable"
    symbol: "loadTaskEstimatesState"
    entry: "apps/web/src/app/app/(protected)/health/estimates/page.tsx"
    as: "call"
  - id: "rollout-tests"
    type: "test_file"
    path: "packages/core/__tests__/task-estimate-rollout.test.ts"
---

## Task Estimates (Rollout and Team Switch)

**Capability statement**: Every new work task on a team with estimates on gets
one frozen p50/p80 estimate, written after the creation response. Whether a team
has estimates on comes from its own stored choice, or, if it never chose, from a
platform default that turns on only when a quality gate measured on the running
estimator version has passed. A team sees how often its own finished tasks
landed within the upper estimate; the platform owner sees the calibration
detail and gate evidence behind the default.

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

### Who sees what

One scorer, two projections. Both read `computeTaskEstimateReadout` (which
scores with the backtest's `scoreRows`); neither keeps a second implementation
of "within p80" or "median actual/p50". The two audiences never share a page.

| | Team surface | Platform operator surface |
|---|---|---|
| Who | Every member of the team, owner/admin and member alike | The platform owner only |
| Where | Health › Estimates; the Time row on a task | The private admin app's Insights › Estimation, reading a platform-owner API in this repo |
| Data | The team's own scored tasks, running estimator version | Every team, every estimator version, plus the backtest evidence |
| Shows | One accuracy line, its sample, at most one limited-history line | Calibration by cohort, gate verdicts, runtime cost and coverage |
| Never shows | Gate verdicts or figures, other teams, sources, clusters, tokens, charts | Another team's written strings (see operator API) |

A team owner/admin sees the same numbers as a member. What they get extra is
the way to the switch (Settings › Features), never operator detail.

**Sample and timeframe** (both surfaces use these words):

- **Scored**: a work task with a frozen estimate under estimator version V
  whose actuals are stored (the task finished). This is the n.
- **Not scored**: a task still open, a task that ended without actuals, a
  non-work task, or an estimate under another version. The team surface does
  not count these; the operator surface counts them as excluded, with a reason.
- **Version**: a readout is per estimator version and a mixed set is refused.
  A new version starts its count at zero; earlier versions' rows are kept, not
  scored into the new one.
- **Timeframe on the team surface is the version's lifetime**: the latest
  `READOUT_ROW_LIMIT` scored rows of the running version, with no date window.
  The copy therefore says "across N finished tasks" and never "in the last 30
  days", "this week" or any range it did not query. The page ignores the Health
  `?window=` parameter. If a date window is ever queried, the copy names it.
- **Timeframe on the operator surface is explicit**: the admin scope window
  (`parseAdminScope`: 24h, 7d or 30d, by estimate creation time), stated on
  every figure. Backtest results carry their own `measuredOn` date and are not
  windowed.

### Team surface: Health › Estimates

One answer: how often a task finished within its upper estimate (p80), over
how many finished tasks. In the product voice (`docs/design/design-system.md`
§5): plain words, no model terms (p50, p80, prior, cluster, blend, log error)
in rendered copy, no em dash, no "yet", no verdict adjective.

| Scored n | Lead | Under it |
|---|---|---|
| 0 | "Not enough finished tasks to assess estimates." | nothing |
| 1–9 | "Not enough finished tasks to assess estimates." | "N finished so far." |
| 10 or more | "X in 10 tasks finished within the upper estimate." | "Across N finished tasks." and, only when the typical overrun or underrun is outside 0.85–1.15, "Typically ran 1.5x longer than estimated." (or "shorter") |

- The cut-off is `MIN_SCORED_FOR_VERDICT` (10). Below it no rate is shown,
  rounded or otherwise: missing evidence is not a good result.
- From 10 up the line states the fraction and nothing else: no "most", "almost
  every", "good", badge, colour or tick that promises accuracy. A weak result
  reads as its number.
- **Limited history**: one muted line, "N of these had little history in the
  repo to go on.", when at least one scored estimate leaned mostly on the
  new-repo prior or on no evidence. It carries no rate of its own.
- **Removed from the team page**: the scatter chart, the Details disclosure and
  every table in it (kind, area, what the estimate leaned on, learning curve),
  and the tokens line. Their figures move to the operator surface.
- **Kept**: the per-task explanation in the task's Time row, including the
  "rough" label (AC-6). That is where a member asks "why this estimate".
- **States stay distinct**: load error; no team; off for an owner/admin (link
  to Settings › Features); off for a member (an owner or admin can turn them
  on, no action); on with 0, 1–9, and 10+ scored. Off reads the same whether
  the team chose off or follows the default (AC-8).
- An owner/admin MAY get one quiet link to Settings › Features when estimates
  are on. A member gets no action.

**Team API** (`/api/teams/[id]/task-estimates`): read by any member of the team
or that team's own API key, 404 for anyone else. It returns that team's
readout only. It MUST NOT carry the gate verdict, backtest figures, another
team's rows or runtime cost. Its existing per-team breakdowns stay for API
callers; the page does not render them.

### Platform operator surface: Insights › Estimation

For deciding whether the estimator is calibrated and the default is safe to
flip. Detailed by design; the team-surface copy rules on model terms do not
apply, the no-fabrication rules do.

- **Live calibration, per estimator version**: within p80, median actual/p50,
  median absolute log error, n scored and n excluded with the reason. Sliced by
  what the estimate leaned on (similar tasks, same area, new-repo prior, no
  evidence), task kind, task complexity where the task has one, the
  workspace's finished-task count at estimate time, team/workspace, and time.
  A slice with n below 10 shows its n and no rate.
- **Chart plus table**: an estimate-vs-actual distribution or calibration
  chart, always with a table holding the same numbers for screen readers and
  copying. Drilldown to a task's evidence only for teams the owner belongs to.
- **Backtest gate, per estimator version**: verdict go, no-go or unknown, the
  date measured, the evidence ref, each check's bar, n and result, and which
  checks failed, from `TASK_ESTIMATES_ROLLOUT` and `evaluateTaskEstimatesGate`.
  A version with no measurement reads unknown. Live figures sit in their own
  section and are never labelled as passing or failing a backtest check.
- **Runtime and coverage**: share of new work tasks that got an estimate,
  write outcomes (written, skipped, failed) and write duration; tokens and
  repairs where recorded. A measure with no instrumentation reads "not
  instrumented", never 0. Write duration and failures are log lines only today,
  so they read "not instrumented" until stored.

**Operator API** (`GET /api/admin/estimates`):

- Gated by `requirePlatformOwner` like every `/api/admin/*` route: an
  admin-level key whose account is on the platform-admin allowlist. Everyone
  else, including a team owner, a team API key, a signed-in session and an
  unset allowlist, gets 404, enforced on the server.
- Read-only. Bounded: the admin scope window plus a row cap
  (`OPERATOR_ROW_LIMIT`, newest first, `truncated: true` when hit), aggregated
  in core, never one row per task in the response. Coverage and write counts
  are aggregated in SQL so the cap does not shrink them.
- Tenant privacy as the other admin routes (`lib/admin/tenant-privacy.ts`):
  full detail only for teams the owner belongs to. Other teams contribute
  numbers, never strings they wrote (workspace names, task titles, area labels,
  which are repo paths).
- No team endpoint gains any of this.

Query: `window` (`24h` | `7d` | `30d`, default `7d`, by estimate creation
time), `teamId?`, `workspaceId?`, `version?` (one estimator version; default
every version in the window). 400 on a bad window, id or version; 404 for a
non-owner or an unknown team/workspace; 500 `{ error }` on a failed read, with
no error text. Response (`OperatorEstimatesReport` in
`packages/core/task-estimate-operator.ts`, plus the scope echo):

```ts
{
  schemaVersion: 1,
  window, since, teamId, workspaceId, version,   // scope echo
  runningVersion: string,                         // ESTIMATOR_VERSION
  minScoredForRate: 10,
  truncated: boolean, rowLimit: number,
  detailLimitedToOwnTeams: boolean,
  live: Array<{                                   // one per version, never pooled; running first
    estimatorVersion, running: boolean,
    estimates: number,                            // rows of this version created in the window
    eligible: number,                             // work task with actuals stored
    excluded: { open, ended_without_actuals, non_work, no_usable_actual },
    overall: Score, tokens: Score,
    repairs: { expected, actual } | null,
    bySource | byKind | byComplexity | byHistory | byCluster | byDay: Array<{ key, score: Score }>,
    byTeam | byWorkspace: Array<{ key /* id */, own: boolean, name, score: Score }>,
  }>,
  backtest: Array<{                               // running, pinned and observed versions
    estimatorVersion, running, verdict: 'go' | 'no_go' | 'unknown',
    measuredOn: string | null, evidenceRef: string | null, failing: GateCheckId[],
    checks: Array<{ id, run: 'recent' | 'held_out', bar, result: 'passed' | 'failed' | 'unknown', n: null }>,
    defaultOn: boolean,
  }>,
  coverage: { workTasks: number, byVersion: Array<{ estimatorVersion, estimated, share: number | null }> },
  runtime: { written: number, skipped | failed | writeDurationMs: { status: 'not_instrumented' } },
}
Score = { n, scored, sufficient: boolean, withinP80, medianRatio, medianAbsLogError }  // rates null when !sufficient
```

- **Unknown is not zero.** `sufficient: false` (scored under 10) carries the n
  and null rates. `share: null` means no work tasks in scope. A gate check's
  `n` is null because the figures live in the evidence artifact, not this
  repo. `{ status: 'not_instrumented' }` means nobody records it; it
  becomes `{ status: 'measured', value }` once stored.
- **Live and backtest never mix.** `backtest` reads `TASK_ESTIMATES_ROLLOUT`
  only (the pin covers one version; any other reads `unknown`). No `live`
  figure carries a pass or fail.
- `byCluster` holds own teams' rows only. Every other slice counts every team.
  `byHistory` keys are the backtest bands `0`, `1-9`, `10-49`, `50+`;
  `byDay` keys are UTC dates. `byCluster`, `byKind` and `byComplexity` use
  `none` / `unknown` for a missing value.
- Drilldown to one task's evidence is not in this response: the admin app
  links an own-team task to its task page.
- The same small-sample rule and "each group carries n" as the quality
  metrics in `bug-intake-and-quality.md` §7. That module is not built yet;
  when it is, estimation stays its own section (it scores forecasts, not
  defects).

**Not changed by this contract**: the estimator, its version, the gate's bars,
the current no-go verdict, the default, the team switch, and the claim route,
scheduler and planner (which still do not read estimates).

**Acceptance criteria**:

Each criterion names the test that holds it; "(planned)" marks one the
implementation tasks add.

- AC-1: GIVEN the gate is no-go WHEN a team with NULL `task_estimates` files a task THEN no estimate row is written. Test: packages/core/__tests__/task-estimate-rollout.test.ts.
- AC-2: GIVEN the gate is go for the running version WHEN a team with NULL `task_estimates` files a task THEN one estimate row is written. Test: task-estimate-rollout.test.ts, task-estimate-source.test.ts.
- AC-3: GIVEN the gate is go WHEN a team with `{ enabled: false }` files a task THEN no estimate row is written. Test: task-estimate-rollout.test.ts.
- AC-4: GIVEN a member without `manage_team_settings`, or an admin of another team, WHEN they PATCH `taskEstimates` THEN the response is 403 and nothing is stored. Test: apps/web/src/app/api/teams/[id]/route.test.ts.
- AC-5: GIVEN estimates are off WHEN an owner/admin opens Health › Estimates THEN the page links to Settings › Features. WHEN a member opens it THEN it says an owner or admin can turn them on, with no action of its own. Test: EstimatesOff.test.tsx.
- AC-6: GIVEN an estimate whose prior weight is ≥ 0.5 WHEN the task page shows it THEN it is labelled "rough" with a one-line reason, and the range is rounded to a 1/5/15/30-minute step. Test: apps/web/src/lib/task-time-row.test.ts.
- AC-7: GIVEN the estimator throws or a source is unavailable WHEN a task is created THEN creation succeeds and the write returns `failed` or uses the remaining sources. Test: task-estimate-source.test.ts.
- AC-8: GIVEN any team WHEN Settings › Features or Health › Estimates renders THEN it shows the team's own state only: no line about other teams' default and no reason drawn from the rollout measurement. Test: TaskEstimatesFeature.dom.test.tsx, EstimatesOff.test.tsx.
- AC-9: GIVEN 0 scored tasks WHEN Health › Estimates renders THEN it reads "Not enough finished tasks to assess estimates." with no count and no rate. GIVEN 1 or 9 THEN the same lead and "1 finished so far." / "9 finished so far.", no rate. Test: estimates-view.test.ts, EstimatesClient.test.tsx.
- AC-10: GIVEN 10 scored tasks, 7 within p80 WHEN the page renders THEN it reads "7 in 10 tasks finished within the upper estimate." and "Across 10 finished tasks." GIVEN 40 THEN the n reads 40. Neither carries a verdict adjective, badge or date range. Test: estimates-view.test.ts.
- AC-11: GIVEN a median actual/p50 of 1.0 THEN no typical line shows; of 1.5 THEN "Typically ran 1.5x longer than estimated."; of 0.6 THEN "…shorter…". Test: estimates-view.test.ts.
- AC-12: GIVEN any enabled state WHEN the page renders THEN it contains no chart, no Details disclosure, no breakdown table and no tokens line, and no rendered text contains p50, p80, prior, cluster or "last N days". Test: EstimatesClient.test.tsx.
- AC-13: GIVEN scored estimates of which some leaned mostly on the new-repo prior WHEN the page renders THEN one muted limited-history line shows the count and no rate; GIVEN none THEN no such line. Test: estimates-view.test.ts.
- AC-14: GIVEN a member and an owner of the same enabled team WHEN each opens Health › Estimates THEN both see the same numbers; only the owner may see a link to Settings › Features. Test: EstimatesClient.test.tsx.
- AC-15: GIVEN a caller who is not a member of team T and does not hold T's API key WHEN they GET T's task-estimates readout THEN the response is 404; GIVEN a member THEN the body holds T's rows only and no gate verdict or backtest figure. Test: apps/web/src/app/api/teams/[id]/task-estimates/route.test.ts.
- AC-16: GIVEN no credential, a team API key, a team owner's session or an unset allowlist WHEN they call the operator estimates API THEN 404; GIVEN the platform owner THEN 200. Test: apps/web/src/app/api/admin/platform-owner-routes.test.ts.
- AC-17: GIVEN the platform owner belongs to team A and not team B WHEN they read the operator estimates API THEN B's numbers are present and no string B wrote appears in the JSON. Test: apps/web/src/app/api/admin/tenant-privacy.test.ts.
- AC-18: GIVEN rows under two estimator versions WHEN the operator readout is built THEN each version is scored separately, and a version absent from `TASK_ESTIMATES_ROLLOUT` reads unknown. GIVEN a held-out (cold-start) run THEN its check shows its own n and result. Live figures never appear under a backtest check. Test: packages/core/__tests__/task-estimate-operator.test.ts.
- AC-19: GIVEN a measure with no stored data (write duration, failures) WHEN the operator page renders THEN it reads "not instrumented", not 0. Test: planned, in the admin app.

**Visual acceptance** (team surface, before the implementation PR is called
done): screenshots via `/visual-review` at 390 and 1280 px, light and dark, of
every `?state=` fixture: `error`, `off-admin`, `off-member`, `enabled-empty`
(0), a 1–9 state, the 10 boundary, a 40-task state, one with a typical overrun,
one with a typical underrun, and one with the limited-history line. The fixture
list grows to cover each. Each shot shows one lead, its sample line, nothing
below the fold on a phone, and no chart. The operator surface is reviewed in
the admin app with its own table view.

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

- `packages/core/task-estimate-rollout.ts`: `TASK_ESTIMATES_GATE`, `evaluateTaskEstimatesGate`, `TASK_ESTIMATES_ROLLOUT`, `taskEstimatesDefaultOn`, `resolveTaskEstimatesState`
- `packages/core/task-estimate-source.ts`: `loadTaskEstimatesState`, `taskEstimatesEnabled`, `writeTaskEstimate`
- `packages/core/scripts/estimate-backtest.ts`: prints the gate
- `apps/web/src/app/api/teams/[id]/route.ts`: PATCH `taskEstimates`
- `apps/web/src/app/api/teams/[id]/task-estimates/route.ts`: readout with `enabled`, `source`, `defaultOn`
- `apps/web/src/app/app/(protected)/settings/features/`: the team switch
- `apps/web/src/app/app/(protected)/health/estimates/`: the team accuracy line, off and error states
- `packages/core/task-estimate-accuracy.ts`: `computeTaskEstimateReadout`, the one scorer both surfaces read
- `packages/core/task-estimate-accuracy-source.ts`: `fetchLiveEstimateRows`, `READOUT_ROW_LIMIT`
- `packages/core/task-estimate-operator.ts`: `buildOperatorEstimatesReport`, `gateForVersion`, the operator projection
- `packages/core/task-estimate-operator-source.ts`: `fetchOperatorEstimateRows`, `fetchOperatorEstimateCounts`, `OPERATOR_ROW_LIMIT`
- `apps/web/src/app/api/admin/estimates/route.ts`: the operator API; `viewEstimates` in `apps/web/src/lib/admin/tenant-privacy.ts`
- `apps/web/src/lib/admin/owner-gate.ts`: `requirePlatformOwner`, the operator API's gate
- `apps/web/src/lib/task-time-row.ts`: rounding and the "rough" label
- `apps/web/src/lib/task-estimate-hook.ts`: the after-response write
