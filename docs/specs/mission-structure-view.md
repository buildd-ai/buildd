---
title: Mission Structure View
status: active
owner: builder
last_verified: 2026-08-30
summary: The mission detail Structure tab MUST render the full dependency DAG as a stable left-to-right layered graph, collapsing chains via the shared identifyChains helper, on desktop only.
domain: surfaces
surfaces: [apps/web/src/lib/structure-layout.ts, apps/web/src/app/app/(protected)/missions/[id]/StructureView.tsx, apps/web/src/app/app/(protected)/missions/[id]/MissionTabs.tsx, apps/web/src/lib/condensed-timeline.ts]
related: [timeline-dependency-geometry, missions-tab-triage, mission-task-lifecycle, surface-ia-home-missions-initiatives]
keywords: [dag, graph, structure view, canvas, topology, layout, dependency, blocked, stranded, contention edge]
supersedes: []
---

# Mission Structure View

**Capability statement**: The mission detail page MUST offer a Structure tab that renders
the full mission task DAG as a stable, left-to-right layered graph with topology-correct
edge classes, chain collapsing via the shared `identifyChains` helper, and state-as-fill
derived from the existing `StageChip` vocabulary — desktop only.

---

## 0. Decision summary

| # | Topic | Decision |
|---|-------|----------|
| 1 | View boundary | Second tab IS justified; Timeline and Structure are orthogonal questions |
| 2 | Layout algorithm | Hand-rolled Sugiyama (Kahn + rank + Brandes-Köpf); no external library |
| 3 | Collapse model | Chains via `identifyChains()`; one node per chain until expanded |
| 4 | Edge classes | Four classes, distinct visuals; contention behind toggle; soft ordering NOT rendered |
| 5 | State as fill | `deriveStage()` drives all fills; STRANDED is a new condition mapped to `notch` |
| 6 | Selection + detail | Upstream/downstream highlight; selection opens existing task detail affordance |
| 7 | Mobile | Structure tab hidden on mobile; Timeline unchanged |
| 8 | New components | Exactly 2 new files; 3 existing components reused inside nodes |

---

## 1. View boundary — is a second tab justified?

**Decision: yes.** Timeline and Structure answer orthogonal questions and cannot be merged.

Timeline answers **"what is actionable now?"**: it partitions tasks into readiness sections
(waitingOnYou → running → nextQueued → blocked → done/failed), optimises for mobile,
and uses section grouping as the primary navigation signal. That grouping is non-negotiable
— it is why Timeline is useful on a phone.

Structure answers **"what is the shape and why is this blocked?"**: it renders the full
dependency topology regardless of readiness state, making cross-section chains visible as
connected graphs and surfacing stranded tasks (blocked by a terminal parent) that are
currently invisible on every surface.

The fundamental conflict: Timeline's section-grouping SEVERS the visual chain. A blocker in
`waitingOnYou` and its seven downstream tasks in `blocked` cannot be shown as a connected
DAG without either destroying the section hierarchy or adding section-bridging hacks. A
second tab resolves this without compromise. Timeline keeps its section-first hierarchy;
Structure renders the full graph.

**If the conclusion had been no**: the correct alternative would be extending
`DependencyRail` on the Timeline with a "view full graph" affordance that opens a modal —
not extending the list layout to draw edges across sections. That option remains valid in
a future iteration but is not this spec.

---

## 2. Layout algorithm

**Algorithm**: Layered left-to-right (Sugiyama family), hand-rolled. No external library.

### 2.1 Implementation approach

Three phases, all pure functions in `apps/web/src/lib/structure-layout.ts`:

1. **Rank assignment** — Kahn's topological sort (same O(N+E) algorithm as
   `timeline-dependency-geometry.md §2.1`) assigns each node a rank (column). A task's
   rank is `max(rank of all direct blockers) + 1`. Tasks with no blockers get rank 0.
   Cross-mission deps (blockers not in the task set) are treated as virtual rank-0 sources.

