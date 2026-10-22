---
title: Mission Feed
status: active
owner: builder
last_verified: 2026-10-22
summary: The mission detail page MUST answer "is this done" before listing tasks, and below md MUST render every deliverable exactly once in one grouped list under a sticky masthead.
domain: surfaces
surfaces: ["apps/web/src/app/app/(protected)/missions/[id]/MissionDetailView.tsx", "apps/web/src/app/app/(protected)/missions/[id]/MissionFeedList.tsx", apps/web/src/lib/mission-feed-groups.ts, apps/web/src/lib/mission-delivery.ts]
related: [mission-legibility, mission-structure-view, timeline-dependency-geometry, mission-task-lifecycle]
keywords: [mission detail, status vocabulary, live line, Closed → #N, Retry now, mobile, feed, needs you, moving now, slot marker, pulse, masthead, sticky, delivery stepper, records sheet, notes sheet, rail]
verified_by: ["apps/web/src/app/app/(protected)/missions/[id]/MissionDetailView.test.tsx", apps/web/src/lib/mission-overview.test.ts, "apps/web/src/app/app/(protected)/missions/[id]/MissionOverview.test.tsx", "apps/web/src/app/app/(protected)/missions/[id]/MissionFeedList.test.tsx", "apps/web/src/app/app/(protected)/missions/[id]/MissionRecordsSheet.test.tsx", apps/web/src/lib/mission-delivery.test.ts, apps/web/src/lib/mission-feed-groups.test.ts, "apps/web/src/app/app/(protected)/missions/[id]/mission-detail-retirements.test.ts"]
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
`knowledge-base: buildd/design/mission-feed-mobile-continuity.md` (slice S3). The md-and-up
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

## Status vocabulary (the Overview's strip and focus card)

The mission page says each task's true state in one word, as GitHub and
Vercel do. A cell and its card use one vocabulary, in the terms catalog's
words (`packages/shared/src/terms.ts`, which bans "Queued" and "Running" as
labels): `Ready` / `Blocked` (waiting for a slot, on tasks or a start time,
with that cause), `Working`, `Failed` (with its cause: `CI failed`,
`Merge conflict`), `Merged`, `Closed`, `Closed → #N`. Other states (in review,
merging, an agent's question) read the delivery's own label. The card shows
one status dot, one word and at most one short cause
(`overviewStatus` in `apps/web/src/lib/mission-overview.ts`). No sentences and
no "Next" paragraph on the card.

- **True state wins.** A task whose PR has failing checks or a conflict reads
  `Failed · CI failed` (or `· Merge conflict`), never `Ready`, even while a
  retry backoff is pending; the backoff reads `Retry in 3h 52m` beside a
  `Retry now` action. Derived from the page's one delivery projection
  (`mission-progress-strip-ordering.md` R-8a), no new state store.
- **Live line.** A running task reads `Working 12m 04s`, ticking client-side
  from the worker's start, then its latest milestone as the cause
  (`Running unit tests`), then `Updated 14s ago` from its last event (the
  worker's newest write or milestone, `lastEventOf`; live heartbeats move it
  between renders). Past the stale-worker threshold
  (`STALENESS_THRESHOLD_MS`, the rule `isStaleWorker` applies) it reads
  `No activity for 12m` in the warning tone. No spinner.
- **Estimate.** `Est. 40 min` and a thin elapsed/expected bar show only for a
  running task with a frozen estimate `task-estimates.md` allows showing (the
  rows the page already loads for the build estimate). Never a mission
  completion date.
- **Flow.** The card's Build / Verify / Deliver is one line at 320px
  (`Build ✓  Verify  Deliver`, `Lifecycle variant="line"`): no arrows, and only
  the current step takes colour.
- **No legend row.** Beside the strip the page says `1 of 6 merged` (build
  tasks, `overviewMergedLine`). A cell's state is named on its own card.
- **Header.** An outcome spec reads `Spec r1 · Draft`, linking to the spec,
  and `Passing` / `Failing` only once a verdict exists; never "not checked".
  The card's reason line reads `Blocks 04, 06` (R-12a of the strip spec).
- **Closed → #N.** A task whose PR closed unmerged reads `Closed`, in the
  neutral tone (no ✕). When a replacement is known, from a close comment
  (`Replaced by #N`), a PR body (`replaces #N`) or a person's
  `Link replacement`, it reads `Closed → #N`, linking it, before the
  replacement merges (`workers.namedReplacementPrNumber`). The formal
  supersession still records on merge; the named link never satisfies a
  completion or merge gate.

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
- AC-11: GIVEN a pending task whose PR has red CI and whose retry starts in
  3h 52m WHEN its card renders THEN it reads `Failed · CI failed`,
  `Retry in 3h 52m` and offers `Retry now`; it never reads `Ready` or
  `Scheduled start`.
- AC-12: GIVEN a running task WHEN its card renders THEN it reads
  `Working <clock>`, its latest milestone and `Updated <span> ago`; GIVEN no
  event for more than `STALENESS_THRESHOLD_MS` THEN it reads
  `No activity for <span>` in the warning tone.
- AC-13: GIVEN a running task with no frozen estimate WHEN its card renders
  THEN no `Est.` text or bar appears; with one, `Est. 40 min` and the bar do,
  and no date.
- AC-14: GIVEN the Overview WHEN it renders THEN there is no legend row of
  states, the counts line reads `N of M merged`, and the card's flow is one
  line with no arrows.
- AC-15: GIVEN a closed, unshipped PR with a named replacement #N WHEN its
  card and cell render THEN they read `Closed → #N` (linked, neutral, no ✕);
  with none, `Closed` and a `Link replacement` action.
- AC-16: GIVEN an outcome spec on a proposed revision with no verdict WHEN the
  header renders THEN it reads `Spec r1 · Draft` and not "not checked".

## Code surface

- `apps/web/src/app/app/(protected)/missions/[id]/page.tsx` — loads the
  mission and builds the feed input, the pulse, the Delivery steps and the
  sheets' data.
- `apps/web/src/app/app/(protected)/missions/[id]/MissionDetailView.tsx` —
  the render order (`MissionDetailView`, `mastheadBack`).
- `apps/web/src/app/app/(protected)/missions/[id]/MissionFeedList.tsx` — the
  mobile list, the freeze gate and the reorder slide (`flipDeltas`).
- `apps/web/src/lib/mission-delivery.ts` — the Delivery steps
  (`buildDeliverySteps`, `formatDeliverySummary`, `deliveryReleaseInput`,
  `missionTrunkMergedAt`), rendered as the footer's Shipped row
  (`MissionReleaseSection.tsx`) and Screens row (`MissionScreensRow.tsx`).
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
- `apps/web/src/lib/mission-overview.ts` — the status vocabulary
  (`overviewStatus`, `liveLine`, `taskEstimate`, `overviewMergedLine`), rendered
  by `FocusStatus` in `apps/web/src/app/app/(protected)/missions/[id]/MissionOverview.tsx`.
- `apps/web/src/lib/pr-named-replacement.ts`,
  `apps/web/src/lib/pr-named-replacement-store.ts` — reading and recording a
  named replacement (webhook, `close_pr`, `POST /api/workers/[id]/replacement`).

## Out of scope

- What opens when a row is tapped (the task sheet) and its history rules.
- The md-and-up list, which remains the Timeline and Structure toggle.
- Realtime refresh cadence and the RSC payload size.
- Mission and task cards on Home and the missions list.
