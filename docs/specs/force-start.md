---
title: Force Start Past a Coordination Wait
status: active
owner: max
last_verified: 2026-10-24
summary: A dashboard Start MUST name the real waiting reasons, and Force start MUST lift exactly the confirmed forceable ones through one audited, single-use intent a runner's claim honours. Start anyway is the same intent over a declared dependency: it admits the task's agent for assessment and keeps the edge (Living Spec 36df686b).
domain: tasks
surfaces: [apps/web/src/app/api/tasks/[id]/start/route.ts, packages/core/waiting-reason.ts, apps/web/src/lib/force-start.ts, apps/web/src/lib/coordination-probe.ts]
related: [claim-ordering, mission-task-lifecycle, orchestration-decisions-shadow]
keywords: [run now, force start, forceStart, forceStartHistory, reasons_changed, reasonsDigest, coordination_hold, WaitingReason, inferred dependency, migration slot, human_force_start]
verified_by: [apps/web/src/app/api/tasks/[id]/start/start-anyway.test.ts, apps/web/src/lib/force-start-assess.test.ts, apps/web/src/app/api/workers/claim/start-anyway-gate.test.ts, packages/core/__tests__/start-anyway.test.ts, packages/core/__tests__/start-anyway-waiting-reason.test.ts, packages/core/__tests__/start-anyway-queue.test.ts, apps/web/src/lib/start-anyway.test.ts, apps/web/src/lib/task-wait-exit.test.ts, apps/web/tests/db/start-anyway-gate.test.ts, apps/runner/__tests__/unit/start-anyway-prompt.test.ts, apps/web/src/app/api/tasks/[id]/start/route.test.ts, apps/web/src/lib/force-start.test.ts, apps/web/src/lib/coordination-probe.test.ts, packages/core/__tests__/waiting-reason.test.ts, apps/web/src/app/api/workers/claim/route.test.ts, apps/web/src/app/api/workers/claim/deps-gate.test.ts, apps/web/src/app/app/(protected)/missions/[id]/TaskActionZone.coordination.dom.test.tsx, packages/core/__tests__/start-outcome-grade.test.ts]
assertions:
  - id: start-route
    type: route
    method: POST
    path: /api/tasks/[id]/start
    file: apps/web/src/app/api/tasks/[id]/start/route.ts
  - id: waiting-reason-model
    type: symbol
    name: WAITING_KIND_SPEC
    path: packages/core/waiting-reason.ts
  - id: reasons-digest
    type: symbol
    name: waitingReasonsDigest
    path: packages/core/waiting-reason.ts
  - id: start-reads-probe
    type: symbol_reachable
    symbol: probeCoordination
    entry: apps/web/src/app/api/tasks/[id]/start/route.ts
  - id: claim-consumes-intent
    type: symbol_reachable
    symbol: consumeForceStart
    entry: apps/web/src/app/api/workers/claim/route.ts
  - id: claim-records-force
    type: symbol_reachable
    symbol: recordForceStartClaim
    entry: apps/web/src/app/api/workers/claim/route.ts
  - id: start-route-tests
    type: test_file
    path: apps/web/src/app/api/tasks/[id]/start/route.test.ts
  - id: force-start-tests
    type: test_file
    path: apps/web/src/lib/force-start.test.ts
---

# Force Start Past a Coordination Wait

**Capability statement**: When a person starts a pending task, `POST /api/tasks/[id]/start`
evaluates the canonical `WaitingReason[]` the next claim would hold the task on, and refuses
with them instead of reporting an optimistic start. A person may then Force start past the
forceable ones in one press; the server records an audited, single-use, expiring intent that
the next runner's ordinary claim honours for exactly those gates, and every other rail stays
enforced.

## Waiting reasons

One model, `packages/core/waiting-reason.ts` (`WaitingReason`, `WAITING_KIND_SPEC`). One
producer, `lib/coordination-probe.ts`, read by `/start` and `GET /api/tasks/[id]/waiting`:

