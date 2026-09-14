# Plan-first for account-authored missions

**Status:** Proposed
**Related:** `apps/web/src/app/api/missions/route.ts`, `apps/web/src/lib/mission-run.ts`,
`apps/web/src/lib/task-dependencies.ts` (`shouldAutoApprovePlan`/`resolveCompletedTask`),
`apps/web/src/lib/approve-plan.ts`, `apps/web/src/app/api/tasks/[id]/approve-plan/route.ts`,
`apps/web/src/app/api/tasks/[id]/reject-plan/route.ts`,
`apps/web/src/app/app/(protected)/tasks/[id]/PlanReviewPanel.tsx`,
`packages/shared/src/planning.ts`, `packages/core/mission-helpers.ts` (`validateGoalCriteria`),
`apps/web/src/lib/mission-invariants.ts`, `docs/design/mission-goal-criteria.md`,
PR #1771 (prior-work injection), task `ac3af231` (creation gate — sibling, not yet built)

## Problem

An account creates a mission via MCP or the dashboard. Today, when the mission is
`active` + heartbeat-enabled + `orchestrationMode: 'auto'` (the default for
MCP-created missions), `POST /api/missions` immediately calls
`runMission(mission.id, { manualRun: true })`
(`apps/web/src/app/api/missions/route.ts:421-428`). That creates a `mode: 'planning'`
task, the organizer decomposes it, and `resolveCompletedTask` auto-approves the
resulting plan into claimable child tasks the moment the planning task completes
(`apps/web/src/lib/task-dependencies.ts:151-172`, via `shouldAutoApprovePlan`) — no
human ever sees the breakdown before agents start claiming it.

On the missions an owner actually cares about, this is not trusted: per the
Subject/CBM/I-cluster evidence, owners hand-write entire task breakdowns within
~90 seconds of mission creation — i.e. they are *replacing* the organizer's first
pass, not correcting individual tasks in it. Meanwhile organizer-only missions
(nobody intervenes) run at 0% human correction, which reads as either "the
organizer is trustworthy" or "nobody is watching closely enough to correct it" —
the current design cannot distinguish the two, because by the time anyone looks,
the tasks are already claimable and possibly already claimed.

`approve_plan` / `reject_plan` already exist end to end (MCP actions in
`packages/core/mcp-tools.ts`, routes above, `shouldAutoApprovePlan`'s
`context.requiresPlanApproval` escape hatch in `task-dependencies.ts:106-113`) —
but nothing in the codebase ever sets `requiresPlanApproval`. The gate is wired
and dead.

## Proposal

**Crux:** flip the default for a mission's *first* organizer cycle only, by
setting `context.requiresPlanApproval: true` on the planning task that
`runMission` creates from `POST /api/missions`'s auto-start block — nowhere
else. Get this one write wrong (e.g. put it on the recurring schedule's
`taskTemplate`, or gate it on the wrong caller) and either every heartbeat cycle
forever demands approval (mission stalls permanently) or nothing changes at all
(the feature ships as a no-op). Everything else in this doc is scaffolding
around that one flag.

### 1. Trigger