2. **Within-rank ordering** — barycenter heuristic: order nodes within each rank by the
   mean rank of their neighbors, alternating top-down and bottom-up sweeps (2 passes is
   sufficient for mission-sized graphs). Ties broken by `taskCreatedAt` ascending.

3. **Coordinate assignment** — simplified Brandes-Köpf: each node gets
   `x = rank * NODE_COLUMN_WIDTH`, `y = intra-rank-position * NODE_ROW_HEIGHT`.
   Column and row constants are CSS custom properties, not hardcoded pixels, so they
   respond to container width.

**Why no external library**: D3-dag (~18 KB gzipped) or dagre (~75 KB) is not justified
for graphs bounded at ~30 nodes (the chain-collapse model in §3 keeps the rendered node
count small). Hand-rolled code gives exact control over the visual vocabulary and avoids
a bundle regression. If mission size grows beyond 100 tasks per view, revisit.

### 2.2 Stability invariant

**Rule LAY-1**: Position MUST be stable across status changes. A task moving from `QUEUED`
to `RUNNING` changes its fill colour and border weight; it MUST NOT change its `x` or `y`
coordinates.

**Rule LAY-2**: Layout is memoized by edge-set fingerprint. The fingerprint is a
stable JSON string of `Array<[taskId, sortedDepsIds[]]>` sorted by taskId. Only
changes to `dependsOn` edges or the node set (tasks added/removed) invalidate the layout.
Worker status, PR state, and stage are not part of the fingerprint.

**Rule LAY-3**: Memoization lives in a `useMemo` in `StructureView.tsx` keyed on the
edge-set fingerprint. Layout is NOT recomputed on every render cycle.

---

## 3. Collapse model

### 3.1 Chain identification — shared helper

**Rule COL-1**: The Structure view MUST call `identifyChains()` from
`apps/web/src/lib/condensed-timeline.ts` to partition the task set into `ChainUnit[]`.
It MUST NOT re-derive the chain grouping locally. ONE adjacency derivation serves both
Timeline and Structure.

`identifyChains()` returns `ChainUnit[]` with shapes: `linear | fan-out | fan-in | standalone`.
The Structure view receives the same server-computed data as the Timeline tab.

### 3.2 Collapsed node rendering

A `linear` `ChainUnit` with `tail.length ≥ 1` renders as a **single collapsed node** in
the graph until expanded:

- **Label**: abbreviated head task title (max 32 chars) + `· N tasks` suffix
- **Progress strip**: `SegmentStrip` rendered horizontally inside the node body, showing
  one segment per task in the chain (head + tail). This is the only place within a node
  where `SegmentStrip` appears.
- **Stage fill**: derived from the chain head's stage (worst-case fill of the head, not
  all members — chain members' individual stages are visible only when expanded).
- **Click to expand**: clicking a collapsed node in-place replaces it with the full
  ordered node sequence. No page navigation. Expansion state is local React state in
  `StructureView.tsx`.

`fan-out`, `fan-in`, and `standalone` chains are always rendered as individual nodes
(they cannot be collapsed — there is no linear sequence to abbreviate).

### 3.3 Depth and width limits

**Rule COL-2**: A single section of the graph MUST NOT render more than 8 top-level nodes
(collapsed chains count as 1) before showing a `+N more` disclosure button at the bottom
of that rank. This prevents the canvas from growing past the viewport height.

**Rule COL-3**: A single collapsed chain node occupies the horizontal span of 2 normal
node widths, regardless of chain length. Chain depth is expressed via `SegmentStrip`, not
by widening the node.

---

## 4. Edge classes — load-bearing

Four edge classes. Each MUST be visually distinct under greyscale (shape or dash pattern
provides the greyscale signal; colour provides the colour-vision signal).

### 4.1 Hard dependency edges (`dependsOn`)

