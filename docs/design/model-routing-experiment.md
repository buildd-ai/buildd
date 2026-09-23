---
status: partially
# The engine (schema, claim-time draw, readout core) is built and off by
# default. The operator surfaces (REST + MCP `manage_experiments`, the
# /app/health readout) are the remaining deliverable; the route assertion
# below tracks them and fails until they land.
assertions:
  - id: "experiments-registry"
    type: "symbol"
    name: "experimentAssignments"
    path: "packages/core/db/schema.ts"
  - id: "claim-time-draw"
    type: "symbol"
    name: "drawModelRoutingArm"
    path: "packages/core/model-routing-experiment-source.ts"
  - id: "readout-core"
    type: "symbol"
    name: "computeExperimentReadout"
    path: "packages/core/experiment-readout.ts"
  - id: "experiments-api"
    type: "route"
    method: "GET"
    path: "/api/experiments"
    file: "apps/web/src/app/api/experiments/route.ts"
---

# Model-Routing Experiment

**Status:** Partially implemented — engine shipped, off by default; operator surfaces pending.
**Related:** `packages/core/model-routing-experiment.ts`, `packages/core/model-routing-experiment-source.ts`, `packages/core/experiment-readout.ts`, `packages/core/experiment-readout-source.ts`, `packages/core/experiment-randomizer.ts`, `apps/web/src/app/api/workers/claim/route.ts`, `packages/core/model-router.ts`, `packages/core/model-tier-registry.ts`, `packages/core/model-capability-requirements.ts`, `packages/core/oauth-budget.ts`, `packages/core/routing-analytics.ts`, `packages/core/db/schema.ts` (`experiments`, `experimentAssignments`, `taskOutcomes`), `docs/design/experiment-lifecycle.md`

## Problem

The router sends most work to the `standard` tier and reserves `premium` for
what the kind/complexity matrix calls hard. Whether that split is right is not
known. `task_outcomes` records what the router picked and whether the task
completed, but every row is observational: tasks the router sends to
`premium` are the ones it already judged harder, so comparing the two tiers'
completion rates measures task difficulty as much as model quality. The
routing-calibration cron that was meant to close this loop is disabled and
stores nothing.

Two properties of the current system make a naive comparison actively
misleading, not just noisy:

- **Tasks cluster in missions.** A mission's tasks share a plan, a branch and
  a reviewer. Randomising tasks independently would put both models inside one
  mission, where one arm's work shapes the other's.
- **Premium work moves other tasks' models.** OAuth budget pacing weighs usage
  by model; with the premium weight stale (it described a generation where
  premium cost several times what it does now), premium work reads as far more
  window than it uses and pushes *other* tasks into budget downshift. An
  experiment arm would then change the control arm's routing.

## Proposal

Randomise eligible work between the tier the router chose (`control`) and the
`premium` tier (`treatment`), at claim time, and read the result as a
difference in clean-completion rate with an honest interval.

**The crux: eligibility is judged on the router's own output, before the
draw, and nothing after the draw may change which tasks reach an arm.** If
that is wrong the comparison is between two different populations and no
amount of analysis recovers it. Concretely:

- The draw sits immediately after `resolveEffectiveModel` and before tier
  resolution and the client-capability gate.
- A task is eligible only if the router took its plain `baseline` path to the
  `standard` tier on the Claude backend, with no explicit model, no task tier,
  no role model pin (`null` or `inherit`), class `work`, kind not
  `observation`, not a reviewer task, and budget pressure below a configured
  cap (default one half). Every exclusion is a pin or a downshift the
  experiment must not override.
- If the treatment model needs a newer Claude Code client than the runner has,
  the task runs the control model and the row records `served = false`. It is
  never deferred: deferral would remove exactly the treatment tasks that landed
  on old runners, a selection effect on the arm.
- Analysis is intent-to-treat — grouped by assigned arm, never by served model.

### Unit and inheritance

