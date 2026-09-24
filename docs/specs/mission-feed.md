---
title: Mission Feed
status: active
owner: builder
last_verified: 2026-09-23
summary: The mission detail page MUST answer "is this done" before listing tasks, and below md MUST render every deliverable exactly once in one grouped list under a sticky masthead.
domain: surfaces
surfaces: ["apps/web/src/app/app/(protected)/missions/[id]/MissionDetailView.tsx", "apps/web/src/app/app/(protected)/missions/[id]/MissionFeedList.tsx", apps/web/src/lib/mission-feed-groups.ts, apps/web/src/lib/mission-delivery.ts]
related: [mission-legibility, mission-structure-view, timeline-dependency-geometry, mission-task-lifecycle]
keywords: [mission detail, mobile, feed, needs you, moving now, slot marker, pulse, masthead, sticky, delivery stepper, records sheet, notes sheet, rail]
verified_by: ["apps/web/src/app/app/(protected)/missions/[id]/MissionDetailView.test.tsx", "apps/web/src/app/app/(protected)/missions/[id]/MissionFeedList.test.tsx", "apps/web/src/app/app/(protected)/missions/[id]/MissionRecordsSheet.test.tsx", apps/web/src/lib/mission-delivery.test.ts, apps/web/src/lib/mission-feed-groups.test.ts, "apps/web/src/app/app/(protected)/missions/[id]/mission-detail-retirements.test.ts"]
supersedes: [timeline-mobile-rail]
# Structural conformance only; passing does not certify every prose invariant.
assertions:
  - id: "feed-model"
    type: "symbol"
    name: "buildMissionFeedGroups"
    path: "apps/web/src/lib/mission-feed-groups.ts"
  - id: "feed-list-reads-feed-model"
    type: "symbol_reachable"
    symbol: "buildMissionFeedGroups"
    entry: "apps/web/src/app/app/(protected)/missions/[id]/MissionFeedList.tsx"
  - id: "detail-view-renders-feed-list"
    type: "symbol_reachable"
    symbol: "MissionFeedList"
    entry: "apps/web/src/app/app/(protected)/missions/[id]/MissionDetailView.tsx"
  - id: "page-renders-detail-view"
    type: "symbol_reachable"
    symbol: "MissionDetailView"
    entry: "apps/web/src/app/app/(protected)/missions/[id]/page.tsx"
  - id: "delivery-model"
    type: "symbol"
    name: "buildDeliverySteps"
    path: "apps/web/src/lib/mission-delivery.ts"
  - id: "detail-order-tests"
    type: "test_file"
    path: "apps/web/src/app/app/(protected)/missions/[id]/MissionDetailView.test.tsx"
  - id: "feed-list-tests"
    type: "test_file"
    path: "apps/web/src/app/app/(protected)/missions/[id]/MissionFeedList.test.tsx"
---

# Mission Feed

**Capability statement**: The mission detail page MUST state whether the
mission is done, what it is waiting on and what is left — the masthead, the
situation and the Delivery line — before it lists any task. Below the `md`
breakpoint it MUST list the mission's deliverables in one grouped list
(`MissionFeedList`) in which every deliverable appears exactly once, under a
masthead that stays on screen while the list scrolls.

This spec supersedes `timeline-mobile-rail.md`: the rail is no longer rendered.
The design and its rationale are in
`docs/design/mission-feed-mobile-continuity.md` (slice S3). The md-and-up
Timeline and Structure views are unchanged and are covered by
`mission-structure-view.md` and `timeline-dependency-geometry.md`.

---

## Invariants

- The render order is: masthead, situation, Delivery, first task row. No task
  row precedes the situation (`MissionDetailView`).
- Below md, each deliverable (`taskClass = 'work'`, after
  `foldMissionDeliverables`) is rendered as exactly one
  `[data-testid=mission-task-row]`. Attempts and cancelled re-creations fold
  under their parent row. Orchestrator and bookkeeping tasks are never rows.
- A deliverable promoted into NEEDS YOU or MOVING NOW leaves exactly one
  `[data-testid=mission-task-slot]` marker in its phase and no second row.
- Folded rows (a finished phase, a future phase past its first three rows, a
  NEEDS YOU row past the third) stay in the DOM with `hidden`, so a `#t-<id>`
  arrival or a pulse focus can reach any row.
- The masthead is `sticky top-0`. Every row's `scroll-margin-top` equals
  `MISSION_MASTHEAD_FOLDED_PX`.
- The header pulse and the list read the same builders (`buildPulseSegments`,
  `buildMissionFeedGroups`) over the same task array, so they count the same
  rows.
