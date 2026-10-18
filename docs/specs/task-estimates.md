---
title: Task Estimates (Availability and Calibration)
status: active
owner: max
last_verified: 2026-10-17
summary: Eligible teams receive frozen evidence-aware forecasts by default; calibration gates numeric confidence, team health stays compact, and forecasts never order work.
domain: tasks
surfaces: [packages/core/task-estimate-rollout.ts, packages/core/task-estimate-source.ts, apps/web/src/app/app/(protected)/settings/features/page.tsx, apps/web/src/app/app/(protected)/health/estimates/page.tsx]
related: [claim-ordering, bug-intake-and-quality]
keywords: [task_estimates, taskEstimates, estimates-backtest, blend-v2, p50, p80, new-repo prior, cold start, default on, indicative, TASK_ESTIMATES_ROLLOUT, estimate accuracy, within upper estimate, insufficient evidence, operator estimation, calibration]
verified_by: [packages/core/__tests__/task-estimate-display.test.ts, packages/core/__tests__/task-estimate-evidence.test.ts, packages/core/__tests__/task-estimate-rollout.test.ts, packages/core/__tests__/task-estimate-source.test.ts, apps/web/src/app/api/teams/[id]/route.test.ts, apps/web/src/app/api/teams/[id]/task-estimates/route.test.ts, apps/web/src/app/app/(protected)/health/estimates/EstimatesOff.test.tsx, apps/web/src/app/app/(protected)/health/estimates/EstimatesClient.test.tsx, apps/web/src/app/app/(protected)/health/estimates/estimates-view.test.ts, apps/web/src/lib/task-time-row.test.ts, packages/core/__tests__/task-estimate-operator.test.ts, apps/web/src/app/api/admin/platform-owner-routes.test.ts, apps/web/src/app/api/admin/tenant-privacy.test.ts]
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
  - id: "health-page-reads-state"
    type: "symbol_reachable"
    symbol: "loadTaskEstimatesState"
    entry: "apps/web/src/app/app/(protected)/health/estimates/page.tsx"
    as: "call"
  - id: "rollout-tests"
    type: "test_file"
    path: "packages/core/__tests__/task-estimate-rollout.test.ts"
---

## Task Estimates (Availability and Calibration)

**Capability statement**: Every eligible team's new work task receives one frozen
estimate after the creation response, without a Settings › Features switch.
Availability is separate from calibration: unknown or failed calibration permits
only an explicitly indicative rounded range, or no numeric forecast when evidence
is insufficient. A team sees compact coverage, typical actual/p50 and cohort size;
the platform owner sees version-specific calibration and model comparisons.

**Invariants**:

- Eligible means an existing team resolved successfully for a work task. Legacy
  explicit `task_estimates: { enabled: false }` remains an operational opt-out
  through the existing authorized team PATCH API; NULL/malformed choices default
  on regardless of calibration. A failed team
  read fails closed; a page shows a load error rather than an off state.
- `TASK_ESTIMATES_ROLLOUT` certifies only its named estimator version. A new
  version remains uncalibrated until measured; default availability MUST NOT
  manufacture a passing verdict or change the quality bars below.
- Settings › Features is removed from navigation; its former URL redirects to
  Health › Estimates. Health contains no settings-management action or instruction
  to ask an owner to enable estimates. Authorized owner/admin PATCH remains an
  operational escape hatch; it does not certify calibration.
- Forecast quantiles and evidence are insert-only, one per (task, estimator
  version), with `tasks.createdAt` as the information cutoff. A later completion
  adds actuals alongside the forecast and never overwrites it. A deliberate
  re-estimate uses a new version; rollback retains earlier rows.
- The write runs after the response and never throws. Missing history, missing
  sources or an estimator error never fail task creation or a claim.
- Estimates are forecasts for people. The claim route, scheduler and mission
  planner never use forecasts or calibration as inputs to ordering or capacity.
  The Missions Plan numeric readout and its link remain behind the running
  version calibration gate as well as team availability; default-on collection
  must not expose uncalibrated mission completion dates.

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

