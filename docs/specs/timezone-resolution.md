---
title: Timezone Resolution
status: active
owner: max
last_verified: 2026-08-30
summary: buildd MUST store exactly two timezones — one detected per user and one canonical per team — and MUST resolve every rendered or scheduled wall clock from that pair with a UTC fallback, never from a workspace.
domain: surfaces
surfaces: [packages/core/timezone.ts, apps/web/src/lib/team-timezone.ts, apps/web/src/app/api/me/timezone/route.ts]
verified_by: [packages/core/__tests__/timezone.test.ts, apps/web/src/lib/team-timezone.test.ts, apps/web/src/app/api/me/timezone/route.test.ts, apps/web/src/lib/pr-activity-comment.test.ts, apps/web/src/app/api/teams/[id]/route.test.ts]
related: [webhook-dataflow, external-cron-triggers, team-namespace-scoping]
keywords: [IANA, users.timezone, teams.timezone, task_schedules.timezone, activeHoursTimezone, Intl, UTC]
supersedes: []
---
# Timezone Resolution

**Capability statement**: Every wall clock buildd renders or schedules against
MUST resolve to an explicit IANA zone drawn from a two-field model — the
viewer's own detected zone, or the owning team's canonical zone — falling back
to UTC. No feature may assume UTC silently.

---

## The Two-Field Model

There are exactly two stored zones, and there is no override chain:

| Field | Set by | Used for |
|---|---|---|
| `users.timezone` | Detected from the browser, silently | Anything rendered to that one signed-in person |
| `teams.timezone` | Seeded from an owner's detected zone; editable by owners/admins | Anything rendered to a shared or external surface |

**Invariants**:
- `users.timezone` MUST be populated by detection (`Intl.DateTimeFormat().
  resolvedOptions().timeZone`), never by asking. A user who never visits a
  settings page still gets correct personal timestamps.
- Seeding `teams.timezone` MUST be restricted to teams the reporting user OWNS,
  and MUST carry `timezone IS NULL` in its WHERE clause. The first member to
  sign in may be a contractor in another country, and an admin's explicit choice
  MUST never be overwritten by detection.
- Workspaces MUST NOT have a timezone. A repo does not live anywhere; a
  workspace resolves through to `teams.timezone`.
- `task_schedules.timezone` is the ONE legitimate per-object override, because a
  job can require a fixed zone regardless of who owns it. It MUST be preserved
  once set: recomputing `nextRunAt` for an existing schedule MUST use the
  schedule's own stored zone, not the team's.
- Both columns are nullable and both fall back to UTC, so a team that never sets
  a zone behaves exactly as it did before this capability existed.
- Any stored zone string MUST be re-validated at read time. A zone valid when
  written can be dropped from a future ICU release; an unrecognised zone
  degrades to UTC rather than throwing.
- Validation MUST be by construction (`new Intl.DateTimeFormat(_, { timeZone })`),
  never against a curated list — browsers report hundreds of zones and a
  shortlist silently rejects most real users.
- Rendered stamps MUST carry a zone label. A shared artifact is read by people
  in other zones, and a bare `10:03` misleads all of them.
- The zone MUST be applied at render time and MUST NOT be baked into stored
  content, so changing a team's zone corrects existing artifacts on their next
  write.

**Acceptance criteria**:
- AC-1: WHEN a signed-in user loads any protected page from a browser whose zone
  differs from their stored one THEN `users.timezone` is updated to the detected
  zone.
- AC-2: GIVEN a user who owns a team with `timezone IS NULL` WHEN their zone is
  recorded THEN that team's timezone is set to the same value; GIVEN the team
  already has a zone THEN it is left unchanged.
- AC-3: GIVEN a user who is a `member` (not owner) of a team with no zone WHEN
  their zone is recorded THEN the team's timezone remains NULL.
- AC-4: WHEN `PUT /api/me/timezone` receives a zone the runtime does not
  recognise THEN it returns 400 and writes nothing.
- AC-5: WHEN a non-admin PATCHes `teams.timezone` THEN the request is rejected
  with 403.
- AC-6: GIVEN a team with `timezone = 'America/New_York'` WHEN a schedule is
  created via `POST /api/workspaces/[id]/schedules` with no `timezone` field
  THEN the stored schedule timezone is `America/New_York`, not `UTC`.
- AC-7: GIVEN a mission schedule stored with `timezone = 'Europe/Berlin'` WHEN
  the mission's cron is edited THEN `nextRunAt` is recomputed in
  `Europe/Berlin`.
- AC-8: WHEN a team has no timezone THEN every surface renders and schedules in
  UTC and no error is raised.

**Code surface**:
- Validation + rendering: `packages/core/timezone.ts` — `isValidTimezone`,
  `resolveTimezone`, `formatStamp`, `DEFAULT_TIMEZONE`
- Lookups + seeding: `apps/web/src/lib/team-timezone.ts` — `getTeamTimezone`,
  `getWorkspaceTimezone`, `getViewerTimezone`, `recordUserTimezone`
- Detection route: `apps/web/src/app/api/me/timezone/route.ts`
- Detection client: `apps/web/src/components/TimezoneSync.tsx`, mounted in
  `apps/web/src/app/app/(protected)/layout.tsx`
- Team setting: `apps/web/src/app/api/teams/[id]/route.ts` (PATCH),
  `apps/web/src/app/app/(protected)/settings/TimezoneSection.tsx`
- Schema: `packages/core/db/schema.ts` — `users.timezone`, `teams.timezone`,
  `taskSchedules.timezone`
- Consumers: `apps/web/src/lib/pr-activity-comment.ts`,
  `apps/web/src/app/api/workspaces/[id]/schedules/route.ts`,
  `apps/web/src/app/api/missions/route.ts`

**Out of scope**: Client-side rendering of timestamps already handled per-viewer
by the browser (`apps/web/src/app/app/(protected)/tasks/LocalTime.tsx`) — those
need no stored zone. Mission active-hours semantics (covered in
`mission-task-lifecycle.md`); this spec only fixes which zone they default to.
DST-boundary cron behaviour, which belongs to the cron evaluator.