- The Delivery line shows only steps with something to say
  (`buildDeliverySteps`). The workspace release queue depth never appears on a
  mission step (`deliveryReleaseInput`).
- The Shipped step reads only this mission's trunk merges
  (`missionTrunkMergedAt`) against the release baseline. A mission with nothing
  merged has no Shipped step; "after next release" means one of its merges is
  newer than the baseline; "released" means none is.
- A slot marker sits at its task's sorted place in the phase and is not a tap
  target.
- `Records · N` counts `selectMissionRecords` and opens a sheet listing exactly
  those. Other artifacts are one tap further in the same sheet. The page has
  no unfiltered artifact list.
- No row sets `data-task-actionable`.

## Acceptance criteria

- AC-1: GIVEN a mission with 3, 15 or 45 tasks WHEN the detail page renders
  THEN `mission-masthead` precedes `mission-situation`, which precedes
  `mission-delivery`, which precedes the first `mission-task-row`.
- AC-2: GIVEN any mission WHEN the mobile list renders THEN the number of
  `mission-task-row` elements equals the number of deliverables, and each
  deliverable id appears on exactly one row.
- AC-3: GIVEN a deliverable in NEEDS YOU or MOVING NOW WHEN the list renders
  THEN its phase contains exactly one `mission-task-slot` for it.
- AC-4: GIVEN five NEEDS YOU rows WHEN the list renders THEN three are visible,
  two are in a `hidden` overflow, and a `+2 more` control is shown.
- AC-5: GIVEN a finished phase WHEN the list renders THEN its header reports
  `✓ done/total` with `aria-expanded="false"`, and a reveal of one of its rows
  flips it to `aria-expanded="true"`.
- AC-6: GIVEN an attempt task or an orchestrator planning task WHEN the list
  renders THEN it has no `mission-task-row`.
- AC-7: GIVEN a mission with no tasks, no criteria and no budget WHEN Delivery
  is built THEN it has no steps and renders nothing.
- AC-8: GIVEN a workspace with no release flow, or a gated workspace with no
  resolvable baseline WHEN Delivery is built THEN it has no Shipped step.
- AC-8a: GIVEN a mission with no merged work and a workspace queue holding
  another mission's merges WHEN Delivery is built THEN it has no Shipped step;
  GIVEN a mission whose merges all predate the release baseline WHEN another
  mission merges after it THEN its Shipped step still reads "released".
- AC-9: GIVEN a mission with artifacts, some review-worthy WHEN the Records
  sheet opens THEN it lists only the review-worthy ones until "All artifacts"
  is tapped.
- AC-10: GIVEN the code in `apps/` and `packages/` WHEN searched THEN it
  contains no rail component, no title-reading lane classifier, no
  "See Goal Criteria above" copy and no `#mission-goal-criteria` anchor.

## Code surface

- `apps/web/src/app/app/(protected)/missions/[id]/page.tsx` — loads the
  mission and builds the feed input, the pulse, the Delivery steps and the
  sheets' data.
- `apps/web/src/app/app/(protected)/missions/[id]/MissionDetailView.tsx` —
  the render order (`MissionDetailView`, `mastheadBack`).
- `apps/web/src/app/app/(protected)/missions/[id]/MissionFeedList.tsx` — the
  mobile list, the freeze gate and the reorder slide (`flipDeltas`).
- `apps/web/src/app/app/(protected)/missions/[id]/MissionDelivery.tsx` and
  `apps/web/src/lib/mission-delivery.ts` — the Delivery line
  (`buildDeliverySteps`, `formatDeliverySummary`, `deliveryReleaseInput`,
  `missionTrunkMergedAt`).
- `apps/web/src/app/app/(protected)/missions/[id]/mission-feed-view.ts` — the
  page's one feed derivation (`buildMissionFeedView`).
- `apps/web/src/app/app/(protected)/missions/[id]/MissionRecordsSheet.tsx` —
  the Records sheet (`resolveInitialRecordsView`).
- `apps/web/src/app/app/(protected)/missions/[id]/MissionFeed.tsx` — the
  Notes sheet (`MissionNotesSheet`).
- `apps/web/src/app/app/(protected)/missions/[id]/MissionStripControls.tsx` —
  the mobile ⤢ flight-detail sheet, the md+ inline strip and the masthead
  click guard.
- `apps/web/src/lib/mission-feed-groups.ts`, `apps/web/src/lib/mission-pulse.ts`
  — the shared model.

## Out of scope

- What opens when a row is tapped (the task sheet) and its history rules.
- The md-and-up list, which remains the Timeline and Structure toggle.
- Realtime refresh cadence and the RSC payload size.
- Mission and task cards on Home and the missions list.