- **Shape**: solid arrowed line, arrowhead at target (downstream task)
- **Colour**: `text-status-warning` amber — same token used by `DependencyRail` chips
- **Greyscale**: solid vs dashed provides the greyscale signal
- **Always visible** — not toggleable
- **Rendering**: one edge per direct `dependsOn` relationship. Transitive reduction is
  applied: if A→B→C and A→C are both stored, the A→C edge is hidden (it is implied). Same
  frontier algorithm as `DependencyRail` (Rule TR-2 in `timeline-dependency-geometry.md`).

### 4.2 Retry lineage edges (`parentTaskId`)

- **Shape**: dashed line (`stroke-dasharray: 4 2`), no arrowhead
- **Colour**: `text-text-muted` (grey)
- **Greyscale**: dashed pattern is the greyscale signal
- **Always visible by default** when parent and child are both in the mission task set;
  toggled off via the "Hide retries" toggle in the Structure view toolbar.
- **Rendering**: one edge from parent task to each retry child. These are provenance
  edges, not dependency gates — they MUST NOT be styled to imply blocking.

### 4.3 Soft ordering edges (pathManifest-derived)

- **Decision: NOT rendered** by default, not behind a toggle either.
- **Justification**: pathManifest soft ordering (`shouldSerializeByManifest`) produces no
  `dependsOn` edge (Rule AS-1 in `timeline-dependency-geometry.md`). There is no stored
  edge to render. The advisory deferral is ephemeral (claim-time, not persisted) and
  therefore cannot be surfaced as a graph edge without querying live claim state on every
  render. The claim-loop state is not part of the task data fetched for the mission
  timeline. Rendering this class requires a new server query and is deferred.

### 4.4 Contention edges (observed path overlap)

- **Shape**: dotted-dashed line (`stroke-dasharray: 2 2 6 2`), no arrowhead, bidirectional
  (no implied direction — contention is symmetric)
- **Colour**: `text-status-error/60` muted red — visually separable from amber `dependsOn`
  and grey retry
- **Greyscale**: dotted-dashed pattern is the greyscale signal; it MUST NOT match the
  retry dashed pattern
- **MUST NOT read as a dependency**: the line must be bidirectional and not share any
  visual treatment with `dependsOn` edges. Tooltip on hover: "File conflict detected — both
  tasks touched {path}"
- **Behind a toggle**: "Show file conflicts" toggle in the Structure view toolbar. Off by
  default. The toggle is hidden (not shown disabled) when contention data is unavailable.

**M1 observed-touch index status**: As of spec date (2026-08-30), the `workers.touchedPaths`
column described in `docs/design/path-claims.md §6c` has NOT landed. The path-claims
design is still "Proposed". Contention edge rendering is therefore fixture-based only
at this time.

**Clean data seam for contention edges**:

```ts
export type ContentionEdge = {
  sourceTaskId: string;
  targetTaskId: string;
  paths: string[];        // overlapping file paths
};

// Injected into StructureViewProps by the server component when
// workers.touchedPaths column is non-null for at least one task in the mission.
// Absent → contention toggle is hidden entirely.
export type StructureViewProps = {
  // ... other fields ...
  contentionEdges?: ContentionEdge[];
};
```

When `contentionEdges` is absent, the toggle and all contention rendering are omitted.
When `workers.touchedPaths` lands (M1), the server component populates this field by
running the `pathsOverlap()` cross-product over all mission task workers' `touchedPaths`.

---

## 5. State as fill

**Rule STF-1**: Every node's fill MUST derive from `deriveStage()` in `apps/web/src/lib/stage.ts`.
The Structure view MUST NOT define a parallel status vocabulary or re-derive stage from
raw task/worker fields.

**Rule STF-2**: `StageChip` from `apps/web/src/components/StageChip.tsx` MUST be rendered
inside every node to communicate the task stage. The chip appears below the task title.
Node background fill is a reinforcement of the chip, not a replacement.

