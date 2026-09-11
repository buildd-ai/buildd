---
title: Mission Heartbeat Schedule Lifecycle
status: draft
owner: max
last_verified: 2026-09-10
summary: A mission heartbeat MUST be treated as mission state, not a user schedule, and its owning `task_schedule` row MUST NOT outlive or out-tick the mission it drives.
domain: missions
surfaces: [apps/web/src/lib/mission-completion.ts, apps/web/src/lib/mission-archive.ts, apps/web/src/app/api/cron/schedules/route.ts, apps/web/src/app/api/missions/[id]/route.ts]
related: [mission-task-lifecycle]
keywords: [heartbeat, taskschedule, scheduleid, isheartbeat, orchestrationmode, held, archivestaledonemissions, completemissionifverified, dormancy, evaluation log]
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
transition that clause omits, (b) state the mission-state-not-schedule
principle explicitly since nothing currently does, and (c) define a
retirement rule for a heartbeat mission with no open work that the current
system has no path for at all.

---

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
  `apps/web/src/app/api/cron/schedules/route.ts:712-722`) MUST NOT be
  rendered to the mission's owner as if the schedule itself had failed.
  A stale `lastError` frozen on a schedule that is `enabled = false` (and
  therefore cannot self-clear the field on its next successful run) is a
  specific instance of this: it MUST NOT render as a current warning.

## The one missing transition: auto-archive must not orphan a schedule

**NOT IMPLEMENTED.** `archiveStaleDoneMissions`
(`apps/web/src/lib/mission-archive.ts:52-83`, wired into the `schedules`
cron at `apps/web/src/app/api/cron/schedules/route.ts:835`) writes
`status = 'archived'` via a raw `db.update(missions)` and never touches the
mission's `scheduleId` or its `task_schedules` row. It only selects missions
whose schedule is already disabled, so today it always leaves a
disabled-but-undeleted schedule behind — this is the generator of the
paused-schedule backlog documented in the audit. The fix belongs in
`selectMissionsToArchive` / `archiveStaleDoneMissions` themselves, so that
archiving a mission deletes its schedule exactly as the explicit PATCH path
already does for `archived`. See the implementation plan, slice 1.

## Retirement rule for a heartbeat with no open work

**NOT IMPLEMENTED.** Reproduction case: mission `dac620f2` — `status=active`,
`orchestrationMode=manual`, `isHeld=true`, 100% (1/1) deliverable tasks
complete, no path currently evaluates whether it should close or slow down.
See the audit §3 for the full citation chain.

**Rule**: a heartbeat mission that has no open deliverable work (the same
predicate `canCompleteMission` already computes —
`apps/web/src/lib/mission-completion.ts:263-311`) and is NOT in
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
(`apps/web/src/app/api/cron/schedules/route.ts:474-484`) MUST, before
rescheduling, run the same completion check `completeMissionIfVerified`
already exposes (`path: 'dormancy'`, `proposed: false` — dormancy must not
close a mission that only proposed-but-never-executed work, same guard as
today) instead of unconditionally deferring. A mission this closes was
already eligible to close by the existing predicate; this only adds the
missing trigger for the held/manual case, where no planning task ever
completes to fire that trigger via the existing task-completion-driven path
(`apps/web/src/lib/task-dependencies.ts:255,284` →
`apps/web/src/lib/mission-loop.ts:32-176`).

## Acceptance criteria

- AC-1: [GIVEN a mission with `status='active'` and an `isHeartbeat` schedule]
  WHEN a human or MCP caller sets `status: 'completed'` or `'archived'`
  THEN the mission's `scheduleId` is null and the `task_schedules` row is
  deleted. *(Already true — `apps/web/src/app/api/missions/[id]/route.ts:308-328`,
  regression-tested by PR #1086.)*
- AC-2: [GIVEN a mission whose deliverable tasks are all terminal, no goal
  criteria are pending/failed, and no deliverable has an unmerged PR] WHEN
  `archiveStaleDoneMissions` selects it for archival (idle >24h, schedule
  already disabled) THEN its `task_schedules` row is deleted in the same
  transition, not left behind disabled. *(NOT IMPLEMENTED — see slice 1.)*
- AC-3: [GIVEN a mission with `orchestrationMode='manual'` or `isHeld=true`
  and zero open deliverable tasks] WHEN its heartbeat schedule's cron tick
  fires THEN the mission completes via `completeMissionIfVerified` instead of
  merely rescheduling `nextRunAt`. *(NOT IMPLEMENTED — see slice 2.)*
- AC-4: [GIVEN a `task_schedules` row with `enabled=false`] WHEN it is
  rendered on Health, the Schedules page, or mission detail THEN its
  `lastError` (if any) MUST NOT be rendered as an active/current warning —
  it can only be from before the row was disabled. *(NOT IMPLEMENTED — see
  slice 4.)*
- AC-5: [GIVEN the Schedules page's existing `type` classification
  (`heartbeat` / `cron-mission` / `workspace-schedule`)] WHEN the page loads
  with no explicit filter THEN heartbeat-type rows are grouped separately
  from user-owned rows by default, matching Health's existing collapsed
  subgroup — not merged into one flat list requiring a manual filter click.
  *(NOT IMPLEMENTED — see slice 3.)*

## Code surface

- `apps/web/src/lib/mission-completion.ts` — `canCompleteMission`,
  `completeMissionIfVerified`: the one completion predicate and the one
  writer of automated `active → completed`.
- `apps/web/src/lib/mission-archive.ts` — `selectMissionsToArchive`,
  `archiveStaleDoneMissions`: the undocumented fifth terminal-status path.
- `apps/web/src/app/api/cron/schedules/route.ts` — the cron dispatcher;
  the `orchestrationMode==='manual'` defer branch is where the retirement
  rule attaches.
- `apps/web/src/app/api/missions/[id]/route.ts` — the one PATCH/DELETE route
  every explicit transition (dashboard and MCP `manage_missions`) shares.
- `packages/core/mcp-tools.ts` — `list_schedules` param surface (no
  heartbeat filter today; see plan slice 5).

## Out of scope

- Rewriting the four transitions `docs/SPEC.md`'s `scheduleId` Lifecycle
  clause already documents correctly — not re-specified here.
- Any UI change, schedule deletion, mission mutation, or code change — this
  is a contract only; see the plan for implementation slices.
- `budget_exhausted`'s schedule handling — already correct by design
  (deferred, not disabled, so a budget-raise auto-resume doesn't strand the
  mission); worth a one-line addition to the `docs/SPEC.md` clause, not a
  behavior change.
- A mission status of `cancelled` — does not exist in the schema
  (`packages/core/db/schema.ts:689`: `active | paused | completed | archived
  | budget_exhausted`); any future addition of one is a separate spec.
