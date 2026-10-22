---
title: Mission Flow Timeline
status: active
owner: builder
last_verified: 2026-10-22
summary: The mission Flow tab MUST draw one row per task in dependency order on one time axis, every gate as an edge lit by the strip's relation rule, and one sentence naming what sets the finish.
domain: surfaces
surfaces: [apps/web/src/lib/flow-timeline.ts, "apps/web/src/app/app/(protected)/missions/[id]/FlowTimeline.tsx", apps/web/src/lib/mission-layout.ts, apps/web/src/lib/mission-task-strip.ts]
related: [mission-progress-strip-ordering, mission-structure-view, mission-task-lifecycle, mission-feed]
keywords: [flow, flow tab, timeline, gantt, critical path, finish is set by, dependency edges, elbow, same files, soft overlap, merged fold, lanes, structure view, layout=lanes]
verified_by: [apps/web/src/lib/flow-timeline.test.ts, "apps/web/src/app/app/(protected)/missions/[id]/FlowTimeline.test.tsx", apps/web/src/lib/mission-layout.test.ts]
supersedes: [mission-structure-view]
assertions:
  - id: "flow-build-timeline"
    type: "symbol"
    name: "buildFlowTimeline"
    path: "apps/web/src/lib/flow-timeline.ts"
  - id: "flow-same-files-gates"
    type: "symbol"
    name: "flowGates"
    path: "apps/web/src/lib/flow-timeline.ts"
  - id: "flow-critical-path"
    type: "symbol"
    name: "criticalPath"
    path: "apps/web/src/lib/flow-timeline.ts"
  - id: "flow-merged-fold"
    type: "symbol"
    name: "shouldFoldMerged"
    path: "apps/web/src/lib/flow-timeline.ts"
  - id: "flow-edge-lighting"
    type: "symbol"
    name: "flowLit"
    path: "apps/web/src/lib/flow-timeline.ts"
  - id: "flow-timeline-reachable-from-component"
    type: "symbol_reachable"
    symbol: "buildFlowTimeline"
    entry: "apps/web/src/app/app/(protected)/missions/[id]/FlowTimeline.tsx"
  - id: "flow-critical-path-line-reachable"
    type: "symbol_reachable"
    symbol: "criticalPathLine"
    entry: "apps/web/src/app/app/(protected)/missions/[id]/FlowTimeline.tsx"
  - id: "flow-model-tests"
    type: "test_file"
    path: "apps/web/src/lib/flow-timeline.test.ts"
  - id: "flow-component-tests"
    type: "test_file"
    path: "apps/web/src/app/app/(protected)/missions/[id]/FlowTimeline.test.tsx"
---

# Mission Flow Timeline

**Capability statement**: The mission detail page has three tabs, Overview,
Flow and History. Its Flow tab MUST render every
deliverable task as one row on one shared time axis, in the strip's dependency
order, with every gate between two tasks drawn as an edge from the blocker's
bar end to the dependent's bar start, and MUST say in one sentence which task
currently sets the mission's finish. It replaces the Lanes tab (runner slots
over time) and the Structure graph (a layered DAG); there is no second view of
the same graph and no Graph/Timeline toggle.

The model is pure (`buildFlowTimeline`, `layoutFlowTimeline`, `flowEdgePaths`
in `apps/web/src/lib/flow-timeline.ts`); the component only draws it.

---

## 1. Rows

**R-1**: There MUST be exactly one row per task on the mission's strip,
in `stripOrder`, so every dependency sits above its dependents and each row's
number is the strip tick the strip draws for that task. The Flow tab MUST NOT
derive its own order or walk `dependsOn` itself.

**R-2**: A row's bar MUST be placed from facts, then forecast:

| Task | Start | Solid part | Rest |
|---|---|---|---|
| Landed | its first run (else its merge minus its duration) | to its merge | none |
| Started, not landed | its first run | to now | to its expected finish: the larger of what its duration has left and a quarter of its duration |
| Failed | its first run | to where it stopped | none |
| Not started (ready, blocked, queued) | the latest finish among its gates plus `FLOW_AUDIT_WAIT_MS`, and never before now | none | its whole duration |

**R-3**: A task's duration MUST be its expected size in minutes (the
newest size prediction for the task, `expectedMinutesFromPredictions`) when one
exists, else `FLOW_DEFAULT_TASK_MS`. Until the estimates work lands, the tab
MUST NOT name, label or explain estimates: no "estimate", "forecast" or "p80"
text. A thin p80 line MUST render only when a p80 is supplied, and the legend
mentions it only then.