The unit is the mission when the task has one, else the task, hashed through
the existing `assignExperimentArm` (salted with experiment id and policy
version). Attempt tasks — CI retries, conflict retries, reviewer-requested
rework, all `taskClass: 'attempt'` with a `parentTaskId` — inherit the
parent's arm from its assignment row and are never redrawn; a treatment task's
fix must not run on the control model and be credited to it. A re-claimed task
reuses its own row without re-judging eligibility, because the first claim
writes the served model into `context.model` and a re-claim would otherwise
read as pinned. Reviewer tasks are never enrolled, so the reviewer model is
held fixed across arms.

### Data

- `experiments` — one row per experiment per team: key, title, hypothesis,
  `status` (`draft | running | paused | concluded`), `kind`
  (`model_routing`), `treatmentFraction`, `policyVersion`, `config` jsonb
  (treatment tier, eligibility cap, minimum sample per arm), `visibility`
  (`admins | team`), decision, timestamps.
- `experiment_assignments` — one row per (experiment, task): unit type and id,
  arm, propensity, policy version, the counterfactual `defaultModel`, the
  `assignedModel`, `served`, an eligibility snapshot (budget pressure, kind,
  complexity, role, inheritance source, capability fallback) and the runner's
  CLI version. Unique on (experiment, task).
- `task_outcomes` gains nullable `exit_cause` and `worker_id`, so the readout
  can separate platform failures from model-attributable ones.

### Readout

`computeExperimentReadout` reports, per arm: assigned, resolved and pending
counts; the clean-completion rate with a Wilson interval; the treatment −
control difference with a Newcombe interval; served rate; and secondary
metrics (first pass through review, rework rounds, turns, tokens by
input/output/cache read/cache write, model-attributable failure rate). It
stratifies by unit type and by whether the task stated a kind.

*Clean completion* = task completed, no CI retry dispatched, and either no PR
or a merged PR. A completed task with an open PR is pending, not a failure.

Verdicts: `insufficient_n` below the minimum resolved sample in either arm;
otherwise `treatment_better` / `treatment_worse` when the difference interval
excludes zero, else `no_detectable_difference`.

### Pacing weight

`MODEL_WEIGHTS` moves to published list-price ratios between the tier
registry's default models (premium 2.5×, budget 0.5× standard), with the
basis and the interference risk documented at the constant.

### Safety property

Nothing enrolls until an `experiments` row with `status = 'running'` exists;
with none, the claim route's behaviour is unchanged. Every experiment code
path catches and logs: an error means "run as routed", never a failed or
deferred claim. The running-experiment lookup is cached per team for a minute,
so a claim burst costs one query per team per minute, and pausing takes effect
within that minute.

## Open questions

- **Interval under clustering.** Mission units correlate their tasks, so a
  task-level interval is too narrow. The per-unit-type strata make this
  visible; a cluster-robust interval (or a mission-level primary metric) is
  the better answer. Leaning: add it before the first decision is recorded.
- **Guardrail auto-pause.** The intended guardrail pauses a running experiment
  when budget-exhaustion episodes rise or the treatment capability-fallback
  rate is high. Leaning: a check in a readout cron, not in the claim path.
- **`exit_cause` taxonomy.** `code_failure` is the catch-all today, so
  model-attributable failure is an upper bound. Splitting it is separate work.
- **Attempt cost.** Inherited attempt rows are excluded from the unit count,
  so their turns and tokens are not folded into the parent's secondary
  metrics yet. Leaning: sum them onto the parent in the readout.
- **Unit-change on pacing weights.** Budget episodes store weighted totals in
  the units in effect when recorded, so capacity learned before the weight
  change is in the old units until those episodes age out.

## Non-goals

- Switching a running session's model (the SDK's `setModel`) — out of scope.
- Fixing requeued tasks keeping a stale `context.model` — separate work; the
  draw takes the claim route's own explicit-model value so it follows that fix.
- Operator surfaces (REST, MCP, dashboard) — built on this schema separately.
- The generic lifecycle in `docs/design/experiment-lifecycle.md` (declared →
  enrolling → frozen → retired, pin manifests, stopping rules).
