---
title: Mission Flow Timeline
status: active
owner: builder
last_verified: 2026-10-22
summary: Flow, a desktop view from the mission ⋯ menu, MUST draw one named row per task in dependency order on a clock-time axis, declared gates as lit edges, and, given estimates, who sets the finish.
domain: surfaces
surfaces: [apps/web/src/lib/flow-timeline.ts, "apps/web/src/app/app/(protected)/missions/[id]/FlowTimeline.tsx", apps/web/src/lib/mission-layout.ts, apps/web/src/lib/mission-task-strip.ts]
related: [mission-progress-strip-ordering, mission-structure-view, mission-task-lifecycle, mission-feed]
keywords: [flow, flow tab, timeline, gantt, critical path, finish is set by, dependency edges, elbow, lane order, merged fold, lanes, structure view, layout=lanes, clock axis, display name]
verified_by: [apps/web/src/lib/flow-timeline.test.ts, "apps/web/src/app/app/(protected)/missions/[id]/FlowTimeline.test.tsx", apps/web/src/lib/mission-layout.test.ts]
supersedes: [mission-structure-view]
assertions:
  - id: "flow-build-timeline"
    type: "symbol"
    name: "buildFlowTimeline"
    path: "apps/web/src/lib/flow-timeline.ts"
  - id: "flow-declared-gates"
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

**Capability statement**: Flow is a desktop view of a mission, reached from
the mission page's one ⋯ menu at md and up; there is no tab bar (Navigation
d25d923d R-3). Flow has no phone rendering: below md the ⋯ menu has no Flow
row and a Flow link lands on the mission page (Navigation R-2). Flow MUST
render every deliverable task as one row, labelled by its name, on one shared
clock-time axis, in the strip's dependency order, with every declared gate
between two tasks drawn as an edge from the blocker's bar end to the
dependent's bar start, and, when every task on the critical path has an
estimate, MUST say in one sentence, by name, which task sets the mission's
finish. It replaces the
Lanes tab (runner slots over time) and the Structure graph (a layered DAG);
there is no second view of the same graph and no Graph/Timeline toggle.

The model is pure (`buildFlowTimeline`, `layoutFlowTimeline`, `flowEdgePaths`
in `apps/web/src/lib/flow-timeline.ts`); the component only draws it.

---

## 1. Rows

**R-1**: There MUST be exactly one row per task on the mission's strip,
in `stripOrder`, so every dependency sits above its dependents. A row's
visible label MUST be the task's display name (`displayTaskTitle`), never a
tick number or a commit scope (`specs`, `fix(missions)`); the strip tick MAY
be carried as an accessible detail only (for example in the row's accessible
name), not as visible text. The Flow tab MUST NOT derive its own order or walk
`dependsOn` itself.

**R-2**: A row's bar MUST be placed from facts, then forecast:

| Task | Start | Solid part | Rest |
|---|---|---|---|
| Landed | its first run (else its merge minus its duration) | to its merge | none |
| Started, not landed | its first run | to now | to its expected finish: the larger of what its duration has left and a quarter of its duration |
| Failed | its first run | to where it stopped | none |
| Not started (ready, blocked, queued) | the latest finish among its gates plus `FLOW_AUDIT_WAIT_MS`, and never before now | none | its whole duration |

**R-3**: A task's duration MUST be its expected size in minutes (the
newest size prediction for the task, `expectedMinutesFromPredictions`) when one
exists, else `FLOW_DEFAULT_TASK_MS`. A bar sized by the default is a
placement, not a claim: the tab MUST NOT name, label or explain estimates
(no "estimate", "forecast" or "p80" text), and the finish sentence follows the
estimate rule of R-16, not this default. A thin p80 line MUST render
only when a p80 is supplied, and the legend mentions it only then.

**R-4**: A bar's look MUST say what state its task is in, using the mission
bar's looks (Navigation d25d923d R-4), so that merged, running, fixing, needs
a person, failed and waiting each read differently at a glance; there is no
single "done or so far" fill shared by landed and started work. The forecast
rest of a started or unstarted bar stays a neutral hatch that reads "still to
come" and never takes a state's look. Every row is the same height.

## 2. Gates and edges

**R-5**: A task's gates MUST be its on-mission declared dependencies and the
lane order Buildd holds it to (a task waiting behind another in the same
unmergeable lane, Overlap scheduling 75217f55), and nothing else. Same-files
soft overlaps are not gates: they do not move a start, do not count for the
critical path and are not drawn. A gate holds the start (R-2) and counts for
the critical path (R-15).

**R-6**: A gate to a task that is not on this mission, to the task
itself, or that repeats a stored dependency MUST be ignored. A dependency cycle
MUST NOT hang the schedule: a gate still being placed is skipped.

