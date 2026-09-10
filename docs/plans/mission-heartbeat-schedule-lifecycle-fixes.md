# Mission Heartbeat Schedule Lifecycle — Implementation Slices

Point-in-time rollout plan. Not a contract — see
`docs/specs/mission-heartbeat-schedule-lifecycle.md` for the invariants these
slices satisfy, and `docs/reports/mission-heartbeat-schedule-lifecycle-audit.md`
for the investigation each slice is based on. Move to `archive/` once shipped.

Each slice is sized for one PR. Ordered by dependency, not by severity — slice
1 unblocks nothing else but is the highest-value fix (it's the one still
actively generating orphans on every cron tick). Slices 2–5 are independent
of each other and of slice 1; parallelize freely once the plan is approved.

## Slice 1 — Auto-archive deletes the schedule (regression of #1086)

**Regression**: #1086 shipped "explicit status write to completed/archived
deletes the schedule" for the dashboard/MCP PATCH path. It did not know about
`archiveStaleDoneMissions` (a separate, raw-`db.update` path to `archived`)
because that path selects on already-*active* missions and was presumably
either shipped after #1086 or simply not in scope for it — either way it
bypasses the fix entirely today.

**Do**: in `apps/web/src/lib/mission-archive.ts`, change
`archiveStaleDoneMissions` to delete the mission's `task_schedules` row (and
null `scheduleId`) in the same update as the `archived` status write, for
every mission it selects. `selectMissionsToArchive`'s pure selector logic does
not need to change — it already only selects missions with a disabled
schedule, so there is nothing to disable, only to delete.

**Verify**: regression test — a candidate mission with a disabled schedule
row, after `archiveStaleDoneMissions`, has `scheduleId=null` and the
`task_schedules` row gone. Existing `archive-missions.test.ts` and
`mission-archive.ts` unit tests extend directly.

**Also**: one-time cleanup migration or ops script for the 36 pre-existing
orphans (`docs/reports/...-audit.md` §2) — these predate the code fix and
won't self-heal. Optional to bundle with this PR; can also ship as a follow-up
once the code fix is live (so nothing new orphans while the backfill is
written).

## Slice 2 — Held/manual missions evaluate completion instead of deferring forever

**New** (not a regression — no prior PR attempted this).

**Do**: in `apps/web/src/app/api/cron/schedules/route.ts`'s
`orchestrationMode === 'manual'` defer branch (~line 474), before
rescheduling `nextRunAt`, call `completeMissionIfVerified(missionId, { path:
'dormancy' })`. If it completes the mission, `completeMissionIfVerified`
already disables the schedule (existing behavior, no change needed there) —
skip the reschedule entirely in that case. If it doesn't complete (open work,
unmet criteria, unmerged PR), defer exactly as today.

**Verify**: regression test — a manual-mode, held mission with all
deliverables terminal and no criteria completes on its next cron tick instead
of deferring; a manual-mode mission with a pending deliverable still defers,
unchanged.

## Slice 3 — Schedules page groups heartbeats by default (regression of #1578)

**Regression**: #1578 gave Health a collapsed heartbeat subgroup but the
Schedules page — which already carries the `type` classification and a filter
tab bar (`SchedulesUnified.tsx`) — was never updated to default into the same
grouped view. The data model exists; only the default rendering doesn't use
it.

**Do**: change the Schedules page's default view to group by `type` (or at
minimum collapse `heartbeat`-type rows the way Health already does), matching
the existing filter tabs' categories. Reuse Health's collapsed-subgroup
pattern rather than inventing a new one.

**Verify**: component test asserting the default (no filter selected) render
groups/collapses heartbeat rows separately from `workspace-schedule` rows.

## Slice 4 — Stale `lastError` on a disabled schedule stops rendering as live

**New.**

**Do**: on every surface that prints `schedule.lastError` (Health —
`HealthClient.tsx:600, 935-936` — and the Schedules page), suppress the
warning display when `schedule.enabled === false`. This is a rendering-only
change; `lastError` itself doesn't need to be cleared retroactively (a
disabled schedule never runs again to overwrite it either way, so leaving the
column alone is fine — only its display is wrong).

**Verify**: component test — a disabled schedule with a non-null `lastError`
renders with no warning badge; an enabled schedule with the same `lastError`
still renders it.

## Slice 5 — MCP `list_schedules` gains an opt-in heartbeat filter

**New.** Per the audit §5 decision: default output stays unfiltered (an
agent auditing schedule health needs heartbeats visible); add an explicit
opt-in for the "what can I act on" framing.

**Do**: add a `type` (`'heartbeat' | 'workspace' | 'all'`, default `'all'`)
or equivalently a boolean `excludeHeartbeats` param to the `list_schedules`
MCP action in `packages/core/mcp-tools.ts`, filtering on the same
`taskTemplate.context.heartbeat === true` discriminator every other surface
uses. Update the tool's documented param string (`mcp-tools.ts:356`) in the
same change — that string is the only spec an agent calling this tool ever
reads.

**Verify**: unit test — `list_schedules` with the new param set returns only
non-heartbeat rows; omitted or `'all'` is byte-identical to current output
(no default-behavior change for existing callers).

## Not in scope for any slice

- `budget_exhausted` schedule handling — already correct; only a one-line
  addition to `docs/SPEC.md`'s `scheduleId` clause is warranted, not a code
  change (see spec, Out of scope).
- Any change to mission completion criteria, goal-criteria evaluation, or the
  dormancy predicate itself — slice 2 calls the existing predicate, it does
  not change what the predicate decides.
