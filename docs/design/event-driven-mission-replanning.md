---
status: implemented
# Structural conformance only; passing does not certify every prose invariant.
# Shipped: events plan every auto mission and wake it on non-task events (S1,
# PR #3117), the organizer checklist trim (S3, PR #3114), and the heartbeat as
# a stuck-check backstop with default check-ins (S2), and the UI copy (S4):
# check-ins and organizer runs labelled by trigger (lib/mission-checkins.ts).
assertions:
  - id: "wake-mission"
    type: "symbol"
    name: "wakeMission"
    path: "apps/web/src/lib/mission-wake.ts"
  - id: "stuck-check"
    type: "symbol"
    name: "isMissionStuck"
    path: "apps/web/src/lib/mission-stuck.ts"
  - id: "backstop-grace"
    type: "symbol"
    name: "BACKSTOP_GRACE_MS"
    path: "apps/web/src/lib/mission-stuck.ts"
  - id: "stuck-check-in-cron"
    type: "symbol_reachable"
    symbol: "isMissionStuck"
    entry: "apps/web/src/app/api/cron/schedules/route.ts"
    as: "call"
  - id: "stuck-check-tests"
    type: "test_file"
    path: "apps/web/src/lib/mission-stuck.test.ts"
  - id: "organizer-run-label"
    type: "symbol"
    name: "organizerRunLabel"
    path: "apps/web/src/lib/mission-checkins.ts"
  - id: "last-check"
    type: "symbol"
    name: "describeLastCheck"
    path: "apps/web/src/lib/mission-checkins.ts"
  - id: "checkins-copy-tests"
    type: "test_file"
    path: "apps/web/src/lib/mission-checkins.test.ts"
---
# Event-Driven Mission Replanning, with the Heartbeat as a Backstop