### 5.1 Stage-to-fill mapping

| Stage | Node fill | Border | Notes |
|-------|-----------|--------|-------|
| `BLOCKED` | `bg-status-warning/15` | `border-status-warning` 2px | Recoverable — blocker exists but may resolve |
| `QUEUED` | transparent | `border-border-default` 1px | Waiting for a worker, no blocker |
| `RUNNING` | `bg-status-running/15` | `border-status-running` 2px | Animate with subtle pulse on border |
| `WAITING_INPUT` | `bg-status-warning/15` | `border-status-warning` 2px dashed | Input awaited |
| `REVIEWING` | `bg-status-info/10` | `border-status-info` 1px | |
| `OPEN` / `CI` / `VERIFY` / `MERGE` | `bg-accent/10` | `border-accent` 1px | Post-PR states |
| `DONE` | `bg-status-success/10` | `border-status-success` 1px | Completed, gate satisfied |
| `FAILED` | `bg-status-error/15` | `border-status-error` 2px | |
| `CANCELLED` | transparent | `border-border-default` 1px opacity-50 | |
| `SUBJECT_DEAD` | `bg-status-error/12` | `border-status-error/40` 1px dashed | Subject PR closed; human must intervene. Matches `StageChip` soft error treatment |
| `MISSION_BUDGET` | `bg-status-error/12` | `border-status-error/40` 1px dashed | Parent mission budget exhausted. Matches `StageChip` soft error treatment |
| **STRANDED** | `bg-status-error/8` + notch pattern | `border-status-error/40` 1px dashed | See §5.2 |

### 5.2 STRANDED condition (new)

**Definition**: A task is STRANDED when it is `pending` or `assigned` AND at least one of
its direct `dependsOn` tasks has reached a terminal-and-non-completing state (`failed` or
`cancelled`) with no unmerged PR — meaning the blocking condition can never resolve without
human intervention.

**Why this matters**: A stranded task is invisible on every current surface. The Timeline
renders it as `BLOCKED` (correct stage, wrong implication — implies the blocker will eventually
resolve). Structure is the first surface where STRANDED can be rendered with its own fill
because the graph makes the terminal-parent relationship visible.

**Rule STF-3**: A task is STRANDED only when ALL of the following hold:
1. `task.status === 'pending' || task.status === 'assigned'`
2. At least one dep in `dependsOn` has `status === 'failed' || status === 'cancelled'`
3. That dep has no PR with `prLifecycleStatus` in `['pr_open', 'ci_running', 'ci_failed', 'ci_green', 'conflict']`
   (i.e., no open PR that could still be reviewed and merged — `ci_green` is included because
   a dep whose CI has passed is one reviewer-merge away from resolving)

A task with a failed dep that has a still-open PR is NOT stranded — it might still resolve.

**Visual treatment**: STRANDED uses the `notch` glyph vocabulary from `SegmentGlyph`
(`bg-[linear-gradient(45deg,transparent_42%,currentColor_43%_57%,transparent_58%)]`) applied
to the node background. Error-red at low opacity. The `StageChip` inside the node shows
`BLOCKED` (the actual task status is blocked) but the node border is dashed-error to
distinguish from a normally-blocked task.

**Rule STF-4**: The STRANDED condition is evaluated in `structure-layout.ts` and passed
as `isStranded: boolean` on each `StructureNode`. The `StructureView` component does not
re-evaluate it.

---

## 6. Selection and detail

### 6.1 Selection behaviour

**Rule SEL-1**: Selecting a node highlights all nodes in its upstream (reachable via
`dependsOn` following edges to their sources) and downstream (reachable via `dependsOn`
following edges to their targets) transitive closure. Highlight treatment:
- Selected node: 3px accent border (`border-accent`), `bg-accent/5`
- Upstream nodes: `bg-status-warning/8`, `border-status-warning/50` 1px
- Downstream nodes: `bg-status-info/8`, `border-status-info/50` 1px
- Unselected, unrelated nodes: `opacity-50`