The gate applies to the mission's first-ever organizer cycle, and only that
cycle. Concretely: `runMission` is called from exactly three places
(`apps/web/src/lib/mission-run.ts` callers) — the create-time auto-start in
`POST /api/missions`, the manual "Run now" endpoint
(`POST /api/missions/[id]/run`), and nowhere in the recurring cron dispatcher
(`apps/web/src/app/api/cron/schedules/route.ts` creates heartbeat tasks
directly, comment at `mission-run.ts:279-283` confirms: "cron path creates
tasks directly (not via runMission)"). That already gives "recurring/heartbeat
missions keep today's behaviour" for free — the heartbeat engine never goes
through this code path, so there is nothing to gate.

What needs to change is narrower than "which endpoint called it": key the gate
on **mission has no prior planning task and no pre-filed tasks** (i.e.
`decompositionSkipped` is false and this is genuinely cycle 1), not on which of
the three call sites fired. A "Run now" click on a mission whose first plan was
already approved must not re-trigger the gate — the owner already exercised
their one review.

Opt-out: extend `orchestrationMode`'s TypeScript union in
`packages/core/db/schema.ts` from `'auto' | 'manual'` to
`'auto' | 'manual' | 'auto-dispatch'`. The column is `text('orchestration_mode')`
with a compile-time `$type<>` only — no DB `CHECK` constraint — so this needs no
migration, matching how the recent `orchestrationMode` doc changes were made.
`'auto-dispatch'` reproduces today's behaviour byte for byte (decompose and
auto-approve immediately); `'auto'` becomes "decompose, but gate the first
plan." `manage_missions` (`packages/core/mcp-tools.ts`) and the dashboard
create form both already accept `orchestrationMode` — only the accepted-value
set and the default-path behaviour change.

This is a deliberate exception to "defaults must be no-op": the whole point is
to flip the default for the dominant path (MCP/dashboard mission creation).
Existing missions are unaffected because they already have a stored
`orchestrationMode` and never re-run their first cycle.

### 2. Shape of the plan

No new task type or artifact kind. The existing `mode: 'planning'` task,
`result.structuredOutput`, and the `approve_plan`/`reject_plan` flow are reused
verbatim — that machinery already exists and already works
(`apps/web/src/lib/approve-plan.ts`). Two additions are needed to the contract
itself, both in `packages/shared/src/planning.ts`:

- `PlanStep.pathManifest?: string[]` (plus the matching `planningOutputSchema`
  property) — today a `PlanStep` has `dependsOn`, `baseBranch`, `roleSlug`,
  `requiredCapabilities`, `outputRequirement`, but no path manifest, so an
  approved plan's children are created without the conflict-serialization
  metadata `create_task` normally attaches.
- `PlanningStructuredOutput.goalCriteria?: GoalCriterion[]` — a mission-level
  (not per-step) field for the organizer's proposed completion gates. Reuses
  the `GoalCriterion` union already defined in `packages/shared/src/types.ts`
  for `manage_missions`. Feeds requirement 6.

`PlanReviewPanel.tsx` renders `dependsOn`/`requiredCapabilities`/`priority`
today; it needs the same treatment for `pathManifest` (badges, same style as
`requiredCapabilities`) and a new "Proposed goal criteria" block above the step
list.

### 3. Approval UX

**MCP:** `approve_plan` / `reject_plan` already are the one action from MCP —
nothing new needed for the base cycle.

**Dashboard:** `PlanReviewPanel` only renders on the planning task's own page
(`apps/web/src/app/app/(protected)/tasks/[id]/`) — one hop from the mission
page an owner is actually looking at. Surface it from mission detail too:
either link prominently to the organizer's planning task (`organizerTask.id`,
already returned by `POST /api/missions`) or embed `PlanReviewPanel` directly
on the mission page keyed off the mission's latest `mode: 'planning'` task.

**Inline edits — reject+revise, not a new primitive.** A plan is not a
first-class mutable record before approval; it is a JSON blob living in
`result.structuredOutput` on a *completed* task. Two ways to support
"rename/drop/add without a full round-trip" exist:

  (a) Let a client PATCH a completed task's `result` directly — rejected: it
  breaks the audit trail. "The agent produced this" would silently become
  "the agent produced this, then someone rewrote it," indistinguishable in the
  stored record.

  (b) A new intermediate mutable-plan table — rejected as disproportionate to
  the actual ask (rename/drop/add a handful of steps).