**R-7**: Every gate MUST be drawn, as an elbow from the blocker's bar
end to the dependent's bar start: out horizontally, vertically to the
dependent's row, in horizontally. Every edge uses one line style; there is
no dotted edge.

**R-8**: Edges are faint by default. Lit edges draw over faint ones.

## 3. Lighting

**R-9**: Selecting a task lights exactly the edges whose two ends are
both in {the selection} ∪ what the strip marks for it (`stripMarks`, `flowLit`):
for a held task (blocked or queued) that is everything upstream that holds it;
for an active task, the unlanded work downstream of it; for a landed task,
nothing. The Flow tab MUST NOT define a second relation rule.

**R-10**: A lit edge that is also consecutive on the critical path draws
in ink; any other lit edge draws in the accent.

**R-11**: Flow MUST open on the task that sets the finish (R-16), or
on the last row once the critical path has landed (`defaultFlowSelection`). The
selected task's card sits beside the timeline. Flow is a desktop layout (md
and up); below md there is no Flow and a Flow link lands on the mission page
(Navigation d25d923d R-2), so the card has no phone arrangement. Its Open task
link opens the task page, carrying mission back context; selecting a timeline
row only updates the card and lit edges.

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
task on the critical path by its display name and its display state's word in
lower case, then the rest of the path by display name (`criticalPathLine`):
`Finish is set by Add retry budget (running), then Wire the claim gate →
Ship the readout.` It MUST be the same computation, with the same words, as
the finish sentence in the mission page's Build summary (Navigation d25d923d
R-22); Flow MUST NOT compute its own. The sentence MUST render only when every
unlanded task on the critical path has an estimate (Task Estimates); when any
of them runs on `FLOW_DEFAULT_TASK_MS` the sentence is omitted, with no
placeholder. When the path has one unlanded task the `, then …` clause is
omitted; when all of it has landed there is no sentence.

**R-17**: Every unlanded bar on the critical path MUST carry an ink
outline; no other bar does.

## 6. Width

**R-18**: Rows MUST NOT grow horizontally. Every horizontal position (bar
start, solid width, rest width, p80 width, the now line, axis ticks) MUST be a
percentage of the window, and edges MUST be in track units (`FLOW_X_UNITS` by
`FLOW_ROW_UNITS` per row) stretched to the track. No layout function takes a
width, and nothing in the tab scrolls sideways.

**R-19**: The axis MUST show at most six ticks labelled with clock times in
the viewer's local time zone (`14:00`, `15:30`; with the day when the window
crosses midnight), plus `now` while the mission runs. It MUST NOT label
elapsed time from the window start (`0`, `2h`, `3h`).

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

- AC-1: GIVEN a mission with seven tasks, three of whose titles carry the commit scope `specs`, WHEN Flow renders, THEN it shows seven rows in the strip's order, each labelled with its task's `displayTaskTitle`, and no row's visible text is a tick number (`01`) or a commit scope.
- AC-2: GIVEN 02 → {03, 04}, {03, 04} → 06, 03 → 05, {05, 06} → 07, with 04 running and finishing after 03, and 04, 06 and 07 each having an estimate, WHEN Flow renders, THEN the sentence reads `Finish is set by <04's name> (running), then <06's name> → <07's name>.` and matches the Build summary's sentence word for word.
- AC-3: GIVEN A (10m) → C and B (60m) → C, WHEN the critical path is computed, THEN it is B → C.
- AC-6: GIVEN 06 is blocked on 03 and 04, WHEN 06 is selected, THEN exactly the edges 03 → 06 and 04 → 06 are lit.
- AC-7: GIVEN 04 is building and 06 → 07 wait on it, WHEN 04 is selected, THEN exactly 04 → 06 and 06 → 07 are lit.
- AC-8 (rejection): GIVEN a landed task, WHEN it is selected, THEN no edge is lit.
- AC-9: GIVEN 13 tasks of which three have landed, WHEN the tab renders, THEN one `3 merged ›` row stands for them and ten task rows follow; opening it gives thirteen rows.
- AC-10 (rejection): GIVEN eight tasks of which three have landed, WHEN the tab renders, THEN there is no merged row.
- AC-11: GIVEN any mission, WHEN the tab renders, THEN every `left` and `width` style is a percentage and no element scrolls horizontally.
- AC-12 (rejection): GIVEN a task with no expected size, WHEN the tab renders, THEN its bar lasts `FLOW_DEFAULT_TASK_MS` and no text mentions an estimate.
- AC-13: GIVEN a link with `?layout=lanes` or `?view=structure`, WHEN the mission page opens, THEN the Flow tab is selected.
- AC-14: GIVEN task 10 declares a dependency on unlanded 05, WHEN the schedule is built, THEN 10 starts at 05's finish plus the audit wait and an edge 05 → 10 is drawn in the one edge style.
- AC-15 (rejection): GIVEN task 10 has a same-files soft overlap on 05, no declared dependency on it and no lane order behind it, and depends only on landed 06, WHEN the schedule is built, THEN 10 starts now, no 05 → 10 edge exists and 05 is not on 10's critical path.
- AC-16: GIVEN one task each merged, running, fixing, needing a person, failed and waiting, WHEN Flow renders, THEN the six bars carry six different looks, each matching the mission bar's look for that state.
- AC-17 (rejection): GIVEN a critical path whose unlanded tasks include one with no estimate, WHEN Flow renders, THEN there is no finish sentence and no placeholder in its place.
- AC-18: GIVEN a running mission whose window spans 13:00 to 17:00 local time, WHEN Flow renders, THEN every axis tick except `now` is a local clock time and none reads as elapsed hours (`0`, `2h`).
- AC-19 (rejection): GIVEN a viewport below md, WHEN the mission page's ⋯ menu opens, THEN it has no Flow row, and a Flow link opens the mission page.