**Rule SEL-2**: Unselected edges are de-emphasised (`opacity-30`), not hidden. The graph
structure remains readable; only prominence is reduced.

**Rule SEL-3**: Clicking the same node a second time deselects it, restoring all nodes
to full opacity.

**Rule SEL-4**: The graph MUST NOT become a detail surface. No task metadata beyond title
and stage chip is shown inside the node on selection. No worker logs, PR links, or
description text are shown inline.

### 6.2 Task detail affordance

**Rule SEL-5**: Each node MUST include a link that opens the existing task detail view.
The link navigates to `/app/tasks/[id]` (the standard task detail page) or triggers the
task detail slide-in panel if one is present in the page context.

**Rule SEL-6**: Keyboard navigation MUST work: Tab moves focus between nodes, Enter
activates the detail link, Space toggles selection, Escape clears selection.

---

## 7. Mobile

**Decision**: Mobile does NOT render the Structure canvas. The Structure tab is hidden on
viewports narrower than the `md` breakpoint (768px). Mobile users see only Summary and
Timeline tabs, unchanged.

**Rule MOB-1**: `StructureView.tsx` MUST NOT be rendered on mobile. The tab entry in
`MissionTabs.tsx` MUST use `hidden md:flex` (or equivalent) so the tab is absent from
the DOM on mobile — not disabled, not visible-but-locked.

**Justification**: A 360px viewport cannot legibly render a DAG with more than 3–4 nodes.
Even with chain collapsing, a 20-task mission produces 8–10 collapsed nodes. The
horizontal layout (left-to-right) is particularly hostile on narrow viewports. Touch-pan
on a canvas is a poor interaction model for this use case. The Timeline tab already serves
mobile users well. Adding a broken-canvas tab experience would degrade the mobile session
without benefit.

---

## 8. New component justification

The standing rule is zero new components. This spec grants a narrow exemption because a
canvas-based DAG renderer cannot be a variant of `DependencyRail` (which is an inline
flow element) or `CondensedTimeline` (which is a linear list).

### 8.1 New files created by this spec

| File | Purpose |
|------|---------|
| `apps/web/src/app/app/(protected)/missions/[id]/StructureView.tsx` | Canvas client component — renders nodes, edges, handles selection and expansion state |
| `apps/web/src/lib/structure-layout.ts` | Pure layout engine — Sugiyama rank assignment + coordinate computation. No React, no DOM. Returns `{nodes: StructureNode[], edges: StructureEdge[]}`. |

No other new files. The SVG or CSS canvas is rendered inside `StructureView.tsx` itself
using plain SVG elements for edges and `div` nodes for task nodes — no canvas API, no
WebGL.

### 8.2 Existing components reused inside nodes

