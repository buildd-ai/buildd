---
title: Mission Progress Strip — Topological Order and Dependency-on-Selection
status: active
owner: builder
last_verified: 2026-10-03
summary: The mission Landed strip MUST place every dependency left of its dependents, give blocked, queued and ready distinct textures, and mark a selected cell's blockers or unblocked work on the existing tick row.
domain: surfaces
surfaces: [apps/web/src/app/app/(protected)/missions/[id]/MissionTaskStrip.tsx, apps/web/src/app/app/(protected)/missions/[id]/MissionBoardParts.tsx, apps/web/src/lib/mission-task-strip.ts, apps/web/src/lib/mission-board.ts]
related: [timeline-dependency-geometry, timeline-mobile-rail, mission-structure-view, mission-legibility]
keywords: [landed strip, segment strip, 04 / 14, waiting on 8 dependencies, next open, tick row, topological order, queued behind, stripOrder]
verified_by: [apps/web/src/lib/mission-task-strip.test.ts, apps/web/src/app/app/(protected)/missions/[id]/MissionTaskStrip.dom.test.tsx, apps/web/src/lib/condensed-timeline.test.ts]
assertions:
  - id: "build-mission-adjacency"
    type: "symbol"
    name: "buildMissionAdjacency"
    path: "apps/web/src/lib/condensed-timeline.ts"
  - id: "strip-order"
    type: "symbol"
    name: "stripOrder"
    path: "apps/web/src/lib/mission-task-strip.ts"
  - id: "strip-state"
    type: "symbol"
    name: "stripState"
    path: "apps/web/src/lib/mission-task-strip.ts"
  - id: "strip-slots"
    type: "symbol"
    name: "stripSlots"
    path: "apps/web/src/lib/mission-task-strip.ts"
  - id: "strip-marks"
    type: "symbol"
    name: "stripMarks"
    path: "apps/web/src/lib/mission-task-strip.ts"
  - id: "strip-selection-reason"
    type: "symbol"
    name: "stripSelectionReason"
    path: "apps/web/src/lib/mission-task-strip.ts"
  - id: "mission-task-strip-test"
    type: "test_file"
    path: "apps/web/src/lib/mission-task-strip.test.ts"
  - id: "mission-task-strip-dom-test"
    type: "test_file"
    path: "apps/web/src/app/app/(protected)/missions/[id]/MissionTaskStrip.dom.test.tsx"
  - id: "condensed-timeline-test"
    type: "test_file"
    path: "apps/web/src/lib/condensed-timeline.test.ts"
supersedes: []
---

# Mission Progress Strip — Topological Order and Dependency-on-Selection

**Capability statement**: The interactive task strip in the mission page's
Landed band MUST order its cells so that every dependency sits left of every
task that depends on it, MUST draw blocked, queued-behind and ready work with
distinct textures, and MUST mark on the strip itself which cells hold the
selected task (or which cells the selected task releases), using one adjacency
derivation shared with the Timeline, the Structure canvas and the Activity grid.

> **Status `active`**: built. The shared adjacency is `buildMissionAdjacency`
> (`condensed-timeline.ts`); the strip's rules live in `mission-task-strip.ts`
> (`stripOrder`, `stripState`, `stripSlots`, `stripMarks`,
> `stripSelectionReason`).

---

## 0. The field defect, and which component it is

The screenshot (mission detail → Landed card, 14 cells, drawer reading
`04 / 14  BLOCKED`, "Blocked · waiting on 8 dependencies") is **not**
`SegmentStrip` or `MissionProgressBar`. It is `LandedStrip`
(`apps/web/src/app/app/(protected)/missions/[id]/MissionTaskStrip.tsx`), which
renders `LandedMeter` → `StripCells` → `StripCell`
(`MissionBoardParts.tsx`) and the tethered `StripDrawer`. The order comes from
`stripOrder` in `apps/web/src/lib/mission-task-strip.ts`:

```ts
export function stripOrder(model) { return model.phases.flatMap(p => p.taskIds); }
```

`model.phases` is `groupTasksByPhase` over `orderDeliverables`, i.e. **phase
index, then `createdAt`**. `dependsOn` is never consulted. That is the whole of
defect 1: a task created fourth that depends on eight tasks created after it is
drawn fourth.

Defect 2 is `STRIP_CELL_CLASS`: `ready` and `blocked` both map to
`border-[var(--fleet-border-mid)] fleet-hatch`, so cells 07–14 are
indistinguishable.

Defect 3 is `StripDrawer`: the count comes from
`t.deps.filter(d => !d.ok).length` and is handed to `TaskActionZone`, which
prints "waiting on N dependencies". The tick row in `StripCells` knows nothing
about the selection beyond the selected cell's own number.

`SegmentStrip` and `MissionProgressBar` are in scope only for the delete list
(§10) and the "unaddressable strips" rule (§2.6). The constraint "zero new
components" holds: every change below is a helper, a class table, or a prop on
`LandedMeter` / `StripCells` / `StripDrawer`. TypeGlyph is named in the brief
but does not exist (see `timeline-mobile-rail.md` §10.3); nothing here needs it.

