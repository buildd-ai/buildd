# Mission Heartbeat Schedule Lifecycle — Audit

**Verified against:** `origin/dev` on 2026-09-10, plus live `list_schedules` /
`manage_missions get` reads against the buildd workspace.
**Trigger:** three prior PRs (#1086, #1578, #969) each attacked a piece of
"heartbeat schedules outlive their mission" and the symptom is still live — 48
schedules, 38 of them `Mission: <title>` rows, 36 of those paused, three
showing a stale error. This audit establishes whether the remaining gap is
design, enforcement, or backfill before any more code gets written.

This is a generated artifact — rebuildable, not a source of truth. The
normative rules it recommends live in
[`docs/specs/mission-heartbeat-schedule-lifecycle.md`](../specs/mission-heartbeat-schedule-lifecycle.md)
(draft); the resulting work items live in
[`docs/plans/mission-heartbeat-schedule-lifecycle-fixes.md`](../plans/mission-heartbeat-schedule-lifecycle-fixes.md).

---

## 1. Is the lifecycle rule written, and does reality contradict it?

`docs/SPEC.md` line 103, the `scheduleId` field, quoted verbatim:

> `scheduleId` — link to a `task_schedule` for recurring missions. **Lifecycle
> rule:** heartbeat schedules are owned by their mission. An *explicit* status
> write to `completed` or `archived` (dashboard / MCP) **deletes** the linked
> schedule; an *automated* completion through `completeMissionIfVerified`
> **disables** it (`enabled = false`) instead, so a mission that later reopens
> — or one refused by the goal-criteria gate — keeps its heartbeat. When the
> mission is `paused`, the schedule is disabled (not deleted). When the
> mission is re-activated (`active`), the schedule is re-enabled. Deleting a
> mission also deletes its schedule. Either way a heartbeat schedule cannot
> outlive the mission that owns it.

**Verdict: IMPLEMENTED for the four transitions the clause actually names**,
and matches code exactly:

- Explicit PATCH to `completed`/`archived` → delete
  (`apps/web/src/app/api/missions/[id]/route.ts:308-328`).
- Explicit PATCH to `paused` → disable, to `active` → re-enable
  (`apps/web/src/app/api/missions/[id]/route.ts:329-336`).
- `completeMissionIfVerified` (every automated completion path — heartbeat
  signal, dormancy, independent evaluation, criteria evaluator) → disable, not
  delete (`apps/web/src/lib/mission-completion.ts:568-573`).
- Mission DELETE → delete schedule
  (`apps/web/src/app/api/missions/[id]/route.ts:759-760`).
- MCP `manage_missions update` and `delete` proxy the same PATCH/DELETE routes
  (`packages/core/mcp-tools.ts:3503-3564`) — there is no second implementation
  to drift from the dashboard path.

**But the clause's closing sentence — "a heartbeat schedule cannot outlive the
mission that owns it" — is CONTRADICTED.** There is a fifth mission-terminal
transition the clause does not mention at all: automatic archival of stale
"done" missions (§2, path 5 below). It writes `status = 'archived'` directly
via `db.update(missions)`, bypassing both the explicit-PATCH delete path and
the automated-completion disable path. It is not a violation of the four
transitions the clause states (none of those are the code path involved) — it
is a fifth, real, live transition to a terminal mission status that the
clause's enumeration never accounted for. **Classification for this specific
gap: SHIPPED-NOT-DOCUMENTED at best, and its practical effect is exactly the
outcome the clause promises can't happen** — so the honest read is
CONTRADICTED. The fix is enforcement (make this path either delete or route
through the deletion logic), not a rewrite of the clause's stated rule for the
four transitions it already gets right.

## 2. Why did #1086 not hold? Every mission-terminal path, enumerated

| # | Path | Where | Deletes schedule? | Disables schedule? |
|---|---|---|---|---|
| 1 | Explicit PATCH `status: completed｜archived` (dashboard UI, MCP `manage_missions update`) | `apps/web/src/app/api/missions/[id]/route.ts:308-328` | **Yes** | — |
| 2 | Explicit PATCH `status: paused` / `active` | same file, `:329-336` | No (by design — reopenable) | Yes / re-enables |
| 3 | `DELETE /api/missions/[id]` (dashboard, MCP `manage_missions delete`) | same file, `:759-760` | **Yes** | — |
| 4 | `completeMissionIfVerified` — the single writer of automated `active → completed`, called from the heartbeat's `missionComplete=true` signal, the dormancy check, the independent evaluation task, and the criteria evaluator | `apps/web/src/lib/mission-completion.ts:484-573` | No (by design — reopenable / criteria-refusal recoverable) | **Yes** |
| 5 | `archiveStaleDoneMissions` — cron maintenance job, runs on every `schedules` cron tick, flips `active → archived` for missions idle >24h whose tasks are all `completed` and whose schedule is *already* disabled | `apps/web/src/lib/mission-archive.ts:52-83`, wired at `apps/web/src/app/api/cron/schedules/route.ts:835` via `archive-missions.ts` | **No** | No (leaves it exactly as found — disabled, not deleted) |
| 6 | `exhaustMissionBudget` — `active → budget_exhausted` | `apps/web/src/lib/mission-budget.ts:22-45` | No | No — deliberate; see below |

Path 5 is the root cause. It only ever selects missions whose schedule is
**already disabled** (`selectMissionsToArchive`,
`apps/web/src/lib/mission-archive.ts:35`: `if (scheduleEnabled === true) return
false`) — i.e. missions that already went through path 4 and got their
schedule disabled-not-deleted, exactly as the spec intends for a *reopenable*
completion. Crucially, `archiveStaleDoneMissions` only queries
`status = 'active'` missions (`mission-archive.ts:54`) — it is not
re-archiving an already-completed mission, it is a *second, independent*
terminal transition for a mission that is still nominally `active` but whose
tasks are all `completed` and whose schedule sits disabled (typically because
§3's held/manual/dormancy-starved shape kept it from ever reaching path 4's
explicit "no criteria, all terminal → complete" branch). Either way, path 5
writes a terminal status (`archived`) with a raw `db.update`, never routes
through the PATCH handler that would delete the schedule, and its own
selection filter guarantees the schedule it leaves behind still exists as a
row — disabled, but never deleted. **This is the generator of the 36 orphaned
rows.**

**Backfill: none ran.** `packages/core/drizzle/*.sql` has no migration that
touches `task_schedules` for cleanup, and PR #1086's shipped diff (per its
own summary) was the PATCH-route fix, Delete UI, and Health collapse — no
backfill script or migration. The oldest orphan's last-run date
(2026-07-07) lines up with when #1086's fix started disabling schedules going
forward; nothing has ever swept the rows that predate it, and path 5 has been
quietly adding to the pile ever since for missions that finish without ever
passing through path 4's dashboard/MCP-explicit branch.