Instead, extend `POST /api/tasks/[id]/reject-plan`'s existing body with an
optional `editedPlan?: PlanStep[]` alongside the required `feedback`. When
present, the revised planning task
(`apps/web/src/app/api/tasks/[id]/reject-plan/route.ts:94-114`) is created
**already `status: 'completed'`** with `editedPlan` as its own
`result.structuredOutput.plan` — skipping a second LLM pass — so the reviewer's
edit is immediately approvable via the normal `approve_plan` call. Leaving
`editedPlan` unset keeps today's behaviour: a fresh pending planning task that
re-runs the organizer with `feedback` injected via `context.planFeedback`. This
reuses the existing `previousPlanTaskId` chain and rejection audit fields
(`existingContext.planRejection`) rather than adding a new endpoint or status.

### 4. Timeout: auto-dispatch after 24h, not indefinite hold

**Argue for auto-dispatch.** The worst case of timing out into auto-dispatch is
*exactly* today's pre-feature behaviour — the organizer's own plan runs
unreviewed, no worse than before this design existed. The worst case of staying
held forever is a mission that does nothing, silently, indefinitely — and the
cited evidence (19/21 question notes never closed) says that is the likely
outcome for a forgotten mission, not a tail case. A stalled mission is strictly
worse than an unreviewed-but-organizer-authored one, because the pre-feature
mission at least produces something for the owner to react to later.

**Mechanism — reuse the existing invariant sweep, don't add a new cron.**
`apps/web/src/lib/mission-invariants.ts` already has a
`plan_produced_no_children` invariant (2h threshold,
`PLAN_PRODUCED_NO_CHILDREN_MS`) that detects "planning task completed, plan has
steps, zero children" — but its remedy text conflates two different causes:
"the approval path could not act on it (unreadable shape, **or a human gate
nobody answered**)." Once this ships, the human-gate case becomes the *common*
one, not a bug, so it needs to split from the genuine-breakage case:

- Keep `plan_produced_no_children` (2h) scoped to
  `!context.requiresPlanApproval` — a plan with no gate that still produced no
  children is still a real bug (the auto-approve path threw, or the shape was
  rejected).
- Add a new invariant/threshold keyed on `context.requiresPlanApproval === true`,
  running in the same `apps/web/src/app/api/cron/mission-invariants/route.ts`
  sweep: post an escalating warning note at intermediate checkpoints (e.g. 4h,
  12h — reuse the `missionNotes` `type: 'question'`/`status: 'open'` shape the
  rejection/question flow already uses) and, at 24h, call
  `approvePlan(taskId, plan, { autoApproved: true })`. Stamp the resulting
  children's context (or a mission note) with the reason — e.g.
  `context.autoApprovedReason: 'timeout'` — so a timeout auto-dispatch is never
  silently indistinguishable from a real human approval in the mission feed or
  in `deriveTaskOrigin` (`apps/web/src/lib/task-origin.ts`).

24h is a starting point, not a load-bearing constant — see Open Questions.

### 5. Prior-work injection into the plan (PR #1771)