---

## 1. Vocabulary

| Term | Definition |
|---|---|
| **cell** | One `StripCell` button. One deliverable row from `buildMissionBoard` (attempts folded, cancelled rows excluded — unchanged). |
| **position** | 1-based left-to-right index of a cell. The tick label `stripTick(i)`. |
| **edge** | A `dependsOn` reference from task T to task D, after attempt/re-creation folding (`rowIdFor` in `buildMissionBoard`). |
| **on-strip edge** | Both ends are cells of this strip. |
| **off-strip blocker** | An unsatisfied dependency whose task is not a cell: another mission's task, or a task outside the mission's deliverable set. |
| **satisfied** | `isGateSatisfied(dep, dep.workers)` is true — the claim gate's definition (`timeline-dependency-geometry.md` §2.5, GP-1). Nothing else. |
| **blockers(T)** | T's dependencies that are not satisfied. The truthful full set (TR-1). |
| **frontier(T)** | blockers(T) after transitive reduction — the set `reduceToFrontier` returns (TR-2, TR-3). |
| **upstream(T)** | Every task reachable from T by following only unsatisfied edges toward dependencies. Superset of blockers(T). |
| **downstream(T)** | Every non-landed task that reaches T by following only unsatisfied edges toward dependencies — the work T is holding. |
| **component** | A weakly connected set of cells under on-strip edges. |
| **level** | 1 + the longest on-strip edge path from any root of the component to the cell. A root (no on-strip deps) is level 1. |
| **active** | A cell whose display state (§3) is `running`, `waiting`, `review`, `fixing`, `ci_failed`, `failed` or `ready`. |
| **held** | A cell whose display state is `blocked` or `queued`. |

---

## 2. Ordering rule

### 2.1 Sort key

`stripOrder` MUST return cells sorted by this key, compared left to right:

1. **component order** — components ordered by the earliest `createdAt` of any
   member (ties: smallest task id).
2. **level** — ascending.
3. ~~readiness class~~ — removed: no key reads runtime state, so a status
   change never moves a cell and ‹ / › / arrow keys step to the adjacent
   rendered cell.
4. **phase index** — the stored `missionPhaseIndex`, nulls last.
5. **`createdAt`** — ascending.
6. **task id** — ascending (total order; two renders of one model are identical).

**Rule ORD-1 (topological)**: for every on-strip edge T→D outside a cycle,
position(D) < position(T). Holds by construction: every edge raises the level
by at least one, and component and level outrank every state-based key.

**Rule ORD-2 (deterministic)**: `stripOrder` is a pure function of the board
model. Same model in, same array out.

**Rule ORD-3 (bounded motion)**: a state change moves a cell only within the
run of cells that share its component and level. A cell never crosses a level
boundary or a component boundary because something landed or started.

### 2.2 Why levels, not a free Kahn order

A priority-queue Kahn sort with readiness as the priority is also topological,
but a single state change can reshuffle the whole tail of the strip: the cell
under the user's thumb jumps across the screen. Level banding gives the same
"dependencies left" guarantee and bounds every reorder to one level (ORD-3). It
also gives the ordinal something true to say (§4).

### 2.3 Why components before levels

Without component grouping, two independent chains interleave
(`A X B Y C`), and the selection marks of §5 scatter across unrelated work.
Grouping keeps a chain's cells in one contiguous run, so "what is stuck behind
what" reads as a single span.

### 2.4 Out-of-order landing: landed cells stay in place

When a dependent lands before its dependency (a forced claim, a dependency
reopened by a retry, an edge added after the fact), the landed cell keeps its
level and stays **right** of the open dependency. The strip does **not**
compact landed cells to the left.

Justification: global compaction is exactly the state sort that
`MissionProgressBar` does today (§10). It breaks ORD-1 the first time work lands
out of order, and that is the case where the strip most needs to be right —
a solid green cell sitting right of an open cell is the visible evidence that
the order of work and the order of dependencies diverged. Within a level, the
readiness key already pulls landed cells left, so a level that is half done
still reads as a left-filling bar. That is the only compaction, and it never
crosses a level.

### 2.5 Phases