**`budget_exhausted` (path 6) is deliberately excluded from the clause and
that is correct, not a gap**: the cron dispatcher explicitly special-cases it
(`apps/web/src/app/api/cron/schedules/route.ts:446-462`, comment in place)
to defer-and-reschedule rather than disable, because disabling here is
unrecoverable — the mission's own budget-raise auto-resume flips `status` back
to `active` but never re-enables the schedule, so a disable-on-exhaustion would
strand the mission permanently dormant even after a human fixed the budget.
Worth one sentence added to the SPEC clause so a future reader doesn't
"fix" this into a bug; not worth a design change.

There is no `cancelled` mission status (`packages/core/db/schema.ts:689`:
`'active' | 'paused' | 'completed' | 'archived' | 'budget_exhausted'` — five
values, no `cancelled`) and "dormant" is a completion-check *path name*, not a
status. The task brief's "completed/archived/cancelled/dormant" enumeration
maps onto real code as: `completed` = path 4, `archived` = path 1 or path 5,
`cancelled` = does not exist for missions, `dormancy` = path 4 reached via the
no-signal branch (`mission-loop.ts:162`), not a separate terminal status.

## 3. Why is mission `dac620f2` (active, 100%, heartbeat still ticking) stuck?

`manage_missions get` on `dac620f2-2b2e-4a58-993c-96cfd7df249f` returns:

```
[active] [HELD]
Progress: 100% (1/1)
Orchestration: manual — orchestrator idle (use Run now or set orchestrationMode=auto to arm)
Start mode: HELD — tasks not claimable; use action=arm to release
```

**This mission is legitimately open and the heartbeat should back off — it is
not a "should have completed" bug.** `orchestrationMode: 'manual'` and
`isHeld: true` are both deliberate states meaning "a human decides when this
moves again." The stuck-active shape traces to two facts, cited:

1. **The cron dispatcher already knows to defer a manual-mode mission's
   schedule** — `apps/web/src/app/api/cron/schedules/route.ts:474-484` skips
   task creation and just reschedules `nextRunAt` when
   `linkedMission.orchestrationMode === 'manual'`. So no new planning task has
   actually been created on the 192 recorded ticks (mostly likely since the
   flip to manual+held — the mission did produce one real deliverable and a
   pending PR review task before that, which is where its progress and open
   PR review task come from).
2. **But that atomic claim (`route.ts:316-349`) increments `totalRuns` and
   `lastRunAt` *before* the manual-mode check runs at line 474** — so every
   deferred tick still counts as a "run" and updates "Last:" in
   `list_schedules`. The 192-runs / ticked-11:00-today reading in the task
   brief is real, but it is 192 *cron claims*, not 192 *agent cycles* — the
   schedule is alive and spinning, not silently burning worker sessions.

**The actual defect is that nothing ever turns the schedule off for a
held+manual mission.** The defer branch reschedules forever; it never
disables. A human (or the organizer) evidently set this mission to
manual+held specifically to stop the runaway heartbeat after its one
deliverable landed — but stopping *orchestration* is not the same lever as
stopping the *schedule*, and nothing couples them. The schedule will tick
every 30 minutes indefinitely, doing a claim + a deferral write, for as long
as the mission stays held+manual, which for a mission with genuinely no open
work and no plan to ever be armed again is forever.

This is distinct from, and does not touch, `completeMissionIfVerified`'s own
gates (`apps/web/src/lib/mission-completion.ts:294-311`,
`:335-355`) — a proposal-driven mission with a `pending` `[reviewer]` task
would be blocked there too (`pendingDeliverables` / `awaitingMerge`), but that
code path is never reached here: `maybeRetriggerMission`'s manual-mode gate
(`apps/web/src/lib/mission-loop.ts:52-55`) returns `skipped` before the
dormancy check ever runs, and the cron path that would have fed it a
completed planning task to react to never creates one. There is currently **no
mechanism that evaluates completion, or backs off the schedule, for a
held+manual mission independent of a task actually completing** — and task
completion is exactly what manual+held is designed to prevent. This is a
structural gap, not a one-mission fluke: any mission moved to manual+held
after finishing its open work is stuck the same way.

## 4. Surface matrix — which renderers separate heartbeats from user schedules?

