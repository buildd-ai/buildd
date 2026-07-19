---
title: Team Namespace Scoping
status: active
owner: max
last_verified: 2026-07-18
supersedes: []
---
# Team Namespace Scoping

How "team" organizes workspaces and missions in the dashboard. Today team is a
real boundary in the DB/API and in creation forms, but the `buildd-team`
active-team cookie is cosmetic: `/app/workspaces`, `/app/missions`, and the home
page list everything across every team the user belongs to and merely *label*
rows with a team name (see `layout.tsx` reads the cookie but never filters;
`GET /api/workspaces` and `GET /api/missions` return all of the user's teams).

This spec defines a **global Home + namespaced working views** model:

- **Home is cross-team.** It aggregates across every team the user belongs to.
  It is the landing and find surface, and it MUST NOT be filtered by the active
  team.
- **Missions and Workspaces are namespaced** to a single active team.
- The **active team** is the `buildd-team` cookie. It scopes the working views
  and seeds creation defaults. Navigating into an item from Home re-scopes the
  active team to that item's team.

Status legend: ✅ implemented · ⚠️ partial · ❌ not yet built (this spec is the
target; most items below are ❌ pending the PR).

Out of scope for this spec/PR: full URL path namespacing
(`/app/t/[teamSlug]/…`) — a deep-linkable follow-up; task-level scoping; team
RBAC changes; secrets (already team-scoped).

---

## Active team resolution ✅

**Capability statement**: The system MUST resolve exactly one active team for a
session from the `buildd-team` cookie, falling back deterministically when the
cookie is absent or invalid, and this resolved team MUST be the single source of
truth for scoped views.

**Invariants**:
- The active team MUST be a team the current user is a member of.
- If the cookie is missing, points to a team the user is not a member of, or
  references a deleted team, resolution MUST fall back to the user's default
  team (personal team first, else first team by stable order).
- Active-team resolution MUST be performed server-side (not trusted from client
  state alone).

**Acceptance criteria**:
- AC-1: GIVEN a `buildd-team` cookie naming a team the user belongs to, WHEN any
  scoped page or scoped API route loads, THEN that team is the active team.
- AC-2: GIVEN no `buildd-team` cookie, WHEN a scoped view loads, THEN the active
  team resolves to the user's personal team if one exists, else the first team.
- AC-3 (error): GIVEN a `buildd-team` cookie naming a team the user is NOT a
  member of, WHEN a scoped view loads, THEN the cookie value is ignored and the
  default team is used (no 500, no leak of the other team's data).

**Code surface**:
- `apps/web/src/components/TeamSwitcher.tsx` (sets cookie)
- `apps/web/src/app/app/(protected)/layout.tsx` (reads cookie, validates against
  `getUserTeamIds`)
- New shared helper, e.g. `resolveActiveTeamId(user, cookieValue)` in
  `apps/web/src/lib/team-access.ts`
- Model: `packages/core/db/schema.ts` (`teams`, `teamMembers`)

**Out of scope**: Switching mechanism UX (see "Team switch re-scopes").

---

## Home is cross-team ✅ (must stay cross-team)

**Capability statement**: The home view MUST aggregate missions, active workers,
and recent activity across ALL teams the user belongs to, independent of the
active team, with each item attributed to its owning team.

**Invariants**:
- Home queries MUST scope by the union of the user's team IDs, never by the
  single active team.
- Every mission/workspace/worker row on Home MUST carry a team label.

**Acceptance criteria**:
- AC-1: GIVEN a user in teams A and B with missions in both, WHEN Home loads,
  THEN missions from both A and B are listed.
- AC-2: GIVEN the active team is A, WHEN Home loads, THEN changing the active
  team to B does NOT change which items Home shows (Home is team-agnostic).
- AC-3: WHEN Home renders a mission/worker row, THEN the row displays the name of
  its owning team.
- AC-4 (error): GIVEN a user in zero teams, WHEN Home loads, THEN it renders an
  empty state (no crash, no query against an empty team-id list that returns
  another user's data).

**Code surface**:
- `apps/web/src/app/app/(protected)/home/page.tsx` (queries
  `inArray(missions.teamId, teamIds)` across all teams — keep)
- `apps/web/src/lib/team-access.ts` (`getUserTeamIds`)

**Out of scope**: Home layout/visual grouping.

---

## Missions list is team-scoped ✅

**Capability statement**: The missions list view MUST show only missions owned by
the active team; switching the active team MUST change the set shown.

**Invariants**:
- `GET /api/missions` MUST accept a `teamId` filter and, when present, return
  only missions with that `teamId`.
- When no `teamId` is supplied, the missions list page MUST supply the active
  team (resolved server-side) — it MUST NOT default to all teams.
- The endpoint MUST reject a `teamId` the user is not a member of.

**Acceptance criteria**:
- AC-1: GIVEN active team A, WHEN `/app/missions` loads, THEN only team A's
  missions are listed (team B's are absent).
- AC-2: GIVEN `GET /api/missions?teamId=A`, WHEN the user is a member of A, THEN
  the response contains only missions where `teamId === A`.
- AC-3: WHEN the active team changes from A to B, THEN reloading `/app/missions`
  shows team B's missions and not team A's.
- AC-4 (error): GIVEN `GET /api/missions?teamId=X` where the user is not a member
  of X, THEN the request is rejected (HTTP 403) or treated as empty — never
  returns X's missions.

**Code surface**:
- `apps/web/src/app/app/(protected)/missions/page.tsx` (currently
  `inArray(missions.teamId, teamIds)` across all teams — scope to active team)
- `apps/web/src/app/api/missions/route.ts` (GET — add `teamId` filter +
  membership check)
- Model: `packages/core/db/schema.ts` (`missions.teamId`)

**Out of scope**: Mission creation (covered by creation defaults below).

---

## Workspaces list is team-scoped ✅

**Capability statement**: The workspaces list view MUST show only workspaces owned
by the active team; switching the active team MUST change the set shown.

**Invariants**:
- `GET /api/workspaces` (session auth) MUST accept a `teamId` filter and, when
  present, return only workspaces with that `teamId`.
- The workspaces list page MUST supply the active team when no explicit filter is
  given — it MUST NOT default to all of the user's workspaces.
- API-key auth behavior (account-linked + open workspaces) is unchanged; team
  scoping applies to session (dashboard) auth.

**Acceptance criteria**:
- AC-1: GIVEN active team A, WHEN `/app/workspaces` loads, THEN only team A's
  workspaces are listed.
- AC-2: GIVEN `GET /api/workspaces?teamId=A` with session auth and the user a
  member of A, THEN every returned workspace has `teamId === A`.
- AC-3: WHEN the active team changes to B, THEN `/app/workspaces` shows team B's
  workspaces.
- AC-4 (error): GIVEN `?teamId=X` where the user is not a member of X, THEN the
  response excludes X's workspaces (empty or HTTP 403).

**Code surface**:
- `apps/web/src/app/app/(protected)/workspaces/page.tsx` (currently
  `getUserWorkspaceIds(user.id)` across all teams)
- `apps/web/src/app/api/workspaces/route.ts` (GET — add `teamId` filter)
- `apps/web/src/lib/team-access.ts` (`getUserWorkspaceIds` — add team-scoped
  variant)

**Out of scope**: Settings page workspace list (may remain global for admin).

---

## Navigating from Home re-scopes the active team ❌

**Capability statement**: When the user opens a mission or workspace from a
cross-team surface (Home, search), the system MUST set the active team to that
item's owning team so subsequent scoped views are coherent.

**Invariants**:
- Opening an item whose team differs from the current active team MUST update the
  `buildd-team` cookie to the item's team.
- Re-scoping MUST NOT change which item the user opened (no redirect away from
  the target).

**Acceptance criteria**:
- AC-1: GIVEN active team A, WHEN the user opens a team-B mission from Home, THEN
  the mission detail renders AND the active team becomes B.
- AC-2: GIVEN the active team became B per AC-1, WHEN the user then opens
  `/app/missions`, THEN team B's missions are shown.
- AC-3 (error): GIVEN the user opens an item in a team they were removed from,
  THEN the active team is NOT changed to that team and access is denied.

**Code surface**:
- Mission detail / workspace detail server components under
  `apps/web/src/app/app/(protected)/missions/[id]/` and `workspaces/[id]/`
- Active-team cookie writer (shared with `TeamSwitcher`)

**Out of scope**: Deep-link URL slug form.

---

## Creation defaults to the active team ⚠️ (mission done, workspace pending)

**Capability statement**: Workspace and mission creation MUST default to the
active team (not the personal/first team), while still allowing an explicit
choice when the user belongs to multiple teams.

**Invariants**:
- The pre-selected team in `/app/workspaces/new` and `/app/missions/new` MUST be
  the active team.
- Submitting without an explicit `teamId` MUST create the resource in the active
  team.

**Acceptance criteria**:
- AC-1: GIVEN active team B, WHEN `/app/workspaces/new` loads, THEN the Team
  selector defaults to B.
- AC-2: GIVEN active team B, WHEN a mission is created without choosing a team,
  THEN the mission's `teamId` is B.
- AC-3 (error): GIVEN active team B, WHEN the user explicitly selects team A and
  submits, THEN the resource is created in A (explicit choice overrides default).

**Code surface**:
- `apps/web/src/app/app/(protected)/workspaces/new/page.tsx` (`loadTeams` —
  currently defaults to personal team)
- `apps/web/src/app/app/(protected)/missions/new/NewMissionForm.tsx` (reads
  `localStorage 'buildd:lastTeamId'` — replace with active-team cookie)
- Routes: `api/workspaces/route.ts`, `api/missions/route.ts` (POST team
  resolution)

**Out of scope**: Reconciling the localStorage `buildd:lastTeamId` vs the cookie
beyond mission creation.

---

## Team switch re-scopes the app ✅

**Capability statement**: A persistent team switcher MUST let the user change the
active team in one action; doing so MUST re-scope all namespaced views and MUST
leave Home cross-team.

**Invariants**:
- The switcher MUST be reachable from primary navigation (not only Settings),
  and MUST be usable on mobile without typing.
- Switching MUST persist the choice (`buildd-team` cookie) across reloads.

**Acceptance criteria**:
- AC-1: WHEN the user selects team B in the switcher, THEN the `buildd-team`
  cookie is set to B and the scoped views show team B.
- AC-2: GIVEN the user switched to B, WHEN they return in a later session, THEN
  the active team is still B.
- AC-3: WHEN the active team is switched, THEN Home's contents do not change.
- AC-4 (error): GIVEN the switcher lists only teams the user belongs to, WHEN a
  team the user was removed from is no longer returned by `GET /api/teams`, THEN
  it MUST NOT appear as a switch target.

**Code surface**:
- `apps/web/src/components/TeamSwitcher.tsx`
- `apps/web/src/components/MissionsSidebar.tsx` (surface the switcher in primary
  nav)
- `apps/web/src/app/api/teams/route.ts` (GET team list)

**Out of scope**: Command palette / global search accelerator (deferred; not
required for the mobile-first model).

---

## Activity count consistency ✅

**Capability statement**: Any count or status badge derived from active workers
MUST be computed from the same query semantics and the same scope as every other
surface showing worker activity for that scope. Contradictory concurrent states
across tabs/views are a defect.

**Invariants**:
- The active-worker count shown on any surface (Team header, Activity tab, Home
  "Right Now") for a given team/workspace scope MUST derive from the same filter:
  workers with `status IN ('running', 'starting', 'waiting_input')` in
  `workspaceId IN <scope>`.
- Role attribution (mapping a running worker to a named role via `task.roleSlug`
  or `task.context.skillSlugs`) is a supplementary display hint — it MUST NOT
  affect the *total* active count shown in the Team view header.
- If workers are running but none are attributed to a configured role, the Team
  header MUST still show an "active" state (not "Idle") and indicate the unattributed
  worker count so the user can investigate.

**Acceptance criteria**:
- AC-1: GIVEN N workers running in workspace W, WHEN the Team tab and Activity tab
  are viewed at the same moment, THEN both surfaces show N as the active count for
  workspace W.
- AC-2: GIVEN a running worker whose task has `roleSlug = NULL` and no
  `skillSlugs` in context, WHEN the Team page loads, THEN the Team header shows
  the worker as active (not idle), even though no role card claims attribution.
- AC-3: GIVEN 2 Builder workers running simultaneously, WHEN the Team page loads,
  THEN the Builder card shows "Running · 2" (or equivalent), not "Running".
- AC-4 (error): GIVEN zero active workers, WHEN the Team page loads, THEN the
  header shows "Idle" — NOT a count of 0.

**Code surface**:
- `apps/web/src/app/app/(protected)/team/page.tsx` — `totalActiveWorkerCount` is
  derived from `activeWorkers.length` (all workers in scope), separate from role
  attribution logic.
- `apps/web/src/app/app/(protected)/team/TeamGrid.tsx` — header badge uses
  `totalActiveWorkerCount`; unattributed workers surfaced in idle section label.
- Test: `apps/web/src/app/app/(protected)/team/page.test.ts` — covers the
  unattributed-worker case (AC-2).
