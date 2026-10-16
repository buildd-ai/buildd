---
title: Mission Goal Criteria Display
status: active
owner: max
last_verified: 2026-10-11
summary: A goal criterion's glyph and its live value MUST come from one evaluation, and a complete count nothing has evaluated reads "not checked", never unmet.
domain: surfaces
surfaces: [apps/web/src/lib/mission-board.ts, apps/web/src/components/ui/Criteria.tsx, apps/web/src/lib/mission-overview.ts]
related: [mission-goal-criteria-quality, mission-legibility, mission-progress-strip-ordering]
keywords: [Goal panel, goal criteria, PRs merged, open tasks, not checked, unchecked, unmet circle, landed, overview counts, criterion box]
verified_by: [apps/web/src/app/app/(protected)/missions/[id]/MissionGoalPanel.dom.test.tsx, apps/web/src/lib/mission-board.test.ts, apps/web/src/lib/mission-overview.test.ts]
supersedes: []
assertions:
  - id: "board-criterion-state"
    type: "symbol"
    name: "BoardCriterionState"
    path: "apps/web/src/lib/mission-board.ts"
  - id: "build-mission-board"
    type: "symbol"
    name: "buildMissionBoard"
    path: "apps/web/src/lib/mission-board.ts"
  - id: "overview-counts"
    type: "symbol"
    name: "overviewCounts"
    path: "apps/web/src/lib/mission-overview.ts"
  - id: "criterion-box"
    type: "symbol"
    name: "CriterionBox"
    path: "apps/web/src/app/app/(protected)/missions/[id]/MissionBoardParts.tsx"
---

# Mission Goal Criteria Display

**Status: active.** Every acceptance criterion below is asserted by a test in
`verified_by`.

## Why

The mission page's Goal panel showed a `PRs merged` criterion with a full live
ratio (N/N) beside the unmet glyph, because no verdict was on record yet. The
header above it counted "merged" over a different set of tasks than the
criterion did, so one screen showed two different merged counts. Both were
display bugs: neither count was wrong, but the page contradicted itself.

## Goal criteria display

**Capability statement**: Each goal criterion row on the mission Board and the
mission Overview MUST derive its glyph and its value from a single
`BoardCriterionState` computed by `buildMissionBoard`, and the mission header
MUST name its task count so that it cannot be read as the criterion's PR count.

**Invariants**:

- A criterion's glyph and its value come from the same evaluation: one
  `BoardCriterion` (state, value, fill) per criterion, built in one place
  (`criterionRow` inside `buildMissionBoard`). No surface recomputes the state
  from the value or from the stored verdict on its own.
- An unevaluated complete count is `unchecked`. That means an `all_prs_merged`
  criterion at N/N with N > 0, or a `no_open_tasks` criterion at 0 open over a
  non-empty mission, whose stored verdict is absent, `UNVERIFIED` or
  `NOT_EVALUATED`. It renders as "not checked": a dashed box labelled
  "Not checked" on the Board, `◌` with "not checked" after the value on
  the Overview. It MUST NOT render the unmet glyph (`○`, or the empty or
  tickless box), and it MUST NOT count as passed.
- The live count is not promoted to a pass. The criterion evaluator reads
  more than the board does (superseded PRs, trunk reach on integration-branch
  missions), so only a stored `pass` verdict renders as met.
- A stored `fail` verdict on a complete count still renders as a fail.
- An incomplete count (some but not all PRs merged) stays `partial`,
  whatever the stored verdict says, unless that verdict is `pass`.
- The header's count and the criterion's count are different sets with
  different names. The header (`overviewCounts`) counts landed tasks (BoardStatus
  `merged` or `done`, with or without a PR) and says "landed". The `PRs merged`
  criterion counts PR-bearing tasks only and says "merged".

**Acceptance criteria**:

- AC-1: GIVEN a mission whose PR-bearing tasks are all merged and an
  `all_prs_merged` criterion with no stored verdict, WHEN `buildMissionBoard`
  runs, THEN that criterion's state is `unchecked` and its value is `N/N`.
- AC-2: GIVEN the same mission with stored verdicts `UNVERIFIED` or
  `NOT_EVALUATED`, WHEN `buildMissionBoard` runs, THEN `all_prs_merged` and a
  `no_open_tasks` criterion at 0 open are both `unchecked`, and
  `criteriaPassed` does not count them.
- AC-3: GIVEN an `all_prs_merged` criterion at N/N with a stored `fail`
  verdict, WHEN `buildMissionBoard` runs, THEN its state is `fail`, not
  `unchecked`.
- AC-4: GIVEN an `all_prs_merged` criterion with some but not all PRs merged
  and no verdict, WHEN `buildMissionBoard` runs, THEN its state is `partial`.
- AC-5: GIVEN an `unchecked` criterion, WHEN the Overview rail renders it,
  THEN its row has `data-state="unchecked"`, its glyph is neither `○` nor `✓`,
  its text reads "Not checked" and not "Unmet", and its value is still
  shown.
- AC-6: GIVEN an `unchecked` criterion, WHEN the Board goal cell renders it,
  THEN its box has `data-state="unchecked"` and the label "Not checked",
  and the row still shows the value.
- AC-7: GIVEN a mission model with some landed tasks, WHEN `overviewCounts`
  formats the header, THEN it reads `X of Y landed` (followed by
  `A of B criteria` when there are criteria) and never `X of Y merged`.

**Code surface**:

- `apps/web/src/lib/mission-board.ts`: `BoardCriterionState` (includes
  `unchecked`), the criterion row builder inside `buildMissionBoard`.
- `apps/web/src/app/app/(protected)/missions/[id]/MissionBoardParts.tsx`:
  `CriterionBox`, the Board's per-state box.
- `apps/web/src/app/app/(protected)/missions/[id]/MissionBoard.tsx`: `GoalCell`,
  the Board's Goal band.
- `apps/web/src/components/ui/Criteria.tsx`: the Overview rail's criteria list
  (met, unchecked, unmet).
- `apps/web/src/app/app/(protected)/missions/[id]/MissionOverview.tsx`: maps
  each board criterion onto the rail's list.
- `apps/web/src/lib/mission-overview.ts`: `overviewCounts`, the header line.

**Out of scope**:

- How criteria are evaluated and stored (`goalCriteriaState`, the evaluator,
  `canCompleteMission`). This spec covers display only.
- The Goal criteria sheet (`MissionGoalCriteria.tsx`), which shows the stored
  verdict per criterion and has no live count.
- Grading criteria on write: see `mission-goal-criteria-quality`.