**R-4**: The solid part reads "done or so far"; the rest is hatched and
reads "still to come". A landed bar is the landed cell texture; a started bar's
solid part is its display state's ink; the rest uses a neutral hatch (dense for
a blocked task, sparse otherwise). Every row is the same height.

## 2. Gates and edges

**R-5**: A task's gates MUST be its on-mission stored dependencies
plus every same-files wait Buildd added for it (the `softOverlaps` on its path
declaration, `readSoftOverlaps` via `sameFilesFromRows`). A same-files wait
gates the start exactly like a dependency (R-2) and counts for the critical
path (R-15).

**R-6**: A gate to a task that is not on this mission, to the task
itself, or that repeats a stored dependency MUST be ignored. A dependency cycle
MUST NOT hang the schedule: a gate still being placed is skipped.

**R-7**: Every gate MUST be drawn, as an elbow from the blocker's bar
end to the dependent's bar start: out horizontally, vertically to the
dependent's row, in horizontally. A same-files gate is dotted.

**R-8**: Edges are faint by default. Lit edges draw over faint ones.

## 3. Lighting

**R-9**: Selecting a task lights exactly the edges whose two ends are
both in {the selection} ∪ what the strip marks for it (`stripMarks`, `flowLit`):
for a held task (blocked or queued) that is everything upstream that holds it;
for an active task, the unlanded work downstream of it; for a landed task,
nothing. The Flow tab MUST NOT define a second relation rule.

**R-10**: A lit edge that is also consecutive on the critical path draws
in ink; any other lit edge draws in the accent.

**R-11**: The tab MUST open on the task that sets the finish (R-16), or
on the last row once the critical path has landed (`defaultFlowSelection`). The
selected task's card sits beside the timeline on desktop and below it on a
phone. Its Open task link opens the task page, carrying mission back
context; selecting a timeline row only updates the card and lit edges.

## 4. Merged fold

**R-12**: When the mission has more than `FLOW_FOLD_ABOVE` (8) tasks and
at least two have landed, the landed tasks MUST share one row, first, labelled
`N merged ›`, carrying every landed bar.

**R-13**: Opening that row MUST give every task its own row again, and a
`Fold merged` control folds them back. At or below the threshold, or with a
single landed task, there is no fold.

**R-14**: An edge out of a folded task MUST leave from the merged row.
An edge between two folded tasks is not drawn.

## 5. Critical path

**R-15**: The critical path MUST be the longest path through the gates:
start from the task that finishes last, step back through whichever of its
gates finishes last, and stop at a task with no gates (`criticalPath`). Ties go
to the later row.

**R-16**: Above the timeline, one sentence MUST name the first unlanded
task on the critical path by its tick and its display state's word in lower
case, then the rest of the path by tick (`criticalPathLine`):
`Finish is set by 04 (building), then 06 → 07.` When the path has one unlanded
task the `, then …` clause is omitted; when all of it has landed there is no
sentence.

**R-17**: Every unlanded bar on the critical path MUST carry an ink
outline; no other bar does.

## 6. Width

**R-18**: Rows MUST NOT grow horizontally. Every horizontal position (bar
start, solid width, rest width, p80 width, the now line, axis ticks) MUST be a
percentage of the window, and edges MUST be in track units (`FLOW_X_UNITS` by
`FLOW_ROW_UNITS` per row) stretched to the track. No layout function takes a
width, and nothing in the tab scrolls sideways.

**R-19**: The axis MUST show at most six elapsed-time ticks from the window
start, plus `now` while the mission runs.

---

## Invariants

- The rows' task ids equal `stripOrder(model)` (opened) or, folded, the
  unlanded ids in that order behind one merged row.
- For every stored dependency `a → b`, row(a) is above row(b).
- An unstarted task's start is ≥ now and ≥ every gate's finish plus the audit
  wait.
- The lit edge set for a selection equals the set of gates with both ends in
  {selection} ∪ `stripMarks(model, selection).reached`.
- The critical path is non-empty whenever the mission has a task, and holds no
  task twice.
- `?layout=lanes` and `?view=structure` open Flow, and `?view=timeline`
  opens History (`parseMissionLayout`).

## Acceptance criteria