No new retrieval work needed — PR #1771 already made `buildMissionContext` /
`buildHeartbeatContext` inject the prior-work block (score, status, PR ref,
age, the ⚠ stale-baseline flag) on **every** decomposition pass, including a
mission's first cycle. The gap is presentational, not data: that block lives
in the planning task's `description` (organizer prompt input), and
`PlanReviewPanel.tsx` only ever reads `result.structuredOutput` — the panel
never shows the reviewer what the organizer actually saw. Fix: have the
plan-review surface (panel and/or mission-detail embed, see #3) also fetch and
render `task.description`, so an approver sees the same stale-baseline
warnings the organizer had in front of it, not just the plan the organizer
chose to write anyway.

### 6. Interaction with the creation gate (`ac3af231`)

`ac3af231` (sibling, not yet built) makes `manage_missions create`/`update`
and the dashboard mission form reject a mission with zero mechanical goal
criteria. This design's plan carries a *proposed* `goalCriteria` (see #2) that
becomes the mission's criteria only at approval time — so the same bar has to
apply there too, or a plan-gated mission could sail past `ac3af231`'s check by
attaching its criteria after creation instead of before.

Concretely: `POST /api/tasks/[id]/approve-plan` must, before calling
`approvePlan()`, validate `structuredOutput.goalCriteria` merged with any
criteria the mission already has, against whatever mechanical-criterion
predicate `ac3af231` introduces (it will extend `validateGoalCriteria`,
`packages/core/mission-helpers.ts:124-202`, which today checks shape but not
"at least one mechanical type"). On failure, refuse with the same 400 shape
`ac3af231` defines, naming the four accepted mechanical types. The organizer
prompt should get the same "suggest `all_prs_merged` + `no_open_tasks` as the
cheap default" guidance `ac3af231` gives human authors, so a plan doesn't
bounce on the very first approval attempt.

Sequencing: `ac3af231` should land first (or in the same batch) — this reuses
its predicate rather than defining a second one.

## Open questions

- **24h timeout duration.** Chosen because it's roughly "the owner checks back
  the next business day," but it's a guess, not derived from data the way the
  4h/12h escalation checkpoints could be tuned against actual response-time
  telemetry once this ships. Lean toward shipping 24h as a global constant
  first, make it a per-mission override later if real usage says otherwise —
  do not build a per-mission config knob before there's a signal it's needed.
- **`orchestrationMode: 'auto-dispatch'` vs. a request-level override.** A
  third enum value keeps "will this thing act on its own" answerable by
  reading one column, which matches how the field is already used elsewhere
  (dashboard chips, `docs/design/merge-policy.md` §6.1). The alternative —
  a bare `requirePlanApproval: false` passed at creation with no lasting
  record of it — is simpler to implement but throws away exactly the
  visibility that made `orchestrationMode` worth having in the first place.
  Leaning toward the enum.
- **A plan that both times out AND fails the mechanical-criterion gate.**
  Auto-dispatching a plan with zero mechanical criteria at the 24h mark just
  trades one deadlock for another (the mission would still be blocked from
  completing later, per `ac3af231`). Leaning toward: timeout auto-dispatch
  still runs the gate from #6, and a plan that fails it at the 24h mark
  escalates as a distinct, more urgent note ("stuck: this plan cannot proceed
  without a human, it doesn't meet the mechanical bar") rather than silently
  staying in the same held state as a plan that's merely waiting on attention.

## Implementation sketch

1. **Load-bearing:** `orchestrationMode` union + `runMission`/`POST /api/missions`
   wiring to set `context.requiresPlanApproval: true` on a mission's first
   planning task only. Everything else is inert without this.
2. `PlanStep.pathManifest` + `PlanningStructuredOutput.goalCriteria` additions
   in `packages/shared/src/planning.ts` (and the schema the SDK enforces).
3. `approve-plan` route: mechanical-criterion gate against
   `structuredOutput.goalCriteria` (depends on `ac3af231`'s predicate landing
   first).
4. `reject-plan` route: `editedPlan` fast-path.
5. `PlanReviewPanel.tsx` + mission-detail surfacing: render `pathManifest` and
   proposed criteria, render the planning task's `description` (prior-work
   block), link from the mission page.
6. `mission-invariants.ts`: split `plan_produced_no_children`, add the
   timeout-to-auto-dispatch invariant with escalation checkpoints.
7. Update `docs/design/mission-goal-criteria.md` to cross-reference this
   document; flip this doc's `Status` to `Implemented` once shipped.

## Non-goals

- Changing decomposition quality, or how the organizer decides what to plan.
- Multi-approver flows — one approve/reject action, one actor, as today.
- Backfilling `orchestrationMode` on existing missions or schedules.
- Changing per-cycle heartbeat behaviour for missions already past their first
  organizer cycle — `decompositionSkipped`, coordinate-only mode, and the
  retrigger loop are all untouched.
- The mechanical-criterion *grading* logic itself — owned by `ac3af231`; this
  design only calls it from a second location (plan approval).