## Code surface

- `apps/web/src/lib/flow-timeline.ts`: `buildFlowTimeline`, `flowGates`,
  `criticalPath`, `finishSetBy`, `criticalPathLine`, `defaultFlowSelection`,
  `flowLit`, `flowEdges`, `shouldFoldMerged`, `layoutFlowTimeline`,
  `flowEdgePaths`, `flowAxisTicks`, `expectedMinutesFromPredictions`,
  `FLOW_AUDIT_WAIT_MS`,
  `FLOW_DEFAULT_TASK_MS`, `FLOW_FOLD_ABOVE`
- `apps/web/src/app/app/(protected)/missions/[id]/FlowTimeline.tsx`: the tab
- `apps/web/src/app/app/(protected)/missions/[id]/page.tsx`: loads the path
  declarations and size predictions, mounts the tab
- `apps/web/src/app/app/(protected)/missions/[id]/mission-page-query.ts`:
  `MISSION_TASK_COLUMNS` (`pathDeclaration`)
- `apps/web/src/app/app/(protected)/missions/[id]/MissionLayoutShell.tsx`:
  the layouts Overview · Flow · History, one mounted at a time and switched
  from the ⋯ menu through `useMissionLayout` (`MISSION_LAYOUT_LABEL`; the
  layout keys stay `board`, `flow`, `feed`; no tab bar)
- `apps/web/src/app/app/(protected)/missions/[id]/MissionOverflowMenu.tsx`:
  the History and Flow rows (Flow from md)
- `apps/web/src/lib/mission-layout.ts`: `parseMissionLayout`,
  `MISSION_LAYOUTS`, `MISSION_LAYOUT_LABEL`
- `apps/web/src/lib/mission-task-strip.ts`: `stripOrder`, `stripMarks`,
  `stripState` (read, not changed)
- `apps/web/src/components/chat/objects/MissionObject.tsx`: chat's mission
  pane, with two tabs: board and flow
- `apps/web/src/app/app/dev/fixtures/mission-flow-fixtures.ts`: `?state=mission-flow&m=small|wide`

## Out of scope

- Estimates: p50/p80 values, calibration, the finish clock and any text about
  them (Task Estimates owns them; R-3 and R-16 say what Flow does with or
  without one).
- Same-files soft overlaps: they shape claims (Overlap scheduling 75217f55),
  not the Flow schedule.
- A phone rendering of Flow (Navigation d25d923d R-2).
- Runner slots and concurrency over time (the old Lanes view); the fleet's own
  slot lanes are a separate surface.
- Visual review in Flow: Overview and History carry it.
- Phase bands, work-kind glyphs and chain collapsing on the timeline.
- Editing dependencies from the tab.

## Renumbered

Rule codes became plain criterion ids on 2026-10-15 so they parse and can be
graded. Old to new: ROW-1..4 to R-1..R-4; GATE-1, GATE-2 to R-5, R-6;
EDGE-1, EDGE-2 to R-7, R-8; LIT-1..3 to R-9..R-11; FOLD-1..3 to R-12..R-14;
CP-1..3 to R-15..R-17; W-1, W-2 to R-18, R-19. AC-1..AC-13 are unchanged.

## Retired

- AC-4 and AC-5 (retired 2026-10-22): they tested same-files soft overlaps as
  gates, with a dotted edge. Soft overlaps are no longer gates (R-5). AC-14
  covers a declared dependency and AC-15 rejects a soft overlap. The ids are
  not reused.