Phase stays a tie-breaker (key 4), not a primary grouping. `phase` and
`dependsOn` are independent fields and nothing cross-validates them
(the removed Structure layout's header comment said so); a phase-first order breaks ORD-1
whenever a later-phase task is a dependency of an earlier-phase one. The
non-interactive `LandedMeter` variants (`band` without `selection`, `strip`)
keep their phase-grouped layout and captions: they are unaddressable (§2.6).

### 2.6 Addressable vs unaddressable strips

**Rule ADDR-1**: a strip whose cells carry a position (tick numbers, an
ordinal, arrow-key stepping, selection) MUST use the §2.1 order.

**Rule ADDR-2**: a strip with no position — `MissionProgressBar` densities
`full`, `stacked`, `mini`, and `LandedMeter` without `selection` — MUST NOT
render tick numbers, an ordinal, or a selection. Compacting it by state or
grouping it by phase is permitted. A histogram is honest about being a histogram; it
becomes a lie only when it is numbered.

---

## 3. State vocabulary on the strip

### 3.1 Display states

The strip adds two display states on top of `BoardStatus`. The split is derived
from the shared adjacency (§6), never stored.

| Display state | From `BoardStatus` | Condition |
|---|---|---|
| `landed` | `merged`, `done` | — |
| `review` | `review` | — |
| `running` | `running` | — |
| `fixing` | `fixing` | — |
| `waiting` | `waiting` | — |
| `ci_failed` / `failed` | same | — |
| `ready` | `ready` | blockers(T) is empty |
| `blocked` | `blocked` | some member of frontier(T) is **active**, or is an off-strip blocker |
| `queued` | `blocked` | every member of frontier(T) is **held** (T is queued behind a chain that itself is not moving) |

**Rule ST-1 (gate parity)**: `ready` vs `blocked`/`queued` MUST be decided by
blockers(T) under `isGateSatisfied`. Today `buildMissionBoard` decides ready
from feedLanded (deleted) (`depsLanded`) while the drawer counts `!d.ok`, where `ok` is
"landed or in review". Two definitions inside one model is how the count and
the hatch disagree; both MUST read blockers(T).

**Rule ST-2 (cross-mission)**: an off-strip blocker counts. Today
`buildMissionBoard` filters `dependsOn` to `allById`, so a task waiting on
another mission's task computes `depsLanded = true` and renders `ready` while
the claim gate refuses it. That is a phantom-ready cell. The page query MUST
load each off-strip dependency's id, title, status, mission and PR worker
fields (read-only; nothing the orchestrator stores changes) so the gate can be
evaluated.

### 3.2 Cell treatment (`STRIP_CELL_CLASS`)

All cells keep the 2px border (`border-2`), the `h-11` / `md:h-14` height, and
the existing selected treatment (`-translate-y-1` + 2px outline). Only the
class table changes. Textures are chosen so that every state is distinguishable
in greyscale.

| Display state | Border | Fill | Change |
|---|---|---|---|
| `landed` | `border-status-success` | solid `bg-status-success` | unchanged |
| `review` | `border-status-success` | `fleet-hatch-ok` (vertical) | unchanged |
| `running` | `border-accent` | `fleet-hatch-accent` (dense diagonal) | unchanged |
| `waiting` | `border-accent`, 2.5px | `bg-card` (empty) | was shared with running; now `METER_CLASS.waiting` |
| `ci_failed`, `failed`, `fixing` | `border-status-error` | `fleet-hatch-err` | unchanged |
| `ready` | `border-border-strong` | `bg-card` (empty, no hatch) | **new**: an open slot, nothing holding it |
| `blocked` | `border-[var(--fleet-border-mid)]` | `fleet-hatch` (dense diagonal, 2px/6px) | unchanged texture, now `blocked` only |
| `queued` | `border-[var(--fleet-border-mid)]` | `fleet-hatch-future` (sparse diagonal, 1px/7px) | **new mapping**, existing class |

**Rule ST-3**: `ready`, `blocked` and `queued` MUST resolve to three different
class strings, and the three fills MUST differ in texture (none / dense /
sparse), not only in colour.

### 3.3 Words

`STATUS_PILL` and `STATUS_WORDS` gain the split: `ready` → "Ready" / "ready"
(today "Queued" / "open" — the old pill word now belongs to the queued state),
`blocked` → "Blocked" / "blocked", `queued` → "Queued" / "queued behind".

---

## 4. Ordinal semantics

`04 / 14` is deleted. "N / total" reads as "Nth of a sequence of 14", which is
false whenever two cells are parallel, and the band already shows "9 of 14" as
the landed count.

The drawer header becomes:

```
13 · LEVEL 9 OF 10   QUEUED   builder
```

- `13` — the cell's position, the same string as its tick. It is an address,
  and after §2 it is a true lower bound: every task this one waits on is in
  positions 01–12.
- `LEVEL l OF L` — l = the cell's level, L = the deepest level in its
  component. It says "at least l − 1 tasks have to land one after another
  before this one can". That is true; "4th of 14" was not.
- **Rule ORDN-1**: the level segment is omitted for a cell with no on-strip
  edges (its component has one level). Any cell with an on-strip edge is in a
  component of at least two levels and shows it.
- **Rule ORDN-2**: no string matching `/\d+ \/ \d+/` is rendered in the drawer
  header.
- The cell `aria-label` becomes
  `Cell {pos} of {n}, level {l} of {L}, {state words}: {title}` (level omitted
  per ORDN-1). "Task 4 of 14" is deleted for the same reason as the header.

---

## 5. Dependency-on-selection

### 5.1 Direction is chosen by the selected cell's state

| Selected cell | Marks show | Drawer reason line |
|---|---|---|
| `blocked`, `queued` | **upstream**: frontier(T) = direct marks; upstream(T) − frontier(T) = transitive marks | `After 12 {label} (+7 upstream).` |
| any **active** state with a non-empty downstream(T) | **downstream**: non-landed direct dependents = direct marks; rest of downstream(T) = transitive marks | `Unblocks 08, 13 (+3 downstream).` |
| active with empty downstream(T) | none | unchanged |
| `landed` | none | unchanged |

Because of ORD-1, upstream marks always fall left of the selected cell and
downstream marks always fall right of it, so one mark vocabulary serves both
directions; the side of the screen, and the drawer's "After" / "Unblocks",
say which.

**Rule SEL-1**: marks are recomputed from the selected task id only; the
selection store (`useMissionStrip`) and the "a selection change re-renders two
cells" property of `StripCell` stay. Marks live on the tick row, which
re-renders as one unit.

**Rule SEL-2**: the reason line names at most two cells, frontier-first, as
`{tick} {label}`, and tails the rest as `+N upstream` / `+N downstream`
(CC-3/CC-4 parity with `DependencyRail`). Off-strip blockers are named by
title plus `· other mission` and are always named before on-strip ones.

**Rule SEL-3**: the "waiting on N dependencies" count in `TaskActionZone`
MUST equal |blockers(T)|, including off-strip blockers — the same set the
marks are drawn from. Satisfied deps (landed, cancelled, closed-PR) are never
counted and never marked.

### 5.2 Mark rendering on the existing tick row

No new element. The tick `<span>` per cell in `StripCells` gets a
`data-mark` attribute (`direct` | `transitive` | absent) and a class from a
two-entry table, using the existing accent:

| Tick mode | `direct` | `transitive` |
|---|---|---|
| numbered (n ≤ `MAX_NUMBERED_TICKS`) | number drawn inverse: `bg-accent text-card`, 2px box | number in `text-accent-text` with a 2px `border-b-2 border-accent` underline |
| unnumbered (n > `MAX_NUMBERED_TICKS`) | full-cell-width bar, 6px (`h-1.5 w-full bg-accent`) | full-cell-width line, 2px (`h-0.5 w-full bg-accent`) |

**Rule MK-1**: a marked tick is always drawn, even in unnumbered mode where an
unmarked landed tick draws nothing. Mark beats the open-cell dot.

**Rule MK-2**: `direct` and `transitive` differ in shape (filled box vs
underline; 6px vs 2px), not only colour.

**Rule MK-3**: the selected cell's own tick keeps its number in every mode
(existing behaviour) and is never itself marked.

**Rule MK-4**: the cells themselves are not restyled by a mark. The cell says
what state a task is in; the tick says how it relates to the selection. One
signal per row.

---

## 6. One adjacency derivation

There are four edge walks over mission tasks today:

1. `identifyChains` pass 1 — unresolved blockers/dependents within a set
   (`condensed-timeline.ts`).
2. `collapseTerminalChains` — the same over resolved edges among terminal
   tasks.
3. `buildMissionBoard` — its own `deps` / `unblocks` loops with its own
   satisfaction rule (§3.1, ST-1).
4. computeStructureLayout (the Structure canvas, since removed) — its own
   blockerMap / dependentsOf and assignRanks.

**Rule ADJ-1**: identifyChains' pass 1 is extracted into one exported pure
helper in `apps/web/src/lib/condensed-timeline.ts` (proposed name:
buildMissionAdjacency). Input: tasks with `id`, `status`, `dependsOn`,
`workers`, plus the folded-id map. Output, computed in one O(N+E) pass:

- blockersOf / dependentsOf over **all** on-strip edges, each edge tagged
  satisfied or not by `isGateSatisfied`;
- offStripBlockersOf — unsatisfied edges whose target is not in the set;
- level per task and maxLevel per component (Kahn longest path — the
  algorithm the old assignRanks implemented, moved, not copied);
- component id per task;
- cycle members (tasks Kahn never released).

**Rule ADJ-2**: `identifyChains`, `collapseTerminalChains`,
`buildMissionBoard` (its `deps`, `unblocks` and ready/blocked decision),
the Flow timeline (`buildFlowTimeline`, which reads the board's deps and the
strip order; `mission-flow-timeline.md`) and the strip (§2, §3, §5) all read
that one result. None of them walks `dependsOn` itself afterwards.

**Rule ADJ-3**: frontier(T) is `reduceToFrontier` — exported from
`task-presentation.ts` and fed the helper's edges, not re-implemented. The
Timeline rail, the Activity grid (`TaskGrid` via `deriveChainPosition`) and
the strip therefore name the same frontier for the same task.

`ChainUnit` grouping is not used for strip order: a strip is one row, and
chain-unit contiguity is the Timeline's job (elbows). The strip reuses the
adjacency underneath it, which is what makes the two agree.

---

## 7. DAG shapes — worked examples

Notation: letters are tasks in creation order. `■` landed, `▤` review,
`▨` running, `□` ready, `▦` blocked (dense), `░` queued (sparse), `✕` failed,
`◇` waiting. Under the strip, `▼` = direct mark, `·` = transitive mark,
`^` = selected.

### 7.1 Linear chain — A→B→C→D→E

States: A landed, B running, C D E held. Levels 1–5, one component.

```
A B C D E
■ ▨ ▦ ░ ░
```

C is `blocked` (its frontier {B} is active); D and E are `queued` (their
frontier is held). Select E: `▼` under D, `·` under C and B. Drawer:
`05 · LEVEL 5 OF 5  QUEUED`, "After 04 D (+2 upstream)." Select B: `▼` under C,
`·` under D, E; "Unblocks 03 C (+2 downstream)."

### 7.2 Fan-out — A→{B, C, D}

A running; B, C, D blocked. A level 1; B, C, D level 2, tied on readiness →
creation order.

```
A B C D
▨ ▦ ▦ ▦
^ ▼ ▼ ▼
```

Select A: three direct marks, "Unblocks 02 B, 03 C (+1 downstream)."

### 7.3 Fan-in / join — {B, C}→D

B review, C running, D blocked. B, C level 1 (B left: readiness 1 < 2); D level 2.

```
B C D
▤ ▨ ▦
▼ ▼ ^
```

Frontier(D) = {B, C}: both direct. A review dep is **not** satisfied (open PR,
GP-1), so B is marked.

### 7.4 Diamond — A→B, A→C, B→D, C→D

A landed, B landed, C running, D blocked. Levels A1, B2, C2, D3.

```
A B C D
■ ■ ▨ ▦
    ▼ ^
```

Select D: only C is marked. B and A are satisfied and are never marked.
Nothing on the strip implies B→C.

### 7.5 Sibling chains — A→B→C and X→Y

A created before X. All held except A (ready) and X (running).

```
A B C X Y
□ ▦ ░ ▨ ▦
```

Components stay contiguous (§2.3). Without component ordering this would read
`A X B Y C`. Select C: `▼` B, `·` A; nothing in X–Y is marked.

### 7.6 Cross-mission blocker

B depends on A and on Z (another mission, running). A landed.

```
A B
■ ▦
  ^
```

No cell is marked — Z has no cell. B is `blocked` (an off-strip blocker
counts, ST-2), not `ready`. Drawer: "After {Z title} · other mission." The
count reads 1. **Rule XM-1**: a held cell with no on-strip marks MUST name at
least one off-strip blocker in its reason line; if it cannot, the data is
inconsistent and the reason line says "Waiting on its dependencies." (today's
fallback).

### 7.7 Partially complete chain, with an out-of-order landing

A→B→C. B was force-started and landed while A was reopened by a retry and is
now `ready`. C depends only on B; B is landed and merged, so C is `ready`.

```
A B C
□ ■ □
```

B stays right of A (§2.4) — the solid cell right of an open one is the
evidence that work landed out of order. Select A: its only dependent B is
landed, and C's edge to B is satisfied, so downstream(A) is empty — no marks.
Select C: blockers(C) is empty, no marks.

### 7.8 The 14-cell screenshot case

Fourteen tasks A–N in creation order, one phase. Edges:
B→A, C→B, F→A, E→C, G→C, H→E, I→G, J→H, L→I, K→J, M→K, M→L,
D→{C, E, F, G, H, I, J, K, L, M}, N→D.

States: A B C F landed; E running; G ready; all others pending.

**Today** (`stripOrder` = creation order):

```
01 02 03 04 05 06 07 08 09 10 11 12 13 14
A  B  C  D  E  F  G  H  I  J  K  L  M  N
■  ■  ■  ▨̸  ▨  ■  ▨̸  ▨̸  ▨̸  ▨̸  ▨̸  ▨̸  ▨̸  ▨̸     (▨̸ = one shared hatch)
```

D is drawn fourth, waiting on eight tasks of which seven are to its right; F
"landed before" D and E; G (ready) looks like H (blocked).

**After**. Levels: A1; B2 F2; C3; E4 G4; H5 I5; J6 L6; K7; M8; D9; N10.
Within level 2, B and F are both landed → creation order. Within level 4, E
(running, class 2) precedes G (ready, class 4).

```
01 02 03 04 05 06 07 08 09 10 11 12 13 14
A  B  F  C  E  G  H  I  J  L  K  M  D  N
■  ■  ■  ■  ▨  □  ▦  ▦  ░  ░  ░  ░  ░  ░
```

H is `blocked` (frontier {E}, running); I is `blocked` (frontier {G}, ready);
J, L, K, M are `queued`; D's frontier is {M}, held → `queued`; N `queued`.

Select D (cell 13):

```
01 02 03 04 05 06 07 08 09 10 11 12 13 14
            ·  ·  ·  ·  ·  ·  ·  ▼  ^
```

Drawer: `13 · LEVEL 9 OF 10   QUEUED`, "After 12 M (+7 upstream).",
"waiting on 8 dependencies". All eight blockers sit left of 13. F (landed) and
C (landed) are not marked.

Select G (cell 06, ready): direct dependents I (08) and D (13); further
downstream L (10), M (12), N (14).

```
01 02 03 04 05 06 07 08 09 10 11 12 13 14
               ^     ▼     ·     ·  ▼  ·
```

"Unblocks 08 I, 13 D (+3 downstream)."

### 7.9 Cycles (malformed data)

A→B, B→A, C→A. Kahn releases nothing in {A, B}; C depends on a cycle member
and is never released either.

**Rule CYC-1**: tasks Kahn never releases are appended after all released
tasks of their component, ordered by readiness, phase, `createdAt`, id, and
given level = maxLevel of the released part + 1. ORD-1 is waived for edges
between unreleased tasks only.
**Rule CYC-2**: every task still gets exactly one cell; the helper terminates
in O(N+E).
**Rule CYC-3**: frontier is non-empty for a held cycle member (TR-3), so
selecting it always marks at least one cell.

### 7.10 Width greater than the strip

One root A with 30 dependents B1…B30, all at level 2. All 31 cells render in
one row: n > 24 → `--strip-gap: 1px` (§8). At 360px each cell is ≈ 9.6px.
Ticks are unnumbered (n > 12): open cells carry the existing dot, marks
replace the dot (MK-1). Select A: 30 direct bars under the tick row.

### 7.11 64+ cells

The strip renders at most `FLIGHT_STRIP_BAR_CAP` (64) cell buttons.

**Rule CAP-1**: when n > 64, fold the leftmost K = n − 63 **landed** cells (in
§2.1 order) into one summary cell at position 01: solid success fill, tick
`+K`, `aria-label` "K landed tasks". If fewer than K cells are landed, fold
the rightmost **queued** cells into a trailing summary cell (`+K`, `queued`
texture) for the remainder. Active and blocked cells are never folded —
the gotcha recorded for `computeMissionFlightStrip` (dropping live work at the
cap) MUST NOT recur here.
**Rule CAP-2**: the summary cell is exempt from ORD-1. A mark whose target is
folded marks the summary cell's tick instead.
**Rule CAP-3**: selecting a summary cell opens a drawer with the count and a
link to the Timeline tab; it has no task actions.

---

## 8. 360px behaviour

Content width at 360px is 328px (16px page padding each side).

| n | `--strip-gap` | cell width at 360px | ticks |
|---|---|---|---|
| 1–11 | 4px | ≥ 26.2px | numbered |
| 12 | 4px | 23.7px | numbered |
| 13–24 | 4px | 21.5 → 9.8px | unnumbered + dots + marks |
| 25–64 | 1px | 12.2 → 4.1px | unnumbered + dots + marks |

**Rule W-1 (gap density)**: `--strip-gap` is 4px for n ≤ 24 and 1px for
n > 24 (6px / 1px at `md`). `stripCaretLeft` already reads the variable, so
the caret and tether stay exact.

**Rule W-2 (tap targets)**: cells stay `h-11` (44px tall). Width falls under
24px from n = 12 at 360px. The ‹ / › stepper buttons (44×44) and the Next
open button are the conforming equivalent control (WCAG 2.5.8 equivalent
exception); they MUST remain rendered whenever the strip is.

**Rule W-3 (marks never vanish)**: a mark is drawn at the full width of its
cell's tick slot, minimum 1px, at every n ≤ 64. At 4.1px a direct mark is a
4×6px block, a transitive mark a 4×2px line.

**Rule W-4 (truncation)**: the drawer reason line names at most two cells
(SEL-2) and wraps with `[overflow-wrap:anywhere]` (existing); the header
`13 · LEVEL 9 OF 10` never truncates (at most 20 characters at n ≤ 64).

---

## 9. Next open

**Rule NX-1**: Next open cycles through **open** cells only (active and not
failed, `openIndices`), in strip order (§2.1), starting after the selection
and wrapping. Held cells are skipped: there is nothing to do on a held task
except look at its blockers, which the marks already show. Failed cells are
skipped too: the header counts them apart (TONE-1), so the cycle must not
visit a cell the count does not call open.

Readiness decides membership (active vs held); topology decides sequence
(strip order). The two are not alternatives: Next open uses both, and because
the strip is topological, stepping forward through active cells walks
dependencies before dependents.

**Rule NX-2**: the header button reads `{a} open ›` where a = number of active
cells, plus ` · {h} held` when h > 0. Today's "open" means "not landed",
which counts held cells the button then visits; after this change the count
and the cycle set are the same set.

**Rule NX-3**: label states: `Next open · 06` / `Only open task · 06` /
`All tasks landed` (unchanged) / `Nothing open · 2 failed` when a = 0 and a
cell has failed (it selects the leftmost failed cell) / **new**
`Nothing open · 3 held` when a = 0, nothing failed
and h > 0 — enabled, and it selects the leftmost held cell (whose blocker is
off-strip or in a cycle; there is no other way for every non-landed cell to
be held).

**Rule NX-4**: `defaultStripSelection` order of preference: the focus task;
else the first active cell; else the first held cell; else the last cell.

‹ / › and ArrowLeft/Right/Home/End keep stepping by position
(`stepIndex`, `stripKeyTarget`), unchanged.

---

## 10. Delete list

| Location | What goes | Replaced by |
|---|---|---|
| `apps/web/src/lib/mission-task-strip.ts` `stripOrder` | `model.phases.flatMap(p => p.taskIds)` | §2.1 sort over the shared adjacency |
| `mission-task-strip.ts` openIndices (deleted) | "open = not in `BOARD_LANDED`" | active-set test (§1) |
| `mission-task-strip.ts` `defaultStripSelection` | "first unfinished" | NX-4 |
| `MissionTaskStrip.tsx` `StripDrawer` | the `{tick} / {n}` header | §4 header |
| `MissionTaskStrip.tsx` `StripDrawer` | `t.deps.filter(d => !d.ok).length` (twice) | \|blockers(T)\| from the shared adjacency |
| `MissionTaskStrip.tsx` `stripReason` `blocked` branch | `t.deps.filter(d => !d.ok)` scope list | SEL-2 frontier sentence |
| `MissionTaskStrip.tsx` `LandedStrip` | `${open.length} open ›` over not-landed | NX-2 |
| `MissionBoardParts.tsx` `StripCells` | the "Task {i + 1} of {n}, …" aria-label | §4 aria-label |
| `MissionBoardParts.tsx` `STRIP_CELL_CLASS` | `ready` and `blocked` sharing one class | §3.2 table |
| `mission-board.ts` `buildMissionBoard` | `BoardDep.ok` = landed-or-in-review; `depsLanded` from feedLanded (deleted); the `allById` filter that drops off-strip deps; the `unblocks` push loop | the shared adjacency (ADJ-2, ST-1, ST-2) |
| structure-layout.ts assignRanks and its local blockerMap build (the file is since removed with the Structure canvas) | private Kahn | moved into the shared helper (ADJ-1) |
| `condensed-timeline.ts` `identifyChains` pass 1 and `collapseTerminalChains` edge loop | two local adjacency builds | the shared helper |
| `MissionProgressBar.tsx` `FullBar`, `StackedBar`, mini branch | three inline copies of `const order = { solid: 0, half: 1, ghost: 2, notch: 3, empty: 4 }` + sort | one exported state-compaction helper, used by all three (ADDR-2 keeps them state-compacted; there must be one copy, not three) |

Nothing on this list changes a stored column, an API payload, or anything the
orchestrator emits.

---

## 11. Acceptance criteria

Each criterion is checkable against a board model built from fixtures
(`buildMissionBoard` input) or a rendered `LandedStrip`, without a database.

- **AC-1**: GIVEN any board model with on-strip edges and no cycle, WHEN
  `stripOrder` runs, THEN for every edge T→D, index(D) < index(T).
- **AC-2**: GIVEN the §7.8 fixture, WHEN `stripOrder` runs, THEN it returns
  `A B F C E G H I J L K M D N`.
- **AC-3**: GIVEN the §7.8 fixture, WHEN only G's status changes from ready to
  running, THEN no cell changes level and the only cells whose index changes
  are in G's level.
- **AC-4**: GIVEN the same model twice, WHEN `stripOrder` runs on each, THEN
  the outputs are identical.
- **AC-5**: GIVEN A→B with B landed and A ready (§7.7), WHEN `stripOrder`
  runs, THEN A precedes B (landed cells are not compacted left).
- **AC-6**: GIVEN sibling chains A→B→C and X→Y with A created first, WHEN
  `stripOrder` runs, THEN it returns `A B C X Y`.
- **AC-7**: GIVEN one ready, one blocked and one queued cell, WHEN the strip
  renders, THEN their three `StripCell` class strings are pairwise different
  and their fills are `bg-card`, `fleet-hatch`, `fleet-hatch-future`
  respectively.
- **AC-8**: GIVEN a task whose only unsatisfied dep is in review (completed,
  PR open), WHEN the board is built, THEN its display state is `blocked`, not
  `ready` (gate parity, ST-1).
- **AC-9** (rejection): GIVEN a task whose only unsatisfied dep belongs to
  another mission, WHEN the board is built, THEN its display state is
  `blocked`, never `ready`, and the drawer count reads 1 (ST-2).
- **AC-10**: GIVEN the §7.8 fixture with D selected, WHEN the strip renders,
  THEN the tick at position 12 has `data-mark="direct"`, the ticks at 05–11
  have `data-mark="transitive"`, and no other tick has `data-mark`.
- **AC-11**: GIVEN the §7.8 fixture with G selected, WHEN the strip renders,
  THEN ticks 08 and 13 are `direct`, ticks 10, 12 and 14 are `transitive`,
  and no tick left of 06 is marked.
- **AC-12**: GIVEN a landed cell selected, WHEN the strip renders, THEN no
  tick has `data-mark`.
- **AC-13**: GIVEN any selected held task, WHEN the drawer renders, THEN the
  "waiting on N" count equals |blockers(T)| (on-strip plus off-strip) and every
  on-strip member of blockers(T) has a marked tick. Transitive marks beyond
  blockers(T) are extra context, not counted: in a linear chain A→B→C→D→E,
  selecting E reads "waiting on 1" and marks D, C and B (§7.1). Where every
  upstream task is a direct dependency (§7.8) count and marks coincide.
- **AC-14** (rejection): GIVEN any selected cell, WHEN the drawer renders,
  THEN its header matches no `/\d+ \/ \d+/` and reads `{pos} · LEVEL l OF L`
  (or `{pos}` alone for a single-level component).
- **AC-15**: GIVEN the §7.8 fixture, WHEN Next open is pressed repeatedly from
  position 01, THEN it visits 05, 06, 05, … and never a held cell.
- **AC-16**: GIVEN a model where every non-landed task is held behind an
  off-strip blocker, WHEN the strip renders, THEN the button reads
  `Nothing open · {h} held`, is enabled, and selects the leftmost held cell.
- **AC-17**: GIVEN a cycle A↔B plus C→A, WHEN `stripOrder` runs, THEN it
  terminates, returns each of A, B, C exactly once, after every released task
  of the component (CYC-1, CYC-2).
- **AC-18**: GIVEN 80 tasks of which 30 are landed, WHEN the strip renders,
  THEN exactly 64 cell buttons exist, the first is a `+17` summary cell, and
  every running, blocked and ready task has its own cell (CAP-1).
- **AC-19**: GIVEN 30 cells at a 360px viewport, WHEN the strip renders, THEN
  `--strip-gap` resolves to 1px and every marked tick has a rendered width
  ≥ 1px (W-1, W-3).
- **AC-20**: GIVEN the codebase after the change, WHEN `buildMissionBoard`,
  `identifyChains`, `collapseTerminalChains`, `buildFlowTimeline` and
  `stripOrder` are searched, THEN none of them reads `.dependsOn` directly;
  each consumes the shared adjacency helper's result (ADJ-2).
- **AC-21**: GIVEN `MissionProgressBar.tsx` after the change, WHEN searched,
  THEN the literal `{ solid: 0, half: 1, ghost: 2, notch: 3, empty: 4 }`
  appears at most once.
- **AC-22** (rejection): GIVEN any strip rendered with state-compacted order
  (ADDR-2), WHEN inspected, THEN it carries no tick numbers, no ordinal and no
  selectable cell.

---

## Code surface

- `apps/web/src/app/app/(protected)/missions/[id]/MissionTaskStrip.tsx` —
  `LandedStrip`, `StripDrawer`, `stripReason`
- `apps/web/src/app/app/(protected)/missions/[id]/MissionBoardParts.tsx` —
  `LandedMeter`, `StripCells`, `StripCell`, `STRIP_CELL_CLASS`,
  `STATUS_WORDS`, `MAX_NUMBERED_TICKS`, `stripTone`
- `apps/web/src/app/app/(protected)/missions/[id]/TaskActionZone.tsx` — the
  "waiting on N dependencies" line
- `apps/web/src/app/app/(protected)/missions/[id]/mission-page-query.ts` —
  loads the board input; gains off-strip dependency rows (ST-2)
- `apps/web/src/lib/mission-task-strip.ts` — `stripOrder`, openIndices (deleted),
  `nextOpenIndex`, `defaultStripSelection`, `stripCaretLeft`, `stripTick`
- `apps/web/src/lib/mission-board.ts` — `buildMissionBoard`, `BoardTask`,
  `BoardDep`, `BoardStatus`, `BOARD_LANDED`
- `apps/web/src/lib/condensed-timeline.ts` — `identifyChains`, home of the
  shared adjacency helper
- `apps/web/src/lib/task-presentation.ts` — `isGateSatisfied`,
  `deriveChainPosition`, `reduceToFrontier`
- `apps/web/src/lib/flow-timeline.ts` — `buildFlowTimeline` (reads the
  shared adjacency through the board; the Structure layout it replaced is removed)
- `apps/web/src/components/MissionProgressBar.tsx` — `MissionProgressBar`
  (delete list only)
- `apps/web/src/app/globals.css` — `fleet-hatch`, `fleet-hatch-future`,
  `fleet-hatch-accent`, `fleet-hatch-ok`, `fleet-hatch-err` (existing)

## Out of scope

- Visual gaps between levels on the strip. It would show parallelism without
  opening the drawer, but `stripCaretLeft` assumes uniform gaps and every
  caret/tether position would need a level-aware variant. Revisit after this
  ships.
- The Timeline tab's row geometry — `timeline-dependency-geometry.md` owns it;
  this spec only shares its adjacency.
- `SegmentStrip` glyphs and `MissionProgressBar` colours — unchanged beyond
  the delete list.
- Any change to `dependsOn`, `missionPhaseIndex` or what the orchestrator
  stores or emits. Ordering is computed at render time from existing fields.
- A cycle label on the strip. Cycles terminate and render (§7.9); naming them
  is the same open item as `timeline-dependency-geometry.md`'s out-of-scope
  CYCLE chip.