**Verified calibration state (2026-10-17)**: the checked-in pin remains no-go
for `blend-v1`; running `blend-v2` is unknown, not certified by the earlier pin.
The prior aggregation fix shipped after the earlier measurement; the recorded
prior task outcome explicitly says its production backtest was not rerun. No
new passing measurement is asserted here. Default availability therefore uses
the evidence/display safety contract, not a calibrated precision claim.

### Who sees what

One scorer, two projections. Both read `computeTaskEstimateReadout` (which
scores with the backtest's `scoreRows`); neither keeps a second implementation
of "within p80" or "median actual/p50". The two audiences never share a page.

| | Team surface | Platform operator surface |
|---|---|---|
| Who | Every member of the team, owner/admin and member alike | The platform owner only |
| Where | Health › Estimates; the Time row on a task | The private admin app's Insights › Estimation, reading a platform-owner API in this repo |
| Data | The team's own scored tasks, running estimator version | Every team, every estimator version, plus the backtest evidence |
| Shows | p80 coverage (80% target), actual/p50 ratio, sample and sparse-history note | Calibration by cohort, gate verdicts, runtime cost and coverage |
| Never shows | Gate verdicts or figures, other teams, sources, clusters, tokens, charts | Another team's written strings (see operator API) |

A team owner/admin sees the same numbers and actions as a member; neither sees
settings management or operator detail.

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

A compact team readout carries coverage against the upper estimate (p80), its
80% target, median actual/p50 ratio and scored cohort size. Explain those terms
in plain language: the upper estimate is intended to contain 8 in 10 outcomes;
1.0x actual/typical means unbiased. The target is a reference, not a passing
verdict or a claim that indicative forecasts are calibrated.

| Scored n | Readout |
|---|---|
| 0 | Not enough finished tasks to assess estimates. No observed rate or ratio. |
| 1–9 | Same insufficient-evidence line and N finished so far. No observed rate or ratio. |
| 10 or more | Coverage percentage with 80% target, actual/p50 ratio (including 1.0x), and Across N finished tasks. |

- The cut-off is `MIN_SCORED_FOR_VERDICT` (10). Small samples show their size
  without observed rates. A weak result reads as its number without a quality badge.
- One muted sparse-history note says how many forecasts had limited comparable
  history in this repo; this is not a claim that the repo has no completed work.
- No chart, Details disclosure, breakdown table, tokens, model comparison or
  settings-management link appears on the team page.
- Load error, no team and 0 / 1–9 / 10+ scored remain distinct states. Legacy
  feature-disabled fixtures must not imply an owner needs to enable estimates.
- The task Time row retains its concise evidence-aware range and uncertainty
  explanation using the shared formatter (AC-6).

**Team API** (`/api/teams/[id]/task-estimates`): read by any member of the team
or that team's own API key, 404 for anyone else. It returns that team's
readout only. It MUST NOT carry the gate verdict, backtest figures, another
team's rows or runtime cost. Its existing per-team breakdowns stay for API
callers; the page does not render them.

### Platform operator surface: Insights › Estimation

For deciding whether the estimator is calibrated and a candidate is safe to
promote. Detailed by design; the team-surface copy rules on model terms do not
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
- `selection` contains own-team per-task frozen evidence, sources/weights and
  calibration status by estimator version. Other teams never contribute
  per-task diagnostics. Legacy records carry null evidence; the admin app can
  link an own-team task to its task page.
- The same small-sample rule and "each group carries n" as the quality
  metrics in `bug-intake-and-quality.md` §7. That module is not built yet;
  when it is, estimation stays its own section (it scores forecasts, not
  defects).

**Forecast policy**: `blend-v2` selection is available by default while its
calibration remains unknown. Availability never weakens display safety or the
version-specific gate. Forecasts never order work.

## Actuals, calibration and the improvement loop

**Verified mechanism**: completed workers' session durations and tokens already
influence future neighbour estimates, area-cluster quantiles and cross-workspace
aggregate priors through `loadEstimateInputs`. Prior and cluster models refresh
on cache expiry, and a cache is reused only when its training cutoff is no later
than the task cutoff. Completion also stores actuals alongside immutable forecasts;
the live readout calls the same scorer as the backtest.

This is historical retrieval and empirical distribution refresh. It is not
verified parameter calibration: `k0` resolves from an operator config/environment
or fallback; no completion hook fits it from forecast errors, and no scheduled
job promotes a newly calibrated version. The rollout pin is checked-in evidence,
not an automatically recomputed certification. Product copy MUST NOT call this
self-learning or promise that error falls merely because more work completes.

**Temporal evaluation contract**:

- At each replay task's creation cutoff, neighbours, whole completed sessions,
  size decisions, repair attempts, cluster inputs and prior aggregates must be
  known strictly before that cutoff. Exclude the forecast task itself and future
  work; never train from a partially completed task's truncated actuals.
- A held-out workspace must be excluded from training the cross-workspace prior,
  not merely have its local neighbour/cluster inputs blanked. The CLI passes
  `excludedPriorWorkspaceId` into the aggregate query and bypasses the global
  live prior cache for these reads. Earlier held-out runs without that exclusion
  are not certifiable; rerun before promoting any calibration pin.
- Historical retrieval currently uses today's vector/diff ingestion and task
  metadata; there is no historical index snapshot. Disclose this replay limitation;
  do not claim reconstruction is a leakage-free immutable creation-time forecast.
  Prospective frozen forecasts supply stronger evidence without reconstruction.
- Any candidate fitting uses an older training interval, a later validation
  interval and a final untouched temporal test interval. Fit neither parameters
  nor thresholds on the final test cohort. Compare incumbent, candidate,
  neighbours, clusters and prior on identical eligible cohorts; report version,
  cutoff, sample strength, exclusions, p50 ratio and p80 coverage.

**Closed-loop design, pending evidence**: accumulate actuals → compute
version-specific diagnostics → fit a candidate only on older data → time-based
and held-out validation → owner-reviewed promotion or rollback. Candidate
configuration must be immutable and tied to a new estimator version, training
cutoff, dataset/evidence reference and evaluation interval. Retain the incumbent
and all frozen forecasts. The missing pieces are error-driven candidate fitting,
promotion automation; strict held-out prior exclusion is now implemented, but
its production evaluation has not been rerun; this change
does not implement unsupported fitting or automatically claim improvement.
First establish a leakage-qualified baseline and sample sufficiency, then choose
and implement a fitting method only if the evidence supports it.

**Improvement trend** belongs in platform admin: per-version time cohorts with
sample n, p80 coverage (80% reference), median actual/p50 (1.0 reference), median
absolute log error, sparse-history share and exclusions. Compare models on paired
cohorts before describing improvement; differing tenant/work mix or sparse n is
not evidence of a better estimator. Existing live `byDay` and per-version scores
are descriptive, and do not prove parameter calibration or a passing backtest.

**Acceptance criteria**:

Each criterion names the test that holds it; "(planned)" marks one the
implementation tasks add.

- AC-1: GIVEN the gate is no-go or unknown WHEN an eligible team files a task THEN a frozen forecast may be written, but shared display remains indicative or nonnumeric. Test: packages/core/__tests__/task-estimate-rollout.test.ts, task-estimate-display.test.ts.
- AC-2: GIVEN the gate passes for the running version WHEN an eligible team files a task THEN one frozen estimate row is written without team opt-in. Test: task-estimate-rollout.test.ts, task-estimate-source.test.ts.
- AC-3: GIVEN NULL settings WHEN eligibility resolves successfully THEN estimates default on; GIVEN explicit false THEN no new estimate is written. Test: task-estimate-rollout.test.ts.
- AC-4: GIVEN any team member WHEN they open settings THEN no Features management item appears; its legacy URL redirects to Health › Estimates. Authorized PATCH taskEstimates remains an operational opt-out. Test: apps/web/src/lib/settings-nav.test.ts, apps/web/src/app/app/(protected)/settings/features/page.test.ts, apps/web/src/app/api/teams/[id]/route.test.ts.
- AC-5: GIVEN any team member WHEN Health › Estimates renders THEN it offers no settings-management link or instruction to enable estimates. Test: EstimatesClient.test.tsx.
- AC-6: GIVEN prior-only, sparse or uncalibrated evidence WHEN a task estimate renders THEN one shared formatter shows a broad outward-rounded indicative range, no minute-level point estimate and one uncertainty sentence. Headline and breakdown use identical range, units and estimator version. Test: packages/core/__tests__/task-estimate-display.test.ts, apps/web/src/lib/task-time-row.test.ts.
- AC-7: GIVEN the estimator throws or a source is unavailable WHEN a task is created THEN creation succeeds and the write returns `failed` or uses the remaining sources. Test: task-estimate-source.test.ts.
- AC-8: GIVEN any team WHEN Health › Estimates renders THEN only its own data appears and there is no rollout verdict or settings-management link. Test: EstimatesClient.test.tsx.
- AC-9: GIVEN 0 scored tasks WHEN Health › Estimates renders THEN it reads "Not enough finished tasks to assess estimates." with no count and no rate. GIVEN 1 or 9 THEN the same lead and "1 finished so far." / "9 finished so far.", no rate. Test: estimates-view.test.ts, EstimatesClient.test.tsx.
- AC-10: GIVEN at least 10 scored tasks WHEN the page renders THEN it shows observed p80 coverage with 80% target, median actual/p50 ratio and cohort n without an accuracy verdict. Test: estimates-view.test.ts.
- AC-11: GIVEN median actual/p50 values 1.0, 1.5 or 0.6 THEN the compact ratio is present for each, including unbiased 1.0x. Test: estimates-view.test.ts.
- AC-12: GIVEN any eligible team WHEN the page renders THEN it contains no chart, Details disclosure, breakdown table, tokens line or model comparison. Test: EstimatesClient.test.tsx.
- AC-13: GIVEN scored estimates of which some leaned mostly on the new-repo prior WHEN the page renders THEN one muted limited-comparable-history line shows the count and no rate; GIVEN none THEN no such line. Test: estimates-view.test.ts.
- AC-14: GIVEN a member and an owner of the same team WHEN each opens Health › Estimates THEN both see identical numbers and neither sees a settings-management link. Test: EstimatesClient.test.tsx.
- AC-15: GIVEN a caller who is not a member of team T and does not hold T's API key WHEN they GET T's task-estimates readout THEN the response is 404; GIVEN a member THEN the body holds T's rows only and no gate verdict or backtest figure. Test: apps/web/src/app/api/teams/[id]/task-estimates/route.test.ts.
- AC-16: GIVEN no credential, a team API key, a team owner's session or an unset allowlist WHEN they call the operator estimates API THEN 404; GIVEN the platform owner THEN 200. Test: apps/web/src/app/api/admin/platform-owner-routes.test.ts.
- AC-17: GIVEN the platform owner belongs to team A and not team B WHEN they read the operator estimates API THEN B's numbers are present and no string B wrote appears in the JSON. Test: apps/web/src/app/api/admin/tenant-privacy.test.ts.
- AC-18: GIVEN rows under two estimator versions WHEN the operator readout is built THEN each version is scored separately, and a version absent from `TASK_ESTIMATES_ROLLOUT` reads unknown. GIVEN a held-out (cold-start) run THEN its check shows its own n and result. Live figures never appear under a backtest check. Test: packages/core/__tests__/task-estimate-operator.test.ts.
- AC-19: GIVEN a measure with no stored data (write duration, failures) WHEN the operator page renders THEN it reads "not instrumented", not 0. Test: planned, in the admin app.

**Visual acceptance** (team surface, before the implementation PR is called
done): screenshots via `/visual-review` at 390 and 1280 px, light and dark, of
every `?state=` fixture: `error`, `enabled-empty`
(0), a 1–9 state, the 10 boundary, a 40-task state, one with a typical overrun,
one with a typical underrun, and one with the limited-history line. The fixture
list grows to cover each. Each shot keeps coverage, ratio, sample and sparse-history context readable on a
phone without horizontal scrolling, settings-management actions or a chart. The operator surface is reviewed in
the admin app with its own table view.

**Rollout and promotion**:

1. Deploy default availability with shared indicative/nonnumeric safety; leave
   the existing no-go pin unchanged. Check team and task fixtures at mobile and
   desktop widths and observe after-response write failures.
2. Before certifying a candidate, record recent temporal and strictly held-out
   backtest evidence, limitations and cohort counts in the private
   `estimates-backtest` artifact. Rerun the corrected held-out-prior exclusion
   before its cold-start result can count as a pass.
3. Promote only when every existing gate passes for the exact candidate version,
   with evidence reference and measured date. Never fill an unknown from a live
   aggregate or another estimator version's pin. Review per-version trends after
   promotion; a new candidate requires new evidence.

**Rollback**: set the version's verdict to `no_go` and deploy; forecasts return
to indicative/nonnumeric presentation while eligible teams retain availability.
Restore an earlier version only with its own evidence and keep all frozen rows.
A runtime outage fails open for task creation and closed for estimates. Full
removal: `packages/core/TASK-ESTIMATES-REMOVAL.md`.

**Code surface**:

- `packages/core/task-estimate-rollout.ts`: `TASK_ESTIMATES_GATE`, `evaluateTaskEstimatesGate`, `TASK_ESTIMATES_ROLLOUT`, `taskEstimatesDefaultOn`, `resolveTaskEstimatesState`
- `packages/core/task-estimate-source.ts`: `loadTaskEstimatesState`, `taskEstimatesEnabled`, `writeTaskEstimate`
- `packages/core/scripts/estimate-backtest.ts`: prints the gate
- `apps/web/src/app/api/teams/[id]/route.ts`: authorized operational PATCH `taskEstimates` opt-out
- `apps/web/src/app/api/teams/[id]/task-estimates/route.ts`: readout with `enabled`, `source`, `defaultOn`
- `apps/web/src/app/app/(protected)/settings/features/`: compatibility redirect to Health › Estimates
- `apps/web/src/app/app/(protected)/health/estimates/`: compact team calibration readout and error states
- `packages/core/task-estimate-accuracy.ts`: `computeTaskEstimateReadout`, the one scorer both surfaces read
- `packages/core/task-estimate-accuracy-source.ts`: `fetchLiveEstimateRows`, `READOUT_ROW_LIMIT`
- `packages/core/task-estimate-operator.ts`: `buildOperatorEstimatesReport`, `gateForVersion`, the operator projection
- `packages/core/task-estimate-operator-source.ts`: `fetchOperatorEstimateRows`, `fetchOperatorEstimateCounts`, `OPERATOR_ROW_LIMIT`
- `apps/web/src/app/api/admin/estimates/route.ts`: the operator API; `viewEstimates` in `apps/web/src/lib/admin/tenant-privacy.ts`
- `apps/web/src/lib/admin/owner-gate.ts`: `requirePlatformOwner`, the operator API's gate
- `apps/web/src/lib/task-time-row.ts`: shared estimate display alongside agent elapsed time
- `packages/shared/src/task-estimate.ts`: payload, evidence and shared formatting
- `packages/core/task-estimate-evidence.ts`: common selection eligibility and counts
- `apps/web/src/lib/task-estimate-hook.ts`: the after-response write

## Evidence and display contract

The frozen numeric quantiles remain internal forecast/scoring inputs. Selection
repairs use `blend-v2`; the `blend-v1` calibration pin does not certify it. Display
formatting is a versioned, shared projection of those quantiles and structured
evidence, used by the task page, task API and MCP scheduling view. Stored legacy
summary strings are not a second source of display truth.

| Evidence | Display and provenance |
| --- | --- |
| No usable source, invalid quantiles, fewer than three contributing samples, or a spread above 20x | No numeric forecast; say that there is insufficient comparable evidence. |
| Prior only, sparse local evidence, or calibration not passed for this version | About a broad range rounded outward in steps of at least five minutes; no point estimate. |
| At least ten local samples and passed calibration | A rounded range; preserve the same range in expanded detail. |
| Confirmed zero completed work tasks at cutoff | Similar tasks across Buildd; this repo has no completed work history at the forecast cutoff. |
| Existing completed tasks but few comparable samples | Similar tasks across Buildd; limited comparable history in this repo. |
| Legacy record, failed history query or unavailable local source | Say comparable evidence is unavailable; never infer zero history or a lack of matching work from a read failure. |

AC-20: The collapsed time row and expanded breakdown read one canonical display
payload, including range, units, formatting version and estimator version. A
stored stale summary cannot reintroduce a conflicting range or repeated caveat.
Tokens appear only in the breakdown, using compact units (for example 1.64M).
Test: packages/core/__tests__/task-estimate-display.test.ts and task-time-row.test.ts.

AC-21: Freeze evidence at task creation: total earlier repo tasks, completed work
tasks, eligible tasks with usable completed-session actuals, exclusions, retrieved
neighbours, contributing neighbours, available clusters, contributing cluster
sample count, source failures, sources/weights and actual cached model cutoffs
(which may precede the task cutoff by the model cache TTL). The current task
size decision is read at estimate freeze and labeled that way; the normalized
kind is also frozen so a later task edit cannot obscure a global prior fallback; historical
size decisions and repair attempts are bounded by the history cutoff. Diff
ingestion is read when evidence loads, not replayed from a historical index
snapshot, so a later reconstruction must disclose that limitation. Neighbour and cluster counts
can overlap and must not be added as a unique task count. No role, model or
recency filter is implied when none exists. Legacy diagnostics are unknown,
not retroactively reconstructed as if frozen. Test: task-estimate-source.test.ts.

AC-22: The existing operator estimates response exposes own-team selection
diagnostics alongside estimator version and calibration status; other tenants'
raw evidence and path labels remain excluded. Calibration means the existing
version-specific rollout gate, never a guessed confidence based on sample size.
The compact team Health contract shows coverage, ratio and cohort size; its
limited-history line says limited comparable history rather than inferring little
total history.
Test: task-estimate-operator.test.ts.

AC-23: Regression fixtures cover an established repo with eligible local history,
a true cold start, existing history with no comparable neighbours, sparse or
uncalibrated evidence, unavailable sources and legacy unknown diagnostics.
Test: task-estimate-display.test.ts and task-estimate-source.test.ts.

AC-24: GIVEN an existing frozen forecast WHEN its task completes or historical
models refresh THEN only actuals may be added and forecast quantiles/evidence
remain unchanged. GIVEN a later training cutoff WHEN replaying an earlier task
THEN the cache is not reused. Test: task-estimate-source.test.ts.

AC-25: GIVEN a held-out workspace WHEN building its prior for certification THEN
that workspace is excluded from the aggregate query and the global cache is
neither reused nor overwritten. Test: task-estimate-source.test.ts. Prior runs
without exclusion cannot promote the calibration pin.

AC-26 (planned, calibration follow-up): GIVEN a fitted candidate THEN validation
and final temporal test data are excluded from fitting. No candidate fitting or
automatic promotion is claimed until this is implemented and evaluated.

AC-27: GIVEN default-on availability and uncalibrated estimates WHEN opening
Missions THEN its Plan link is hidden and the Plan route loads no numeric
forecast. GIVEN calibrated estimates and an eligible team THEN Plan remains
available. Test: apps/web/src/app/app/(protected)/missions/plan/page.test.tsx.