| Component | File | Use inside a node |
|-----------|------|-------------------|
| `StageChip` | `apps/web/src/components/StageChip.tsx` | Renders the stage pill (BLOCKED, RUNNING, etc.) below the task title |
| `SegmentStrip` | `apps/web/src/components/SegmentStrip.tsx` | Renders chain progress in collapsed chain nodes; `continuous` mode when `chain.total > 8` |
| Role-colour dot | Inline from `task.roleColor` | 8×8px coloured circle (same as Timeline's `w-2 h-2 rounded-full` dot) — no new component needed |

**Rule NCJ-1**: Any component already used inside `TaskRow` in `CondensedTimeline.tsx`
is automatically a candidate for reuse inside a Structure node. New components for node
sub-elements are BANNED unless the element is materially different from any existing
component.

### 8.3 Modifications to existing files

**In scope — only these changes to existing files are permitted**:

1. `apps/web/src/app/app/(protected)/missions/[id]/MissionTabs.tsx` — add one tab entry
   `{ label: 'Structure', value: 'structure', className: 'hidden md:flex' }` that renders
   `<StructureView ... />`. This is the only change to any existing mission detail file.

**Out of scope — explicitly banned**:
- Any modification to `CondensedTimeline.tsx` beyond what `MissionTabs` already dispatches to it
- Any modification to `DependencyRail.tsx` for the Structure view
- Any new props on `StageChip` or `SegmentStrip` for Structure-specific rendering
- Any server-side query changes — Structure uses the same data fetched for the Timeline tab

### 8.4 Data flow

`StructureView` receives:
```ts
type StructureViewProps = {
  /** Flat chain-unit array for the full mission — see flatten note below. */
  chains: ChainUnit<CondensedTimelineTask>[];
  /** Full task map for gate evaluation (same as Timeline). */
  taskMap: Map<string, CondensedTask>;
  missionId: string;
  /** Only present when workers.touchedPaths column exists and has data. */
  contentionEdges?: ContentionEdge[];
};
```

**Flatten note**: `page.tsx` calls `groupChainUnits()` which returns a
`CondensedTimelineGroups`-shaped object with section-keyed buckets
(`waitingOnYou`, `running`, `nextQueued`, `blocked`, `done`, `failed`).
The tab entry point MUST flatten this into a single `ChainUnit[]` before passing
to `StructureView`. Recommended flatten:
```ts
const chains = [
  ...groups.waitingOnYou,
  ...groups.running,
  ...groups.nextQueued,
  ...groups.blocked,
  ...groups.done,
  ...groups.failed,
];
```
Do NOT rely on section order as a rank proxy — `structure-layout.ts` derives
rank purely from `dependsOn` edges. Order within the flattened array is
irrelevant; any section-induced ordering is discarded by the Sugiyama algorithm.
If a stable secondary sort is needed within a rank, use `task.createdAt` ascending.

`structure-layout.ts` receives `chains` and `taskMap`, builds the adjacency lists, runs
the Sugiyama phases, and returns `StructureNode[]` and `StructureEdge[]`.

---

## Invariants

- A task's `x` and `y` coordinates MUST NOT change when only its status, worker state,
  or PR state changes.
- The Structure view MUST NOT be rendered on mobile viewports (`< md` breakpoint).
- `identifyChains()` MUST be called exactly once per render cycle for the mission task set;
  Structure and Timeline MUST share the same result.
- `StageChip` MUST appear inside every node (collapsed and expanded).
- Contention edges MUST NOT share any visual treatment with `dependsOn` edges.
- A STRANDED task MUST render with a visually distinct fill from a BLOCKED task.
- `deriveStage()` MUST be the sole path from task/worker fields to a `Stage` value in this surface.

---

## Acceptance criteria

**AC-1**: GIVEN a mission with a linear chain A→B→C→D where A is in `waitingOnYou` and
B–D are in `blocked`, WHEN the Structure tab renders, THEN all four tasks appear as
connected nodes in a single left-to-right line, with solid amber arrows B←A, C←B, D←C,
and A is NOT separated into a different section.

**AC-2**: GIVEN a linear chain of 5 tasks (A→B→C→D→E), WHEN the Structure tab renders
before any expansion, THEN exactly ONE collapsed node appears labelled `{head.title} · 5 tasks`
with a `SegmentStrip` showing 5 segments.

**AC-3**: GIVEN a collapsed chain node, WHEN the user clicks it, THEN the node expands
in-place to show all 5 individual nodes in sequence without page navigation.

**AC-4**: GIVEN a mission task graph with 10 edges whose layout was computed, WHEN task B's
status changes from `QUEUED` to `RUNNING`, THEN B's position (x, y) is unchanged and only
its fill colour, border weight, and `StageChip` label update.

**AC-5**: GIVEN a task T whose direct dep D has `status === 'failed'` and no open PR, WHEN
the Structure tab renders, THEN T renders with the STRANDED fill treatment (notch pattern,
dashed error border) and NOT the normal BLOCKED fill.

**AC-6**: GIVEN a task T with no stranded deps, WHEN it renders in Structure, THEN it does
NOT render with the STRANDED fill.

**AC-7**: GIVEN a diamond DAG A→B, A→C, B→D, C→D, WHEN the user selects node D, THEN
nodes B and C are highlighted as upstream (warning tint), A is highlighted as upstream
(warning tint), and all edges NOT in the upstream/downstream closure are de-emphasised to
30% opacity.

**AC-8**: GIVEN any Structure view render, WHEN a node is clicked, THEN the task detail
link navigates to `/app/tasks/[id]` or opens the task detail panel — no detail metadata
appears inline in the graph.

**AC-9**: GIVEN a viewport width of 360px, WHEN the mission detail page renders, THEN the
Structure tab is absent from the DOM (not disabled, not rendered) and the Timeline tab is
the default active tab.

**AC-10**: GIVEN the Structure view is rendered on a desktop viewport, WHEN retry-child
tasks are present in the mission, THEN retry lineage edges render as grey dashed lines
distinct from the amber solid `dependsOn` edges and the dotted-dashed contention edges.

**AC-11**: GIVEN `contentionEdges` is absent from `StructureViewProps`, WHEN the Structure
view renders, THEN no contention toggle appears in the toolbar and no dotted-dashed edges
are rendered.

**AC-12**: GIVEN `contentionEdges` is present, WHEN the user toggles "Show file conflicts" on,
THEN dotted-dashed muted-red bidirectional edges appear between task pairs in the contention
set, and WHEN toggled off, THEN they disappear. Contention edges MUST NOT carry arrowheads.

**AC-13**: GIVEN `StageChip` renders stage `BLOCKED` inside a node, WHEN that same task is
also STRANDED, THEN the node background uses the STRANDED notch fill AND the `StageChip`
label still reads `BLOCKED` — the chip stage is not overridden.

**AC-14** (rejection): GIVEN any edge in the Structure view, WHEN it is a `dependsOn` edge,
THEN its visual treatment MUST NOT match the contention edge treatment (no dotted-dashed
style on `dependsOn` edges under any toggle state).

**AC-15** (rejection): GIVEN `StructureView.tsx` renders, WHEN inspecting the component,
THEN `deriveStage()` from `@/lib/stage` is the sole code path from task/worker state to a
`Stage` value — no inline status string comparisons appear in the component.

---

## Code surface

**New files** (created by the builder task implementing this spec):

- apps/web/src/app/app/(protected)/missions/[id]/StructureView.tsx — StructureView client component
- apps/web/src/lib/structure-layout.ts — computeStructureLayout, StructureNode, StructureEdge, ContentionEdge

**Existing files** (reused or minimally modified):

- `apps/web/src/lib/condensed-timeline.ts` — `identifyChains`, `ChainUnit` (reused, unmodified)
- `apps/web/src/components/StageChip.tsx` — `StageChip` (reused inside nodes)
- `apps/web/src/components/SegmentStrip.tsx` — `SegmentStrip` (reused in collapsed nodes)
- `apps/web/src/lib/stage.ts` — `deriveStage` (sole stage derivation path)
- `apps/web/src/app/app/(protected)/missions/[id]/MissionTabs.tsx` — add Structure tab entry (tab entry only)

---

## Out of scope

- Activity page / task history — separate surface
- Full DAG rendering of inter-mission dependencies — initiative-level view, not mission-level
- Mobile canvas of any kind
- pathManifest-derived soft ordering edges (no stored edge to render; deferred)
- Any modification to `CondensedTimeline.tsx` beyond what `MissionTabs` dispatches
- Automatic STRANDED task recovery suggestions (display only — no action surface)
- Export or screenshot of the graph
- Zooming or panning beyond CSS `transform: scale()` on the container div