| Surface | Heartbeats separated? | Evidence |
|---|---|---|
| Health page | **Yes** — dedicated collapsed subgroup, `heartbeatSchedules = schedules.filter(s => s.isHeartbeat)`, rendered under its own "N mission heartbeat(s)" header, collapsed by default | `apps/web/src/app/app/(protected)/health/HealthClient.tsx:428-429, 996-1012` |
| Dedicated Schedules page | **Partially.** Each row carries a `type` (`heartbeat` / `cron-mission` / `workspace-schedule`) with a distinct badge, and a filter tab bar (`All / Heartbeats / Missions / Workspace schedules`) with counts exists — but the default filter is `'all'`, so the page loads with all 48 rows flat and mixed; separation requires the user to click a tab | `apps/web/src/app/app/(protected)/schedules/SchedulesUnified.tsx:38, 307, 433-434` |
| Mission detail page | **Yes, structurally** — heartbeat cadence/next-run/checklist is rendered as fields of the mission (`isHeartbeat`, `heartbeatOverdue`, `heartbeatChecklist` derived from `mission.schedule`), never as a peer "schedule card"; matches PR #969's Evaluation Log framing | `apps/web/src/app/app/(protected)/missions/[id]/page.tsx:393-436` |
| Home page | **Yes, structurally** — same pattern: `nextRunAt`/`lastRunAt`/`cronExpression` pulled onto the mission's own row via `mission.schedule`, never listed as an independent schedule item | `apps/web/src/app/app/(protected)/home/page.tsx:658-745` |
| MCP `list_schedules` | **No** — every schedule, heartbeat or not, is returned in one flat list; the only cue is the `Mission: <title>` name prefix baked into the schedule's own `name` field, not a structured type marker. No filter parameter exists to exclude or isolate heartbeats | `packages/core/mcp-tools.ts:356` (documented params: `workspaceId`, `minutesAgo`, `nameContains` — no `type`/`isHeartbeat`) |

Health (#1578) and the mission-state surfaces (detail, Home) are correctly
separated. **The Schedules page is the "one surface of N" gap** — it has the
data model to separate (the `type` field and filter already exist) but ships
un-separated by default, so an owner landing there sees the same flat wall of
48 the task brief describes. This is the precise failure mode named in the
task brief as precedented by task `39dad761`: fixing the surface with the
dashboard's main traffic (Health) and missing the sibling page that shares the
same underlying data.

**One more render defect, orthogonal to grouping:** Health's schedule rows —
including the heartbeat subgroup — print `schedule.lastError` verbatim
(`HealthClient.tsx:935-936`). The three mission rows' `⚠ duplicate key value
violates unique constraint "tasks_active_planning_per_mission"` the task
brief observed are stale: that exact race is already handled gracefully going
forward (`apps/web/src/app/api/cron/schedules/route.ts:712-722`,
`.onConflictDoNothing()` — the comment there names this exact constraint and
states explicitly "losing that race is the guard working — not a schedule
failure"). The problem is narrower than "errors render wrong": a **paused**
schedule never fires again, so it never gets the chance to overwrite its own
`lastError` — the cron dispatcher only queries `enabled = true` rows
(`route.ts:140`) — so a stale error from before the mission completed (and its
schedule got disabled) is frozen forever and displayed as if it were current.
Any lastError from a disabled schedule is definitionally stale (nothing has
run since); it does not need to be re-classified as "mission machinery," it
needs to stop rendering as an active-looking warning at all once
`enabled = false`.

## 5. Should MCP `list_schedules` filter heartbeats too?

**Decision: no default filter, but add an opt-in one.** Reasoning:

- An agent running a health sweep, or acting on `Last: ... | Last error: ...`,
  needs heartbeats in view — they are exactly the rows most likely to be
  silently broken (per §4, a stale error on a disabled row is currently
  indistinguishable from a live one without reading `enabled`).
- An agent answering "what do I have scheduled" (the human-facing framing —
  "what can I turn off/edit") does not want 38 rows it cannot act on (they are
  not independently pausable or editable per the mission-state rule in the
  companion spec) competing with its 6 own rows.
- The dashboard already resolved the identical tension with a filter, not a
  default exclusion (`SchedulesUnified.tsx`'s `type` badge + tabs) — the MCP
  surface should mirror that shape rather than inventing a different default
  than the UI it's meant to be consistent with.

So: keep `list_schedules`'s default output unfiltered (current behavior,
unchanged), and add an optional `type` (or `excludeHeartbeats: boolean`)
parameter so a caller that wants the six actionable rows can ask for them
explicitly. This is listed as its own slice in the implementation plan; it is
additive to the MCP tool signature and does not change existing callers'
output.
