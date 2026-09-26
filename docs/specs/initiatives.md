---
title: Initiatives
status: active
owner: max
last_verified: 2026-09-26
summary: An initiative MUST be a container above missions with a human-set status, owner and optional target date; progress MUST be missions done over missions, and attention MUST come from its missions.
domain: surfaces
surfaces: [apps/web/src/lib/initiative-view.ts, apps/web/src/lib/initiative-cards.ts, apps/web/src/components/initiatives/InitiativeCard.tsx, apps/web/src/app/api/initiatives/[id]/route.ts]
related: [surface-ia-home-missions-initiatives, mission-task-lifecycle]
keywords: [initiative status, planned, target date, owner, mark completed, Linear initiative, losing, stuck, ready to close, dormant, unverified, arcs, KPI]
verified_by: [apps/web/src/lib/initiative-view.test.ts, apps/web/src/components/initiatives/InitiativeCard.test.tsx, apps/web/src/app/api/initiatives/[id]/route.test.ts, apps/web/src/app/api/initiatives/route.test.ts, apps/web/src/lib/initiative-list.test.ts, packages/core/__tests__/mcp-tools-initiatives.test.ts]
supersedes: []
# Structural conformance only; passing does not certify every prose invariant.
assertions:
  - id: "initiative-card-builder"
    type: "symbol"
    name: "buildInitiativeCard"
    path: "apps/web/src/lib/initiative-view.ts"
  - id: "initiative-card-loader"
    type: "symbol"
    name: "loadInitiativeCards"
    path: "apps/web/src/lib/initiative-cards.ts"
  - id: "initiative-view-tests"
    type: "test_file"
    path: "apps/web/src/lib/initiative-view.test.ts"
---

# Initiatives

**Capability statement**: An initiative is a named container above missions,
the way a Linear initiative sits above projects. It carries a title, a short
description, an owner, an optional target date, a status a person sets, and its
missions. The Initiatives list and the initiative page MUST show that status,
progress as missions done over missions, and whatever its missions need from
you, each as a fact with a link. Nothing grades the initiative itself.

This replaced a derived verdict (`Losing`, `Stuck`, `Ready to close`,
`Dormant`, `unverified`) computed from a 7-day merge and retry window, KPI
evaluations and hold flags. That verdict could read `Losing` on an initiative
whose every mission and task was done, `Stuck · 1 held` at 100% because a
finished mission kept its hold flag, and `Ready to close · unverified` at 3/4
tasks. The row drew a 14-day token sparkline next to the percentage, which read
as an empty progress bar beside `100%`. See
`docs/design/initiatives-as-containers.md`.

**Invariants**

- `initiatives.status` is one of `planned`, `active`, `paused`, `completed`,
  `archived`. Only a person (dashboard, API, MCP) writes it. No job, sweep or
  render derives or advances it.
- Progress is `done / total` over the initiative's non-archived missions, where
  done means the mission's own card model says `done`. The list and the page
  show it as `n/N missions done`, with task totals as secondary text. They show
  no percentage.
- The bar draws exactly one segment per non-archived mission. A done mission's
  segment is solid; an open mission's segment fills to its tasks done over its
  tasks. The number of solid segments therefore always equals `n`.
- Attention is a fact about missions: `N missions need you` (a parked question
  or an ask on an open mission), `N missions held` (open missions only; a
  completed mission never counts as held), `All N missions done` (every mission
  done, initiative not completed). Each fact that names a mission links to it.
- The card offers at most one next action, in this order: answer the first ask,
  arm the first held mission, mark the initiative completed, add a first
  mission, open it. A completed or archived initiative offers none.
- The list groups cards as Needs you, Active, Planned, Paused, Completed, in that
  order, drops empty groups, and collapses Completed behind one control.
  Archived initiatives are not listed.
- The list and the page read one loader, `loadInitiativeCards`, and each
  mission through the Missions tab's card model (`buildMissionListCard`), so a
  mission's status word and n/N match the Missions tab.
- Initiative KPIs (`kpis`, `kpiState`, `autoVerify`, `POST /api/initiatives/[id]/evaluate`,
  MCP `evaluate` / `get_kpi_state`) are deprecated. They still work through the
  API and MCP, no surface renders them, and agent prompts do not carry them.

**Acceptance criteria**

- AC-1: GIVEN an active initiative whose 4 missions are all done, WHEN its card
  renders, THEN its status reads `Active`, it shows `All 4 missions done`, its
  action is `Mark completed`, and no verdict word appears.
- AC-2: GIVEN 2 done missions and 1 open mission at 2/4 tasks, WHEN the card
  renders, THEN it shows `2/3 missions done`, 3 bar segments, 2 of them solid,
  and the open segment filled to half.
- AC-3: GIVEN a paused initiative with a completed mission whose hold flag is
  still set, WHEN the card renders, THEN it shows no held fact and sits in the
  Paused group.
- AC-4: GIVEN an open mission with a parked question, WHEN the card renders,
  THEN it shows `1 mission needs you` linking to that question and its action
  is `Answer`.
- AC-5: GIVEN an open held mission and no ask, WHEN the card renders, THEN its
  action is `Arm` for that mission.
- AC-6: WHEN `PATCH /api/initiatives/[id]` receives `status: "planned"`, THEN it
  stores `planned`; WHEN it receives `status: "bogus"`, THEN it rejects with
  HTTP 400.
- AC-7: WHEN `PATCH /api/initiatives/[id]` receives `targetDate: "2026-02-30"` or
  `"next week"`, THEN it rejects with HTTP 400 and writes nothing; `null` clears
  the date.
- AC-8: WHEN `PATCH /api/initiatives/[id]` receives an `ownerUserId` who is not a
  member of the initiative's team, THEN it rejects with HTTP 400.
- AC-9: WHEN `POST /api/initiatives` omits `ownerUserId`, THEN the owner is the
  creating user.
- AC-10: GIVEN a target date 6 days past on an active initiative, WHEN the card
  renders, THEN it reads `6d overdue`; on a completed initiative it reads
  `Target <date>` and is never overdue.

**Code surface**

- `apps/web/src/lib/initiative-view.ts`: `buildInitiativeCard`,
  `groupInitiativeCards`, `initiativesHeadline`, `targetDateLabel`,
  `INITIATIVE_STATUS_LABEL`. Pure, client-safe.
- `apps/web/src/lib/initiative-cards.ts`: `loadInitiativeCards`, the one loader
  for the list and the page.
- `apps/web/src/lib/initiative-fields.ts`: `parseInitiativeStatus`,
  `parseTargetDate`, `parseOwnerUserId`, shared by POST and PATCH.
- `apps/web/src/components/initiatives/InitiativeCard.tsx` and
  `apps/web/src/components/initiatives/InitiativeStatusControl.tsx`.
- `apps/web/src/app/app/(protected)/initiatives/page.tsx`,
  `apps/web/src/app/app/(protected)/initiatives/[id]/page.tsx`.
- `apps/web/src/app/api/initiatives/route.ts`,
  `apps/web/src/app/api/initiatives/[id]/route.ts`.
- `packages/core/db/schema.ts`: `initiatives.ownerUserId`, `initiatives.targetDate`.
- `packages/core/mcp-tools.ts`: `manage_initiatives`.

**Out of scope**

- Initiative updates (Linear's periodic status posts). Not built.
- A declared health (`On track` / `At risk`). Not built; status is lifecycle only.
- Removing the deprecated KPI fields and the `progress_cache` column. A later
  release drops them under the schema-change skill's drop protocol.
