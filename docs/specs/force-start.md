---
title: Force Start Past a Coordination Wait
status: active
owner: max
last_verified: 2026-10-11
summary: A dashboard Start MUST name the real waiting reasons, and Force start MUST lift exactly the confirmed forceable ones through one audited, single-use intent a runner's claim honours.
domain: tasks
surfaces: [apps/web/src/app/api/tasks/[id]/start/route.ts, packages/core/waiting-reason.ts, apps/web/src/lib/force-start.ts, apps/web/src/lib/coordination-probe.ts]
related: [claim-ordering, mission-task-lifecycle, orchestration-decisions-shadow]
keywords: [run now, force start, forceStart, forceStartHistory, reasons_changed, reasonsDigest, coordination_hold, WaitingReason, inferred dependency, migration slot, human_force_start]
verified_by: [apps/web/src/app/api/tasks/[id]/start/route.test.ts, apps/web/src/lib/force-start.test.ts, apps/web/src/lib/coordination-probe.test.ts, packages/core/__tests__/waiting-reason.test.ts, apps/web/src/app/api/workers/claim/route.test.ts, apps/web/src/app/api/workers/claim/deps-gate.test.ts, apps/web/src/app/app/(protected)/missions/[id]/TaskActionZone.coordination.dom.test.tsx, packages/core/__tests__/start-outcome-grade.test.ts]
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
| one scope-undeclared task per mission | `scope_undeclared_mutex` | yes (human only) | claim-loop key `advisory_manifest` |
| planner order | `ordered_behind` (soft) | yes (human only) | claim planner off for the task |
| local-session mission | `mission_local` | yes | `bypassHeldGate` (the claim's local prefilter) |
| declared `dependsOn` | `dep_declared` | **never** | — |
| capability, budget pause, seats, provider, task hold, unknown | various | **never** | the blocker's own fix action |

Dependency edges and soft overlaps are fed from what `explain` already reports
(`loadTaskCoordinationHolds` → `buildCoordinationHolds`); whether an edge still holds is the
claim's own per-edge SQL predicate (`dependencySatisfied`).

**Invariants**:

- `/start` never returns `started: true` while a hard `WaitingReason` holds the task, unless
  that request is a confirmed Force start over it (or the legacy `forceOverride` lifts a
  policy gate it names).
- Force is offered only when every hard reason is forceable. One non-forceable reason
  (declared dependency, capability, seat, budget pause, provider, task hold, unknown) means
  no Force start anywhere; the surface shows that blocker's fix instead.
- A declared `dependsOn` edge is never lifted: the dependency gate's force arm also requires
  the id to be in `pathDeclaration.inferredDependsOn`.
- Forcing an inferred or migration overlap changes claim order only. The edit-time path lease
  (including the migration anchor) still applies, so migration numbering stays serialized.
- The admin MCP `claim_task {force: true}` keeps its own gate set; it does not lift
  `advisory_manifest`.
- Declared dependencies and coordination-only holds are counted apart in every headline:
  incidental overlap ordering reads "Waiting on migration slot · N tasks also editing {area}",
  never "waiting on N dependencies".

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

**Code surface**:

- Route: `apps/web/src/app/api/tasks/[id]/start/route.ts` (`POST`), `apps/web/src/app/api/tasks/[id]/waiting/route.ts` (`GET`)
- Model: `packages/core/waiting-reason.ts` (`WAITING_KIND_SPEC`, `coordinationHoldBody`, `forceDialog`, `waitingSummary`, `readForceStart`)
- Probe: `apps/web/src/lib/coordination-probe.ts` (`probeCoordination`), `apps/web/src/app/api/workers/claim/coordination-gates.ts`
- Claim: `apps/web/src/app/api/workers/claim/route.ts` (`bypassOrDefer`, `liftedByForce`), `apps/web/src/app/api/workers/claim/deps-gate.ts` (`forceStartLiftsEdge`)
- Recording: `apps/web/src/lib/force-start.ts` (`recordForceStartRequest`, `recordForceStartClaim`, `recordOverrideStart`), `packages/core/orchestration-outcomes.ts` (`gradeStart`, `startActorOf`)
- UI: `apps/web/src/app/app/(protected)/missions/[id]/TaskActionZone.tsx` (`CoordinationRefusal`), `apps/web/src/components/tasks/WaitingLine.tsx`