- AC-1: GIVEN a mission with seven tasks, WHEN the Flow tab renders, THEN it shows seven rows numbered `01`…`07` in the strip's order.
- AC-2: GIVEN 02 → {03, 04}, {03, 04} → 06, 03 → 05, {05, 06} → 07, with 04 building and finishing after 03, WHEN the tab renders, THEN the sentence reads `Finish is set by 04 (building), then 06 → 07.`
- AC-3: GIVEN A (10m) → C and B (60m) → C, WHEN the critical path is computed, THEN it is B → C.
- AC-4: GIVEN task 10 has a same-files wait on 05 and a dependency on landed 06, WHEN the schedule is built, THEN 10 starts at 05's finish plus the audit wait, and a dotted edge 05 → 10 is drawn.
- AC-5: GIVEN the same mission without the same-files wait, WHEN the schedule is built, THEN 10 starts now and no 05 → 10 edge exists.
- AC-6: GIVEN 06 is blocked on 03 and 04, WHEN 06 is selected, THEN exactly the edges 03 → 06 and 04 → 06 are lit.
- AC-7: GIVEN 04 is building and 06 → 07 wait on it, WHEN 04 is selected, THEN exactly 04 → 06 and 06 → 07 are lit.
- AC-8 (rejection): GIVEN a landed task, WHEN it is selected, THEN no edge is lit.
- AC-9: GIVEN 13 tasks of which three have landed, WHEN the tab renders, THEN one `3 merged ›` row stands for them and ten task rows follow; opening it gives thirteen rows.
- AC-10 (rejection): GIVEN eight tasks of which three have landed, WHEN the tab renders, THEN there is no merged row.
- AC-11: GIVEN any mission, WHEN the tab renders, THEN every `left` and `width` style is a percentage and no element scrolls horizontally.
- AC-12 (rejection): GIVEN a task with no expected size, WHEN the tab renders, THEN its bar lasts `FLOW_DEFAULT_TASK_MS` and no text mentions an estimate.
- AC-13: GIVEN a link with `?layout=lanes` or `?view=structure`, WHEN the mission page opens, THEN the Flow tab is selected.

## Code surface

- `apps/web/src/lib/flow-timeline.ts`: `buildFlowTimeline`, `flowGates`,
  `criticalPath`, `finishSetBy`, `criticalPathLine`, `defaultFlowSelection`,
  `flowLit`, `flowEdges`, `shouldFoldMerged`, `layoutFlowTimeline`,
  `flowEdgePaths`, `flowAxisTicks`, `sameFilesFromRows`,
  `expectedMinutesFromPredictions`, `FLOW_AUDIT_WAIT_MS`,
  `FLOW_DEFAULT_TASK_MS`, `FLOW_FOLD_ABOVE`
- `apps/web/src/app/app/(protected)/missions/[id]/FlowTimeline.tsx`: the tab
- `apps/web/src/app/app/(protected)/missions/[id]/page.tsx`: loads the path
  declarations and size predictions, mounts the tab
- `apps/web/src/app/app/(protected)/missions/[id]/mission-page-query.ts`:
  `MISSION_TASK_COLUMNS` (`pathDeclaration`)
- `apps/web/src/app/app/(protected)/missions/[id]/MissionLayoutShell.tsx`:
  the tabs Overview · Flow · History (`MISSION_LAYOUT_TABS`,
  `MISSION_LAYOUT_LABEL`; the layout keys stay `board`, `flow`, `feed`)
- `apps/web/src/lib/mission-layout.ts`: `parseMissionLayout`,
  `MISSION_LAYOUTS`, `MISSION_LAYOUT_LABEL`
- `apps/web/src/lib/mission-task-strip.ts`: `stripOrder`, `stripMarks`,
  `stripState` (read, not changed)
- `packages/core/path-overlap.ts`: `readSoftOverlaps` (read, not changed)
- `apps/web/src/components/chat/objects/MissionObject.tsx`: chat's mission
  pane, with two tabs: board and flow
- `apps/web/src/app/app/dev/fixtures/mission-flow-fixtures.ts`: `?state=mission-flow&m=small|wide`

## Out of scope

- Estimates: p50/p80 values, calibration, the finish clock and any text about
  them (the estimates work supplies p80 later; R-3 says what renders until then).
- Runner slots and concurrency over time (the old Lanes view); the fleet's own
  slot lanes are a separate surface.
- Visual review on this tab: the Overview and History tabs carry it.
- Phase bands, work-kind glyphs and chain collapsing on the timeline.
- Editing dependencies from the tab.

## Renumbered

Rule codes became plain criterion ids on 2026-10-15 so they parse and can be
graded. Old to new: ROW-1..4 to R-1..R-4; GATE-1, GATE-2 to R-5, R-6;
EDGE-1, EDGE-2 to R-7, R-8; LIT-1..3 to R-9..R-11; FOLD-1..3 to R-12..R-14;
CP-1..3 to R-15..R-17; W-1, W-2 to R-18, R-19. AC-1..AC-13 are unchanged.