| Source | Kind(s) | Forceable (human) | How it is lifted |
|---|---|---|---|
| open PR / live path lease overlapping the manifest | `pr_overlap_live`, `pr_overlap_ended`, `lease_overlap` | yes | claim-loop key `path_overlap` |
| creation-time overlap edge (`pathDeclaration.inferredDependsOn`, incl. migration overlap) | `dep_inferred` | yes | dependency-gate arm: `context.forceStart.liftDependsOn` |
| soft overlap (`pathDeclaration.softOverlaps`): migration / hard surface | `serialized_surface` | yes | claim-loop key `soft_overlap` |
| soft overlap: same file / prefix, last verdict HOLD | `soft_overlap` | yes | claim-loop key `soft_overlap` |
| mission concurrency cap / pacing | `mission_concurrent`, `mission_paced` | yes | claim-loop keys |
| planner order | `ordered_behind` (soft) | yes (human only) | claim planner off for the task |
| local-session mission | `mission_local` | yes | `bypassHeldGate` (the claim's local prefilter) |
| declared `dependsOn` | `dep_declared` | yes: **Start anyway** (below) | `context.forceStart.assessDependsOn`, admitted by the dependency gate's `assess_start` arm; the edge is kept |
| capability, budget pause, seats, provider, task hold, unknown | various | **never** | the blocker's own fix action |
| session reservation (`context.reservedBy`) | none: a claim exclusion `task_reserved`, not a `WaitingKind` | **never** | the reserving session claims or releases it, or it lapses |

Dependency edges and soft overlaps are fed from what `explain` already reports
(`loadTaskCoordinationHolds` → `buildCoordinationHolds`); whether an edge still holds is the
claim's own per-edge SQL predicate (`dependencySatisfied`).

**Invariants**:

- `/start` never returns `started: true` while a hard `WaitingReason` holds the task, unless
  that request is a confirmed Force start over it (or the legacy `forceOverride` lifts a
  policy gate it names).
- Force is offered only when every hard reason is forceable. One non-forceable reason
  (capability, seat, budget pause, provider, task hold, unknown) means
  no Force start anywhere; the surface shows that blocker's fix instead.
- A declared `dependsOn` edge is never deleted or marked satisfied. Start anyway admits one
  claim for assessment; the inferred-edge arm (`liftDependsOn`) still requires the id to be in
  `pathDeclaration.inferredDependsOn`.
- Forcing an inferred or migration overlap changes claim order only. The edit-time path lease
  (including the migration anchor) still applies, so migration numbering stays serialized.
- The admin MCP `claim_task {force: true}` keeps its own gate set.
- Declaring no files is not a waiting reason, so there is nothing to force for it
  (`claim-overlap-scheduling` I-46). The retired `scope_undeclared_mutex` kind stays in
  the model only so older recorded reasons still render.
- Declared dependencies and coordination-only holds are counted apart in every headline:
  incidental overlap ordering reads "Waiting on migration slot · N tasks also editing {area}",
  never "waiting on N dependencies".

## Start anyway (declared dependencies)

Successor contract: Living Spec `36df686b` "Start anyway: assess, coordinate and continue"
(built ahead of browser approval against revision 1), and Health › Queue `4bc3e70e` R-20 /
AC-13. It replaces the old rule that a declared dependency prevents every form of progress.
It is the same `POST /start { force }` path and the same `context.forceStart` intent, with
kind `dep_declared`:

- **Intent.** `forceStart.assessDependsOn` names the declared edges the person started past.
  It lives 7 days (`START_ANYWAY_INTENT_TTL_MS`), not 15 minutes, so a runner that is offline
  or missed the wake still finds it. A repeated click with an unexpired intent that already
  names every holding edge returns 200 with the same `forceId` and writes no second record.
- **Gate.** `deps-gate.ts` arm `assess_start` admits an edge only while an unexpired intent
  names it. There is no whole-task bypass: `bypassDepsGate` is no longer written or read, and
  `forceOverride` over a dependency writes this bounded intent instead. Ordinary automatic
  claims still wait; the edge and the upstream task are never changed.
- **Claim.** The claim consumes the intent once into `forceStartHistory` and stores
  `context.startAnywayAssessment`: the assessment instruction with each prerequisite's task,
  worker and PR state as of the claim. The runner prompt carries it (`start-anyway` section).
- **Assess, coordinate, work or park.** The agent records its assessment with `update_progress`
  before editing, messages the running upstream agent once through `send_worker_message`, and
  either works within its own path ownership or parks with `complete_task { blockedOnTaskId }`
  (the wait exit, `lib/task-wait-exit.ts`). For a task started this way the workspace
  `waitOnTask` flag does not gate the park; a merged or cancelled prerequisite is refused (the
  recheck that stops a race stranding it), a cycle is refused, and at most
  `START_ANYWAY_MAX_PARKS` parks are allowed so a dead prerequisite cannot loop. The park
  returns the same task to `pending`, keeps its branch (`requeueBranchContext`), completes the
  worker (no executing slot) and releases its path claims.
- **Resume.** The existing dependency wake (`dependency.satisfied`, outbox) runs the same task
  when the prerequisite merges; the next attempt's prompt carries the saved assessment
  (`resumeInstruction`).
- **Observed state.** `startAnywayView` derives requested / assessing / blocked from the row's
  own facts; `GET /api/tasks/[id]/waiting` returns it as `startAnyway`, so the task page, the
  sheet and the Queue read one cause. A request is never rendered as running before its claim.
- **Queue.** `queueRowAction`: Declared rows offer Start anyway, Limit rows keep Force start,
  Lane rows admit assessment but grant no lane ownership, a real restriction names its fix.
- **Not authorised by the start.** Edit-time path leases, migration serialization, existing
  data-preservation preconditions, credentials, release, merge and destructive work.

## Request contract

`POST /api/tasks/[id]/start` with:

```json
{ "force": { "kinds": ["dep_inferred", "mission_local"], "reasonsDigest": "…", "note": "optional" } }
```

Server steps:

1. Recompute the reasons (the probe).
2. `reasonsDigest` differs from the fresh one → **409** `gateReason: "reasons_changed"`,
   `reasonsChanged: true`, with the fresh reasons. A person never confirms a gate they did
   not see.
3. A kind not listed, or not forceable → **422** with `rejectedKinds`.
4. Write `context.forceStart = { id, at, expiresAt (+15 min), userId, accountId, kinds,
   loopKeys, prefilterLifts, liftDependsOn?, reasonsDigest, blockers }`; a forced local
   mission also writes `bypassHeldGate`.
5. Record the request (below), then wake the task. This route creates no worker and makes no
   claim.

`forceCoordination: { reasonsDigest }` is the earlier name; it forces every forceable kind.

**Claim.** `bypassOrDefer(key)` bypasses when `key ∈ context.forceStart.loopKeys` and the intent
has not expired. The claim consumes the intent into `context.forceStartHistory` (capped), so it
is single-use; an expired intent lifts nothing and is dropped.

## Confirmation (every surface)

Shown by `CoordinationRefusal` in `TaskActionZone`, so the task page, the task sheet, the
mission strip drawer and the Activity card's blocked panel render the same thing:

> **Force start “{title}”?**
> **Skips:** {gate}: {blocker sentence} — a pre-checked checklist when more than one gate.
> **Still enforced:** files another agent is editing stay locked ({n} files in {areas}) ·
> declared dependencies · budgets, seats and plan limits · runner capability · task holds.
> **Risk:** {areas} overlap · {basis}.
> *(migration overlap)* Migration numbering stays serialized; this agent can't take the next
> index until {holder} releases it.
> This start and how it lands are recorded and used to tune automatic holds.
> [Force start] [Keep waiting]

## Recording

Per force, three records:

- **(a) `gate_events`**: gate `claim_loop_deferral`, outcome `bypassed`, reason
  `force_start`, once at request (`phase: requested`) and once at claim
  (`phase: claimed`, with what the claim lifted).
- **(b) one `orchestration_decisions` row** at claim (`recordOverrideStart`, reusable for any
  override START): capability `orchestration_claim`, decision_id `buildd.human_force_start`,
  mode `live`, rule_verdict `HOLD`, effective `START`, applied `true`, experiment_arm
  `human`, candidate_policy_version `hf1.<primary kind>`, receipt with the force id, kinds,
  lifted gates, blockers (liveness, areas, basis, overlap kind, capped shared paths), digest
  and time waited. `propensity` is 1 because the column is NOT NULL.
- **(c) `context.forceStartHistory`**: the consumed intent plus `claimedAt` and `bypassed`,
  rendered on the task page as "Force-started by {you | a teammate} at {T} · skipped: …".

A start whose blockers cleared by themselves writes none of these.

## Outcome labels

`labelDecisionOutcomes` grades the human row through the existing join; `gradeStart`
(`packages/core/orchestration-outcomes.ts`) maps it to the shared vocabulary used for Jev
STARTs: `clean`, `edit_collision`, `merge_conflict` (= repair task), `base_refusal`,
`censored`, `missing`; rollback has no source yet and stays `missing`. A `human_force` grade
is `scored: false`: observational evidence, never a model error or success.

**Acceptance criteria**:

- AC-1: GIVEN an idle runner and a pending task whose manifest overlaps an open PR WHEN
  `/start` is called THEN it returns 422 `coordination_hold` naming the PR, and nothing is
  stamped or woken.
- AC-2: GIVEN that refusal WHEN `/start` is called with `force {kinds, reasonsDigest}` THEN it
  returns 200 with `forced`, writes `context.forceStart`, fires one `force_start` gate event,
  and the next runner claim takes the task past `path_overlap` and consumes the intent.
- AC-3: GIVEN a stale `reasonsDigest` WHEN `/start` is forced THEN it returns 409
  `reasons_changed` with the fresh reasons.
- AC-4: GIVEN a local mission task held only by inferred migration edges WHEN one Force start
  confirms all listed kinds THEN `forceStart.liftDependsOn` names every edge,
  `prefilterLifts` is `[inferred_deps, local_mission]`, and the refusal carried the
  migration red line.
- AC-5: GIVEN a declared dependency or a capability reason in the set THEN `canForce` is false
  and a forced request returns 422.
- AC-6: GIVEN a blocker that clears before the person acts WHEN `/start` is called THEN the
  task starts with no force records.
- AC-7: GIVEN a consumed force THEN exactly one gate event at request, one at claim and one
  `buildd.human_force_start` decision row exist.
- AC-8: GIVEN a pending task with an unfinished declared dependency WHEN its authorized person
  confirms Start anyway THEN `forceStart.assessDependsOn` names the edge, the edge and the
  upstream are unchanged, and the next claim admits the task for assessment (Living Spec
  `36df686b` AC-8).
- AC-9: GIVEN an assessing task WHEN nothing useful can proceed THEN `complete_task
  { blockedOnTaskId }` parks the same task (pending, branch kept, no executing slot), and the
  existing dependency wake resumes it when the prerequisite merges.

**Code surface**:

- Route: `apps/web/src/app/api/tasks/[id]/start/route.ts` (`POST`), `apps/web/src/app/api/tasks/[id]/waiting/route.ts` (`GET`)
- Model: `packages/core/waiting-reason.ts` (`WAITING_KIND_SPEC`, `coordinationHoldBody`, `forceDialog`, `waitingSummary`, `readForceStart`)
- Probe: `apps/web/src/lib/coordination-probe.ts` (`probeCoordination`), `apps/web/src/app/api/workers/claim/coordination-gates.ts`
- Claim: `apps/web/src/app/api/workers/claim/route.ts` (`bypassOrDefer`, `liftedByForce`), `apps/web/src/app/api/workers/claim/deps-gate.ts` (`forceStartLiftsEdge`)
- Recording: `apps/web/src/lib/force-start.ts` (`recordForceStartRequest`, `recordForceStartClaim`, `recordOverrideStart`), `packages/core/orchestration-outcomes.ts` (`gradeStart`, `startActorOf`)
- UI: `apps/web/src/app/app/(protected)/missions/[id]/TaskActionZone.tsx` (`CoordinationRefusal`), `apps/web/src/components/tasks/WaitingLine.tsx`