**Status:** Implemented (S1 PR #3117, S3 PR #3114, S2 PR #3122 the backstop, S4 the UI copy in §5)
**Related:** `apps/web/src/lib/mission-loop.ts` (`maybeRetriggerMission`, `retriggerMissionOnFailure`), `apps/web/src/lib/task-dependencies.ts` (`resolveCompletedTask`), `apps/web/src/app/api/cron/schedules/route.ts`, `apps/web/src/lib/heartbeat-prepass.ts`, `apps/web/src/lib/heartbeat-helpers.ts`, `apps/web/src/lib/mission-context.ts` (`buildHeartbeatContext`), `apps/web/src/lib/criteria-rearm.ts`, `apps/web/src/lib/mission-dependency.ts`, `apps/web/src/app/api/github/webhook/route.ts`, `docs/specs/mission-heartbeat-schedule-lifecycle.md`, `docs/design/heartbeat-triage.md`

## Problem

A mission has two ways to plan its next step, and for heartbeat missions the
faster one is switched off.

- **The event loop.** When a task reaches a terminal state,
  `resolveCompletedTask` calls `maybeRetriggerMission`. That runs the
  completion check and then dispatches the organizer for the next batch.
- **The heartbeat.** The hourly schedules cron walks every heartbeat schedule,
  runs a token-free prepass, and dispatches the organizer when the state has
  changed.

For a mission with a heartbeat, `maybeRetriggerMission` returns `skipped` on
purpose (`mission-loop.ts`, "Heartbeat missions don't self-retrigger — cron
handles next cycle"). The next batch therefore waits for the next hourly tick.

Production agrees. Every heartbeat cycle in the last 90 days that filed work
ran when its mission had no open tasks, about an hour after the mission's last
task ended, and with no event-driven planning run in the two hours before. In
each case the event loop would have planned the same step right away.

The heartbeat is also the only trigger for several states the event loop never
sees. Nothing else wakes a mission when:

1. goal criteria are unmet after every deliverable is terminal (the criteria
   re-arm is only called from the cron);
2. a dependency is met, the mission is resumed, its budget is raised, or its
   `startAt` arrives (these only move `nextRunAt` or `enabled`);
3. planning retries run out, or a planning failure is environmental;
4. a PR merges outside a task's own worker (the webhook marks the task
   complete directly and never calls `resolveCompletedTask`), or the owner
   adds a note or answers a question.

Missions created without a heartbeat have no automatic recovery for any of
these.

The heartbeat's organizer checklist (`DEFAULT_MISSION_HEARTBEAT_CHECKLIST`)
also asks the organizer to do work the platform already does. Failed tasks are
auto-retried, PR conflicts go to CI retry and the conflict sweep, and
completion is decided by `completeMissionIfVerified`. Cycles spent restating
this show up as `action_taken` cycles that filed nothing.

## Proposal

Make events the driver and the heartbeat a backstop.

**The crux:** once the event loop plans heartbeat missions too, the heartbeat
must stop dispatching the organizer on "the state changed", or every step is
planned twice. It dispatches only when a deterministic check finds the mission
stuck, meaning the event loop had its chance and nothing moved. If this is
wrong in the permissive direction, organizer runs double. If it is wrong in the
strict direction, a stuck mission waits for the owner. The guard against both
is the existing planning uniqueness constraint (one active planning task per
mission), plus the grace period below.

### 1. Events plan every auto mission

- Remove the heartbeat skip in `maybeRetriggerMission`. A heartbeat mission
  re-plans on task completion exactly like any other auto mission, under the
  same guards: manual mode, dependency, depth cap, empty-cycle stop, open-PR
  gate.
- The heartbeat tick anchor already dedupes a cron cycle against a
  failure-retrigger. The event path relies on the same
  `tasks_active_planning_per_mission` constraint and `onConflictDoNothing`
  insert.

### 2. Wake the mission on the events that only move the schedule today

Each of these calls one shared function,
`wakeMission(missionId, reason)`: skip unless the mission is active, auto,
not held and not dependency-blocked, then run `maybeRetriggerMission` with a
fresh trigger chain.

| Event | Where |
|---|---|
| Dependency met | `checkAndUnblockDependentMissions` (`mission-dependency.ts`) |
| Resume, budget raised | `PATCH /api/missions/[id]` |
| PR merged by webhook | `github/webhook/route.ts`: go through `resolveCompletedTask` instead of writing the status directly, so dependents, completion and re-planning all run |
| Owner note or answer | `missions/[id]/notes` and `…/reply` (a question the organizer asked, now answered) |
| `startAt` reached | the backstop sweep (below), which already runs hourly |

### 3. The heartbeat becomes a backstop sweep

The cron still visits each heartbeat schedule hourly. The prepass, circuit
breaker and planning backoff stay as they are. Where a cycle used to dispatch
the organizer on `invoke_llm`, it now dispatches only if the mission is
**stuck**:

- no open task and no active planning task, excluding the prepass's known
  self-resolving waits; **and**
- no organizer run (any trigger source) in the last `BACKSTOP_GRACE_MS`
  (2 hours), so a step the event loop just planned is never planned again;
  **and**
- the prepass reports `invoke_llm`: the state changed and nothing planned
  it. That means a missed event, retries exhausted, or an event chain that
  ended `depth_exceeded` / `stuck_planning`. Those outcomes are not persisted
  (they are Pusher events only), so the check derives them: no organizer run
  in the grace period while the state changed. A backstop dispatch starts a
  new trigger chain.

The criteria re-arm is not gated by the stuck check. It keeps its own guard
(once per verdict shape) and dispatches as before.

As built (`isMissionStuck`, `apps/web/src/lib/mission-stuck.ts`, pure): the
prepass's `invoke_llm` decision carries `openTaskCount`, `planningActive` and
`lastOrganizerRunAt`, read from the task rows it already loads, so the check
costs no query. A failed prepass fails closed (defers). A not-stuck deferral
records `lastDeferralReason: 'heartbeat_not_stuck'` and does not write the
no-change hash, so a later tick still sees the state as changed. A heartbeat
dispatch is stamped `triggerSource: 'backstop'`.

Otherwise the cycle records its deferral (`lastDeferralReason`) and moves on,
with no model call.

**Heartbeat triage is superseded.** Its question ("does this cycle need the
organizer?") is answered deterministically by the stuck check, and its
experiment could not gather data (organizer runs mostly do not go through
the heartbeat). Its call site is removed. The `heartbeat_triage` experiment is
concluded with that decision. The module, the looks table and the
experiment kind stay until a follow-up drops them, so the concluded
experiment's readout still works.

### 4. Trim the organizer checklist

Drop the items that duplicate platform code: retrying failed tasks, chasing PR
conflicts, and "Do NOT report OK if the mission has not made forward
progress". The last one exists only to stop a cron cycle from idling.

Keep the items only the organizer can do: file the next tasks with concrete
`pathManifest`s, avoid re-implementing sibling work, create a workspace when
there is none, and propose completion. `detectMissionPhase` keeps its phase
label (the organizer's prompt reads it). Its "stalled" branch stops counting
prior heartbeat statuses: stalls are now the sweep's job.

### 5. UI and copy

The internal names stay (`heartbeat`, `isHeartbeat`, `heartbeatChecklist`,
the columns and the enums). Renaming them costs migrations and changes no
behaviour. The words users read change, because "heartbeat" says "the thing
that keeps the mission alive", and that stops being true.

| Surface | Today | After |
|---|---|---|
| Mission detail section and badge | Heartbeat, last heartbeat status | **Check-ins**: "buildd plans the next step as soon as work finishes, and checks every hour whether the mission is stuck." Last check: *on track* / *stuck, organizer started* / *waiting on …* |
| Checklist editor | Heartbeat Checklist | **Organizer checklist**: "What the organizer follows each time it plans the next step." |
| Heartbeat timeline | heartbeat cycles | **Organizer runs**, labelled by trigger: *after task X finished*, *dependency met*, *stuck check*, *you ran it* |
| Schedules page | "Heartbeats" filter and group | **Mission check-ins** |
| Health | "A heartbeat schedule missed its last run" | "A mission check-in missed its last run" |
| New mission / MCP `manage_missions` | `isHeartbeat` described as the mission's driver | "check-ins: an hourly stuck check; the next step is planned when work finishes either way" |
| Settings → Decision model | "(task categories, heartbeat triage)" | "(task categories)" |

Every organizer task records its trigger (`context.triggerSource`: `event`,
`wake:<reason>`, `backstop`, `manual`, `cron`, `auto_retry`). The timeline and
the overview read it, and the next measurement of this change reads it too.

As built (S4, `apps/web/src/lib/mission-checkins.ts`, pure):
`organizerRunLabel` maps each trigger to its label, and an `event` run also
records the finished task (`context.triggerTaskId`) so the timeline can say
*after X finished*. `selectOrganizerRuns` feeds the timeline every
planning-mode task of the mission, whatever started it. `describeLastCheck`
reads the schedule's `lastDeferralReason`: a not-stuck or no-change deferral is
*on track*, a backstop run created after the last tick is *stuck, organizer
started*, and the known waits are *waiting on …*. The MCP `manage_missions`
wording is left to the task that holds `packages/core/mcp-tools.ts`. The web
forms have no heartbeat toggle to reword.

## Implementation sketch

Load-bearing first. Each slice is one PR to `dev`. The shared contracts are
named here so parallel slices agree on them.

1. **Events drive (S1):** remove the skip; add `wakeMission`
   (`apps/web/src/lib/mission-wake.ts`) and wire the table in §2. Stamp
   `triggerSource`. Tests: a heartbeat mission re-plans on completion; each
   wake re-plans once and respects manual / held / dependency; the webhook path
   runs `resolveCompletedTask`.
2. **Backstop sweep (S2):** `isMissionStuck` (`apps/web/src/lib/mission-stuck.ts`,
   pure, taking the prepass result and the last organizer run) gates the
   cron's dispatch; `BACKSTOP_GRACE`; new auto missions get a check-in
   schedule by default; remove the triage call site; conclude the experiment;
   update the heartbeat lifecycle spec (new "Role" section) and mark
   `heartbeat-triage.md` superseded. Tests: a changed state with a recent
   event run defers; the same state past the grace period dispatches once;
   criteria re-arm is unchanged.
3. **Organizer prompt (S3):** the checklist trim and the `detectMissionPhase`
   stalled branch. Prompt-only; the heartbeat context stays the organizer's
   context.
4. **UI and copy (S4):** the table in §5, reading `triggerSource`. Screenshots
   at phone and desktop widths.
5. **Docs:** SPEC §missions, the heartbeat lifecycle spec's new "Role"
   section, `heartbeat-triage.md` marked superseded, and `buildd-docs`.

S1 and S2 touch different files, but S2's grace check reads organizer runs
that S1 now creates. S2 merges after S1 and re-verifies against merged dev.

## Decisions (taken; the owner delegated them)

- **Grace period: 2 hours**, a constant. That is two hourly ticks: long
  enough that an event plan is never doubled, short enough that a missed event
  costs at most a couple of hours.
- **Every new auto mission gets a check-in schedule by default.** It costs
  nothing now (no model call unless stuck) and closes problem items 2–4 for
  missions that had no heartbeat. The toggle stays. Existing missions are not
  back-filled.
- **Owner notes and answers both wake an auto mission.** The owner writes to
  steer. A manual mission is not woken: manual means the owner starts things.

## Open questions

- **When to drop triage for good.** Leaning: one release after S2 ships and
  the concluded experiment has been read, in a follow-up that also drops
  `heartbeat_triage_looks`.

## Non-goals

- Renaming `heartbeat` in code, schema or APIs.
- Changing manual or held semantics, the prepass, the circuit breaker or the
  planning backoff.
- Dropping the triage module, its table or the experiment kind (a follow-up).
