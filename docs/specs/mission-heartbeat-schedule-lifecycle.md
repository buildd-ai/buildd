---
title: Mission Heartbeat Schedule Lifecycle
status: active
owner: max
last_verified: 2026-09-28
summary: A mission heartbeat MUST be treated as mission state, not a user schedule, and its owning `task_schedule` row MUST NOT outlive or out-tick the mission it drives.
domain: missions
surfaces: [apps/web/src/lib/mission-completion.ts, apps/web/src/lib/mission-archive.ts, apps/web/src/app/api/cron/schedules/route.ts, apps/web/src/app/api/missions/[id]/route.ts, apps/web/src/lib/mission-stuck.ts, apps/web/src/app/api/missions/route.ts]
related: [mission-task-lifecycle]
keywords: [heartbeat, taskschedule, scheduleid, isheartbeat, orchestrationmode, held, archivestaledonemissions, completemissionifverified, dormancy, evaluation log]
verified_by: [apps/web/src/lib/mission-archive.test.ts, apps/web/src/app/api/cron/schedules/route.test.ts, apps/web/src/lib/mission-completion.test.ts, apps/web/src/lib/schedule-health.test.ts, apps/web/src/lib/mission-stuck.test.ts, apps/web/src/app/api/missions/route.test.ts]
supersedes: []
# Structural conformance only; passing does not certify every prose invariant.
assertions:
  - id: "archive-mission"
    type: "symbol"
    name: "archiveStaleDoneMissions"
    path: "apps/web/src/lib/mission-archive.ts"
  - id: "archive-retires-schedules"
    type: "symbol_reachable"
    symbol: "taskSchedules"
    entry: "apps/web/src/lib/mission-archive.ts"
    as: "read"
  - id: "mission-archive-tests"
    type: "test_file"
    path: "apps/web/src/lib/mission-archive.test.ts"
  - id: "stuck-check"
    type: "symbol"
    name: "isMissionStuck"
    path: "apps/web/src/lib/mission-stuck.ts"
  - id: "stuck-check-gates-cron"
    type: "symbol_reachable"
    symbol: "isMissionStuck"
    entry: "apps/web/src/app/api/cron/schedules/route.ts"
    as: "call"
---
# Mission Heartbeat Schedule Lifecycle

**Capability statement**: A mission's `*/N` heartbeat is mission state
rendered wherever mission state renders — never an independently pausable,
editable, or user-owned schedule — and no path that moves a mission to a
terminal or inert status may leave that mission's `task_schedule` row ticking
or existing beyond what the four documented transitions in `docs/SPEC.md`
(`scheduleId` field) allow.

This spec does not restate the ownership rule for the four transitions
`docs/SPEC.md` already documents and that are already correctly implemented —
see the audit at
`docs/reports/mission-heartbeat-schedule-lifecycle-audit.md` §1 for the
verbatim clause and its verification. It exists to (a) close the one
transition that clause omitted, (b) state the mission-state-not-schedule
principle explicitly since nothing else does, and (c) define a retirement
rule for a heartbeat mission with no open work — a case the system had no
path for at all before PR #2300. Both gaps are now closed; see below.

---

## Role

The heartbeat does not drive a mission's progress. Events do
(`docs/design/event-driven-mission-replanning.md`). The heartbeat is a
deterministic backstop for when the event chain broke.

**Invariants**:

- Events plan every auto mission, heartbeat or not: a task of the mission
  reaching a terminal state re-plans through `maybeRetriggerMission`, and a
  non-task event (dependency met, resume, budget raised, PR merged by
  webhook, owner note or answer) re-plans through `wakeMission`.
- A heartbeat tick dispatches the organizer only when `isMissionStuck`
  (`apps/web/src/lib/mission-stuck.ts`) holds: the prepass reports
  `invoke_llm`, there is no open task (the prepass's self-resolving waits
  excluded) and no active planning task, and no organizer run of any trigger
  source started within `BACKSTOP_GRACE_MS` (2 hours). That dispatch is
  stamped `triggerSource: 'backstop'`.
- Otherwise the tick records `lastDeferralReason: 'heartbeat_not_stuck'`,
  makes no model call, and does not write `lastHeartbeatStateHash`, so a
  stall is still visible to a later tick.
- The criteria re-arm is the one other heartbeat dispatch. It is not gated
  by the stuck check; it keeps its own once-per-verdict-shape guard.
- The heartbeat makes no model call to decide whether to dispatch.
  Heartbeat triage no longer runs.
- A new auto mission gets a heartbeat (check-in) schedule by default;
  `isHeartbeat: false` opts out. Existing missions are not back-filled.

## Ownership and rendering

**Invariants**:

- A `task_schedule` row is "a mission heartbeat" iff
  `taskTemplate.context.heartbeat === true` (the same discriminator every
  current surface uses: `isHeartbeat` in `mcp-tools.ts`,
  `schedule.isHeartbeat` on Health, `templateContext?.heartbeat` on mission
  detail). It is never surfaced to its owning mission's audience as a
  peer of a user-authored schedule.
- A mission heartbeat's cadence, last tick, next tick, and last error are
  read from the mission's own `schedule` relation wherever mission state is
  rendered (mission detail, Home) — never from an independent
  "schedule card" UI affordance with its own pause/edit/delete controls.
- An error written to a heartbeat schedule's `lastError` by mission
  machinery working as intended (the documented example:
  `tasks_active_planning_per_mission` unique-constraint contention, already
  handled with `onConflictDoNothing` at
  `apps/web/src/app/api/cron/schedules/route.ts:756-766`) MUST NOT be
  rendered to the mission's owner as if the schedule itself had failed.
  A stale `lastError` frozen on a schedule that is `enabled = false` (and
  therefore cannot self-clear the field on its next successful run) is a
  specific instance of this: it MUST NOT render as a current warning.

## The one closed transition: auto-archive no longer orphans a schedule

**Implemented** (PR #2275, landed in #2300). `archiveStaleDoneMissions`
(`apps/web/src/lib/mission-archive.ts:52-95`, wired into the `schedules`
cron at `apps/web/src/app/api/cron/schedules/route.ts`) used to write
`status = 'archived'` via a raw `db.update(missions)` that never touched the
mission's `scheduleId` or its `task_schedules` row — since it only selected
missions whose schedule was already disabled, it always left a
disabled-but-undeleted schedule behind, the generator of the paused-schedule
backlog documented in the audit. `selectMissionsToArchive` /
`archiveStaleDoneMissions` now delete the mission's `task_schedules` row and
null `scheduleId` in the same pass that sets `status = 'archived'`, matching
what the explicit PATCH path already did. A one-time migration backfilled
the pre-existing orphaned rows, scoped to completed/archived missions only.
Regression-tested in `apps/web/src/lib/mission-archive.test.ts`.

## Retirement rule for a heartbeat with no open work

**Implemented** (PR #2277, landed in #2300). Reproduction case: mission
`dac620f2` — `status=active`, `orchestrationMode=manual`, `isHeld=true`,
100% (1/1) deliverable tasks complete, no path evaluated whether it should
close or slow down. See the audit §3 for the full citation chain.

**Rule**: a heartbeat mission that has no open deliverable work (the same
predicate `canCompleteMission` already computes —
`apps/web/src/lib/mission-completion.ts:158`) and is NOT in
`orchestrationMode='auto'` MUST NOT keep ticking its schedule at full cadence
forever. Pick **complete the mission**, not back off the cadence, for the
following reason: `orchestrationMode='manual'` / `isHeld=true` mean "a human
decides when this moves *forward*" (starts new work) — they say nothing about
whether existing work is *finished*, and `canCompleteMission`'s predicate
(deliverables all terminal, no unmerged PRs, no failed goal criteria) is
exactly as trustworthy for a manual mission as an automatic one. Backing off
the cadence instead would leave an indefinitely-idle mission camped in
`active` forever with no user-visible signal that it is actually done;
escalating would page a human for a case the existing completion predicate
can already answer by itself.

Concretely: the cron dispatcher's manual-mode defer branch
(`apps/web/src/app/api/cron/schedules/route.ts:481-498`) now runs the same
completion check `completeMissionIfVerified` already exposes
(`path: 'dormancy'`, `proposed: false` — dormancy must not close a mission
that only proposed-but-never-executed work, same guard as today) before
rescheduling, instead of unconditionally deferring. A mission this closes was
already eligible to close by the existing predicate; this only adds the
missing trigger for the held/manual case, where no planning task ever
completes to fire that trigger via the existing task-completion-driven path
(`apps/web/src/lib/task-dependencies.ts:281` →
`apps/web/src/lib/mission-loop.ts:162-171`). Regression-tested in
`apps/web/src/app/api/cron/schedules/route.test.ts` and
`apps/web/src/lib/mission-completion.test.ts`.

## Acceptance criteria

- AC-1: [GIVEN a mission with `status='active'` and an `isHeartbeat` schedule]
  WHEN a human or MCP caller sets `status: 'completed'` or `'archived'`
  THEN the mission's `scheduleId` is null and the `task_schedules` row is
  deleted. *(Already true — `apps/web/src/app/api/missions/[id]/route.ts:374-386`,
  regression-tested by PR #1086.)*
- AC-2: [GIVEN a mission whose deliverable tasks are all terminal, no goal
  criteria are pending/failed, and no deliverable has an unmerged PR] WHEN
  `archiveStaleDoneMissions` selects it for archival (idle >24h, schedule
  already disabled) THEN its `task_schedules` row is deleted in the same
  transition, not left behind disabled. *(Implemented — PR #2275/#2300,
  regression-tested by `apps/web/src/lib/mission-archive.test.ts`.)*
- AC-3: [GIVEN a mission with `orchestrationMode='manual'` and zero open
  deliverable tasks] WHEN its heartbeat schedule's cron tick fires THEN the
  mission completes via `completeMissionIfVerified` instead of merely
  rescheduling `nextRunAt`. *(Implemented — PR #2277/#2300, regression-tested
  by `apps/web/src/app/api/cron/schedules/route.test.ts`.)*
- AC-4: [GIVEN a `task_schedules` row with `enabled=false`] WHEN it is
  rendered on Health, the Schedules page, or mission detail THEN its
  `lastError` (if any) MUST NOT be rendered as an active/current warning —
  it can only be from before the row was disabled. *(Implemented —
  `isScheduleErrorLive` in `apps/web/src/lib/schedule-health.ts`, gating
  `HealthClient.tsx`, `SchedulesUnified.tsx`, and `ScheduleList.tsx`; see
  slice 4.)*
- AC-5: [GIVEN the Schedules page's existing `type` classification
  (`heartbeat` / `cron-mission` / `workspace-schedule`)] WHEN the page loads
  with no explicit filter THEN heartbeat-type rows are grouped separately
  from user-owned rows by default, matching Health's existing collapsed
  subgroup — not merged into one flat list requiring a manual filter click.
  *(Implemented — collapsed heartbeat group in `SchedulesUnified.tsx`; see
  slice 3.)*

- AC-6: [GIVEN an auto mission with a heartbeat schedule whose prepass
  reports `invoke_llm`] WHEN its cron tick fires THEN the organizer is
  dispatched, stamped `triggerSource: 'backstop'`, only if there is no open
  task and no active planning task and no organizer run started within
  `BACKSTOP_GRACE_MS`; otherwise the tick defers with
  `lastDeferralReason: 'heartbeat_not_stuck'`, writes no state hash, and
  makes no model call (heartbeat triage is not called). *(Implemented —
  regression-tested by `apps/web/src/lib/mission-stuck.test.ts` and
  `apps/web/src/app/api/cron/schedules/route.test.ts`.)*
- AC-7: [GIVEN a mission created in `orchestrationMode='auto'`] WHEN it is
  created without `isHeartbeat` THEN it gets a heartbeat schedule; WHEN it is
  created with `isHeartbeat: false` THEN it gets none. *(Implemented —
  `apps/web/src/app/api/missions/route.ts`, regression-tested by
  `apps/web/src/app/api/missions/route.test.ts`.)*

## Code surface

- `apps/web/src/lib/mission-completion.ts` — `canCompleteMission`,
  `completeMissionIfVerified`: the one completion predicate and the one
  writer of automated `active → completed`.
- `apps/web/src/lib/mission-archive.ts` — `selectMissionsToArchive`,
  `archiveStaleDoneMissions`: the fifth terminal-status path, now
  schedule-cleanup-complete like the other four.
- `apps/web/src/app/api/cron/schedules/route.ts` — the cron dispatcher;
  the `orchestrationMode==='manual'` defer branch runs the retirement rule
  before rescheduling.
- `apps/web/src/lib/mission-stuck.ts` — `isMissionStuck`, `BACKSTOP_GRACE_MS`:
  the pure stuck check that gates the heartbeat's organizer dispatch.
- `apps/web/src/app/api/missions/route.ts` — mission creation; gives a new
  auto mission its default heartbeat schedule.
- `apps/web/src/app/api/missions/[id]/route.ts` — the one PATCH/DELETE route
  every explicit transition (dashboard and MCP `manage_missions`) shares.
- `packages/core/mcp-tools.ts` — `list_schedules`'s `type` param
  (`"heartbeat" | "workspace" | "all"`, default `"all"`) filters heartbeat
  schedules out of the caller-actionable set on request.

## Out of scope

- Rewriting the four transitions `docs/SPEC.md`'s `scheduleId` Lifecycle
  clause already documents correctly — not re-specified here.
- Any UI change beyond what shipped — this document is a contract, not an
  implementation log; see `docs/plans/archive/mission-heartbeat-schedule-lifecycle-fixes.md`
  for the slices that closed AC-2/AC-3 and PR #2300 for what landed.
- `budget_exhausted`'s schedule handling — already correct by design
  (deferred, not disabled, so a budget-raise auto-resume doesn't strand the
  mission); worth a one-line addition to the `docs/SPEC.md` clause, not a
  behavior change.
- A mission status of `cancelled` — does not exist in the schema
  (`packages/core/db/schema.ts:762`: `active | paused | completed | archived
  | budget_exhausted`); any future addition of one is a separate spec.
