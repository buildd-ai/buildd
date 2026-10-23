---
title: Mission Progress Strip — Topological Order and Dependency-on-Selection
status: active
owner: builder
last_verified: 2026-10-22
summary: The mission Landed strip MUST place every dependency left of its dependents, give blocked, queued and ready distinct textures, and mark a selected cell's blockers or unblocked work on the existing tick row.
domain: surfaces
surfaces: [apps/web/src/app/app/(protected)/missions/[id]/MissionTaskStrip.tsx, apps/web/src/app/app/(protected)/missions/[id]/MissionBoardParts.tsx, apps/web/src/lib/mission-task-strip.ts, apps/web/src/lib/mission-board.ts]
related: [timeline-dependency-geometry, timeline-mobile-rail, mission-structure-view, mission-legibility]
keywords: [landed strip, segment strip, 04 / 14, waiting on 8 dependencies, next open, tick row, topological order, queued behind, stripOrder]
verified_by: [apps/web/src/lib/mission-task-strip.test.ts, apps/web/src/lib/mission-overview.test.ts, apps/web/src/app/app/(protected)/missions/[id]/OverviewTaskStatus.dom.test.tsx, apps/web/src/components/ui/TaskStrip.test.tsx, apps/web/src/app/app/(protected)/missions/[id]/MissionTaskStrip.dom.test.tsx, apps/web/src/lib/condensed-timeline.test.ts]
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
derivation (`buildMissionAdjacency`) shared with the History tab's timeline rail
and the Flow tab (the Structure canvas it once shared with is removed).

> **Status `active`**: built. The shared adjacency is `buildMissionAdjacency`
> (`condensed-timeline.ts`); the strip's rules live in `mission-task-strip.ts`
> (`stripOrder`, `stripState`, `stripSlots`, `stripMarks`,
> `stripSelectionReason`).

---

## 0. Navigation amendment

The strip keeps its ordering, textures and dependency marks. The former
`StripDrawer` is retired: clicking a task cell (or pressing Enter/Space) opens
the task page with mission back context. ArrowLeft/Right/Home/End move the
selection and its marks without navigating. References below to the old drawer
record the ordering work's original presentation; the current interaction is
specified by R-11, R-27 and R-31..R-35 and the task-page contract.

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
| **blockers(T)** | T's dependencies that are not satisfied. The truthful full set (TR-1 in `timeline-dependency-geometry.md`). |
| **frontier(T)** | blockers(T) after transitive reduction — the set `reduceToFrontier` returns (TR-2, TR-3 in `timeline-dependency-geometry.md`). |
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

**R-1** (topological): for every on-strip edge T→D outside a cycle,
position(D) < position(T). Holds by construction: every edge raises the level
by at least one, and component and level outrank every state-based key.

**R-2** (deterministic): `stripOrder` is a pure function of the board
model. Same model in, same array out.

**R-3** (bounded motion): a state change moves a cell only within the
run of cells that share its component and level. A cell never crosses a level
boundary or a component boundary because something landed or started.

### 2.1a Scoped amendment: the Overview tab groups by outcome

On the mission page's Overview tab only, the strip draws build tasks in three
groups, Done, then In progress, then Waiting, with audit, fix and refresh rows
after them (Living Spec f7f67f1a R-1). This spec's R-1 and the §2.1 sort key still hold
inside each group, so a dependency never sits right of its dependent within a
group, and a cell changes group only when its status changes. Every other
consumer of `stripOrder` (Flow, the mission list, Home, the pulse and the card
view) keeps plain §2.1 order, unchanged. The projection is `overviewLayout` in
`apps/web/src/lib/mission-overview.ts`.

### 2.2 Why levels, not a free Kahn order

A priority-queue Kahn sort with readiness as the priority is also topological,
but a single state change can reshuffle the whole tail of the strip: the cell
under the user's thumb jumps across the screen. Level banding gives the same
"dependencies left" guarantee and bounds every reorder to one level (R-3). It
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
`MissionProgressBar` does today (§10). It breaks R-1 the first time work lands
out of order, and that is the case where the strip most needs to be right —
a solid green cell sitting right of an open cell is the visible evidence that
the order of work and the order of dependencies diverged. Within a level, the
readiness key already pulls landed cells left, so a level that is half done
still reads as a left-filling bar. That is the only compaction, and it never
crosses a level.

### 2.5 Phases

Phase stays a tie-breaker (key 4), not a primary grouping. `phase` and
`dependsOn` are independent fields and nothing cross-validates them
(the removed Structure layout's header comment said so); a phase-first order breaks R-1
whenever a later-phase task is a dependency of an earlier-phase one. The
non-interactive `LandedMeter` variants (`band` without `selection`, `strip`)
keep their phase-grouped layout and captions: they are unaddressable (§2.6).

### 2.6 Addressable vs unaddressable strips

**R-4**: a strip whose cells carry a position (tick numbers, an
ordinal, arrow-key stepping, selection) MUST use the §2.1 order.

**R-5**: a strip with no position (`MissionProgressBar` densities
`full`, `stacked`, `mini`, and `LandedMeter` without `selection`) MUST NOT
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

**R-6** (gate parity): `ready` vs `blocked`/`queued` MUST be decided by
blockers(T) under `isGateSatisfied`. `buildMissionBoard` reads both the cell's
state and the drawer's count from the shared adjacency's `blockersOf` (each
edge's `satisfied`), so the count and the hatch cannot disagree. Before this
spec the Board decided ready from one rule and the drawer counted another.

**R-7** (cross-mission): an off-strip blocker counts. A task waiting on
another mission's task MUST NOT render `ready` while the claim gate refuses
it (a phantom-ready cell). The mission page loads each off-strip dependency by
id (`loadDependencyRows` over `foreignDependencyIds`, read-only; nothing the
orchestrator stores changes) and passes them to `buildMissionBoard` as
`externalDeps`, so the gate is evaluated for them too.

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
| `ci_failed`, `failed` | `border-status-error` | `fleet-hatch-err` | unchanged |
| `fixing` | per `STATES.fixing` | per `STATES.fixing` | tone is **active**, not error (R-8a): buildd is retrying it |
| `ready` | `border-border-strong` | `bg-card` (empty, no hatch) | **new**: an open slot, nothing holding it |
| `blocked` | `border-[var(--fleet-border-mid)]` | `fleet-hatch` (dense diagonal, 2px/6px) | unchanged texture, now `blocked` only |
| `queued` | `border-[var(--fleet-border-mid)]` | `fleet-hatch-future` (sparse diagonal, 1px/7px) | **new mapping**, existing class |

**R-8**: `ready`, `blocked` and `queued` MUST resolve to three different
class strings, and the three fills MUST differ in texture (none / dense /
sparse), not only in colour.

### 3.2a The true state wins over a backoff

**R-8a**: a re-queued task whose PR has failing checks or a merge conflict,
or that the loop holds for its PR's checks (`tasks.context.loopWebhookWait`)
with `tasks.startAt` in the future, MUST have the display state `fixing`,
never `ready`, `blocked` or `queued`. buildd retries that failure by itself,
so per Navigation d25d923d R-20 it is work in motion: `fixing` is not in the
error bucket (`isErrorState` is `ci_failed` and `failed` only) and carries no
red dot. The PR state comes from the page's one projection
(`deriveFeedPrState` over the worker and the kernel's delivery display, in
`deriveBoardStatus`); no new state store. Its words follow R-14
(`overviewStatus`): `Fixing · CI failed` or `Fixing · Merge conflict`, with
the backoff as `Retry in 3h 52m` (`retryText`) beside `Retry now`
(`RETRY_NOW`), never `Queued · Scheduled start`. Because this is the strip
state, Home and `buildd top` read the same cell.

**R-8a1**: the Overview names the selected task's status on a line under
the strip (`OverviewTaskStatus`): a dot in the status tone, the word and its
one cause, then what that state needs. A pending retry shows
`Retry in 3h 52m` and a `Retry now` button. The button posts
`POST /api/tasks/[id]/start` with `retryNow: true`, which lifts only the
deferred start (it clears `tasks.startAt`), and every other start gate still
applies. A refusal shows its error in place.

**R-8a2**: a task with an executing worker shows its live line beside the
word: `Running 12m 04s`, ticking each second from the worker's start
(`formatElapsed`), then `Updated 14s ago` from its last event
(`lastEventOf`). Once `NO_ACTIVITY_MS` passes with no event (the mission
stall grace, `STALL_GRACE_MS`, 5 min), the line reads `No activity for 12m`
in the warning tone, timed from the start when no event has arrived
(`liveLine`). It shows no spinner.

### 3.2b The mission bar's looks (Navigation d25d923d R-4)

**R-8b**: a grouped strip (the mission bar, `TaskStrip` with `groups`) draws
five looks over the §3.2 states, in web rendering only (`stripLook`,
`data-look`; Navigation d25d923d R-4 r5): `landed` is solid green; an agent
working (`running`, `review`, `landing`, `recovering`, and `fixing` while its
attempt is live) is an accent hatch; a task that needs a person (`needs_you`,
`waiting`) is an outlined amber cell on an amber tint; a failure a person must
fix (`failed`, `ci_failed`) is an outlined red cell; every other state,
including `fixing` while it waits out a retry, is a dashed outline. Every
look is a theme token, so Night and Day both keep 3:1 contrast; a phone cell
is at least 32px tall, and the bar draws no tick numbers: a cell's hover
label and accessible name are the task's name and state. The cell's state,
order and grouping are unchanged, so the §3.2 table still holds for every
other strip and `buildd top` (Runner on your terminal R-29) reads the same
cells.

**R-8c**: the `running` cell's hatch drifts slowly, one stripe period per
2.4s, in CSS only (`.state-cell[data-drift]`, `@keyframes cell-hatch-drift`).
Nothing else on the bar moves. The drift runs under
`prefers-reduced-motion: reduce` too (Navigation R-4): it is a small, slow
background shift and the one cue that a task is live, so no reduced-motion
rule may set its animation to `none`
(`apps/web/tests/acceptance/navigation-one-place.test.ts`). Before this the
running cell was static.

**R-8d**: a closed, unmerged PR whose replacement is known reads
`Closed → #N` (the cell's word, `BoardTask.replacement`), from a close comment
(`Replaced by #N`), a PR body (`replaces #N`) or a person's link
(`POST /api/workers/[id]/replacement`), before the replacement merges. With
none known, the selected task's status line reads `Closed` with a
`Link replacement` action, which takes a PR number and posts it to that
route for the PR's worker (`BoardTask.prWorkerId`). It is display only: the formal supersession still records on merge, and no
completion or merge gate reads it.

### 3.3 Words

The words come from the terms catalog (`packages/shared/src/terms.ts`), which
follows Navigation d25d923d R-14: `ready` → "Queued", `blocked` and `queued`
→ "Waiting on a task" (a surface that knows the task names it:
`Waiting on <task>`), `running` → "Running", `fixing` → "Fixing". The three
textures of R-8 still tell `ready`, `blocked` and `queued` apart.

---

## 4. Ordinal semantics

`04 / 14` is deleted. "N / total" reads as "Nth of a sequence of 14", which is
false whenever two cells are parallel, and the band already shows "9 of 14" as
the landed count.

The task cell's accessible name carries its position and topology:
`Cell {pos} of {n}, level {l} of {L}, {state words}: {title}`.

- **R-9**: omit the level segment for a component with one level. Any cell
  with an on-strip edge belongs to a component of at least two levels.
- **R-10**: the strip renders no drawer header or drawer ordinal. The task
  page's mission bar may show `n / N` as a sibling navigation position; it is
  not a dependency level or an execution sequence.

---

## 5. Dependency-on-selection

### 5.1 Direction is chosen by the selected cell's state

| Selected cell | Marks show | Dependency reason (Flow card) |
|---|---|---|
| `blocked`, `queued` | **upstream**: frontier(T) = direct marks; upstream(T) − frontier(T) = transitive marks | `After 12 {label} (+7 upstream).` |
| any **active** state with a non-empty downstream(T) | **downstream**: non-landed direct dependents = direct marks; rest of downstream(T) = transitive marks | `Unblocks 08, 13 (+3 downstream).` |
| active with empty downstream(T) | none | unchanged |
| `landed` | none | unchanged |

Because of R-1, upstream marks always fall left of the selected cell and
downstream marks always fall right of it, so one mark vocabulary serves both
directions; the side of the screen, and the reason's "After" / "Unblocks",
say which.

**R-11**: marks are derived from the board model and selected task id.
The selection store (`useMissionStrip`) keeps keyboard selection local: the two
changed `StripCell` buttons and the tick row update. A click, Enter or Space
opens that task's page instead of a drawer.

**R-12**: the reason line names at most two cells, frontier-first, as
`{tick} {label}`, and tails the rest as `+N upstream` / `+N downstream`
(CC-3/CC-4 parity with `DependencyRail`). Off-strip blockers are named by
title plus `· other mission` and are always named before on-strip ones.

**R-13**: the "waiting on N dependencies" count in `TaskActionZone`
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

**R-14**: a marked tick is always drawn, even in unnumbered mode where an
unmarked landed tick draws nothing. Mark beats the open-cell dot.

**R-15**: `direct` and `transitive` differ in shape (filled box vs
underline; 6px vs 2px), not only colour.

**R-16**: the selected cell's own tick keeps its number in every mode
(existing behaviour) and is never itself marked.

**R-17**: the cells themselves are not restyled by a mark. The cell says
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
   satisfaction rule (§3.1, R-6).
4. computeStructureLayout (the Structure canvas, since removed) — its own
   blockerMap / dependentsOf and assignRanks.

**R-18**: identifyChains' pass 1 is extracted into one exported pure
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

**R-19**: `identifyChains`, `collapseTerminalChains`,
`buildMissionBoard` (its `deps`, `unblocks` and ready/blocked decision),
the Flow timeline (`buildFlowTimeline`, which reads the board's deps and the
strip order; `mission-flow-timeline.md`) and the strip (§2, §3, §5) all read
that one result. None of them walks `dependsOn` itself afterwards.

**R-20**: frontier(T) is `reduceToFrontier`, exported from
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
counts, R-7), not `ready`. Drawer: "After {Z title} · other mission." The
count reads 1.

**R-21**: a held cell with no on-strip marks MUST name at
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

**R-22**: tasks Kahn never releases are appended after all released
tasks of their component, ordered by readiness, phase, `createdAt`, id, and
given level = maxLevel of the released part + 1. R-1 is waived for edges
between unreleased tasks only.
**R-23**: every task still gets exactly one cell; the helper terminates
in O(N+E).
**R-24**: frontier is non-empty for a held cycle member (TR-3 in `timeline-dependency-geometry.md`), so
selecting it always marks at least one cell.

### 7.10 Width greater than the strip

One root A with 30 dependents B1…B30, all at level 2. All 31 cells render in
one row: n > 24 → `--strip-gap: 1px` (§8). At 360px each cell is ≈ 9.6px.
Ticks are unnumbered (n > 12): open cells carry the existing dot, marks
replace the dot (R-14). Select A: 30 direct bars under the tick row.

### 7.11 64+ cells

The strip renders at most `FLIGHT_STRIP_BAR_CAP` (64) cell buttons.

**R-25**: when n > 64, fold the leftmost K = n − 63 **landed** cells (in
§2.1 order) into one summary cell at position 01: solid success fill, tick
`+K`, `aria-label` "K landed tasks". If fewer than K cells are landed, fold
the rightmost **queued** cells into a trailing summary cell (`+K`, `queued`
texture) for the remainder. Active and blocked cells are never folded —
the gotcha recorded for `computeMissionFlightStrip` (dropping live work at the
cap) MUST NOT recur here.
**R-26**: the summary cell is exempt from R-1. A mark whose target is
folded marks the summary cell's tick instead.
**R-27**: activating a summary cell opens the mission's History tab
(`?layout=feed`); a fold never opens a task page or offers task actions.

---

## 8. 360px behaviour

Content width at 360px is 328px (16px page padding each side).

| n | `--strip-gap` | cell width at 360px | ticks |
|---|---|---|---|
| 1–11 | 4px | ≥ 26.2px | numbered |
| 12 | 4px | 23.7px | numbered |
| 13–24 | 4px | 21.5 → 9.8px | unnumbered + dots + marks |
| 25–64 | 1px | 12.2 → 4.1px | unnumbered + dots + marks |

**R-28** (gap density): `--strip-gap` is 4px for n ≤ 24 and 1px for
n > 24 (6px / 1px at `md`). `stripCaretLeft` already reads the variable, so
the caret and tether stay exact.

**R-29** (tap targets): cells stay `h-11` (44px tall). Width falls under
24px from n = 12 at 360px. The Next open link remains a 44px control and
opens the task page, whose mission sibling controls reach every task.
History also provides task links at row size. These replace the retired
inline drawer's stepper; dense cells are never the only way to open a task.

**R-30** (marks never vanish): a mark is drawn at the full width of its
cell's tick slot, minimum 1px, at every n ≤ 64. At 4.1px a direct mark is a
4×6px block, a transitive mark a 4×2px line.

**R-31** (truncation): no drawer, drawer reason or drawer ordinal is
rendered. Task cells keep their full title, level and state in their accessible
name. Dependency reason text remains available to Flow's selected-task card
through `stripSelectionReason` (R-12).

---

## 9. Next open

**R-32**: the header link targets the next **open** task after the
selection, wrapping in strip order (`openIndices`, `nextOpenIndex`). Held and
failed tasks are skipped when an open task exists. It navigates to that task's
page with mission context, rather than changing an inline drawer.

**R-33**: the header uses `stripCountsLabel`: open tasks, then failed tasks,
then waiting tasks, omitting zero buckets, followed by ›. Folded cells count
the tasks they contain (`stripSlotCounts`), not one cell.

**R-34**: with no open task, the header targets the first failed task, else
the first held task. With no target task it draws no link. It never opens a fold
as though it were a single task.

**R-35**: `defaultStripSelection` prefers the focus task, else the first
active cell, else the first held cell, else the last cell. ArrowLeft/Right,
Home and End move selection by position (`stripKeyTarget`) and focus the
selected cell; Enter/Space opens it. Sibling page navigation belongs to the
task page's mission context bar.

---

## 10. Delete list

| Location | What goes | Replaced by |
|---|---|---|
| `apps/web/src/lib/mission-task-strip.ts` `stripOrder` | `model.phases.flatMap(p => p.taskIds)` | §2.1 sort over the shared adjacency |
| `mission-task-strip.ts` openIndices (deleted) | "open = not in `BOARD_LANDED`" | active-set test (§1) |
| `mission-task-strip.ts` `defaultStripSelection` | "first unfinished" | R-35 |
| `MissionTaskStrip.tsx` `StripDrawer` | the `{tick} / {n}` header | §4 header |
| `MissionTaskStrip.tsx` `StripDrawer` | `t.deps.filter(d => !d.ok).length` (twice) | \|blockers(T)\| from the shared adjacency |
| `MissionTaskStrip.tsx` `stripReason` `blocked` branch | `t.deps.filter(d => !d.ok)` scope list | R-12 frontier sentence |
| `MissionTaskStrip.tsx` `LandedStrip` | `${open.length} open ›` over not-landed | R-33 |
| `MissionBoardParts.tsx` `StripCells` | the "Task {i + 1} of {n}, …" aria-label | §4 aria-label |
| `MissionBoardParts.tsx` `STRIP_CELL_CLASS` | `ready` and `blocked` sharing one class | §3.2 table |
| `mission-board.ts` `buildMissionBoard` | `BoardDep.ok` = landed-or-in-review; `depsLanded` from feedLanded (deleted); the `allById` filter that drops off-strip deps; the `unblocks` push loop | the shared adjacency (R-19, R-6, R-7) |
| structure-layout.ts assignRanks and its local blockerMap build (the file is since removed with the Structure canvas) | private Kahn | moved into the shared helper (R-18) |
| `condensed-timeline.ts` `identifyChains` pass 1 and `collapseTerminalChains` edge loop | two local adjacency builds | the shared helper |
| `MissionProgressBar.tsx` `FullBar`, `StackedBar`, mini branch | three inline copies of `const order = { solid: 0, half: 1, ghost: 2, notch: 3, empty: 4 }` + sort | one exported state-compaction helper, used by all three (R-5 keeps them state-compacted; there must be one copy, not three) |

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
  `ready` (gate parity, R-6).
- **AC-9** (rejection): GIVEN a task whose only unsatisfied dep belongs to
  another mission, WHEN the board is built, THEN its display state is
  `blocked`, never `ready`, and the drawer count reads 1 (R-7).
- **AC-10**: GIVEN the §7.8 fixture with D selected, WHEN the strip renders,
  THEN the tick at position 12 has `data-mark="direct"`, the ticks at 05–11
  have `data-mark="transitive"`, and no other tick has `data-mark`.
- **AC-11**: GIVEN the §7.8 fixture with G selected, WHEN the strip renders,
  THEN ticks 08 and 13 are `direct`, ticks 10, 12 and 14 are `transitive`,
  and no tick left of 06 is marked.
- **AC-12**: GIVEN a landed cell selected, WHEN the strip renders, THEN no
  tick has `data-mark`.
- **AC-13**: GIVEN a selected held task, WHEN dependency marks are derived,
  THEN every on-strip unsatisfied blocker is marked and satisfied dependencies
  are never marked. Transitive marks add context beyond the direct blocker set.
- **AC-14** (rejection): GIVEN any selected cell, WHEN the strip renders,
  THEN no task drawer or drawer ordinal is present; activating the cell opens
  its task page with mission back context.
- **AC-15**: GIVEN the §7.8 fixture with position 01 selected, WHEN the
  header link renders, THEN it targets task 05's page, the next open task;
  keyboard stepping still selects adjacent rendered cells.
- **AC-16**: GIVEN a model where every non-landed task is held behind an
  off-strip blocker, WHEN the header renders, THEN it counts the waiting tasks
  and links to the first held task's page.
- **AC-17**: GIVEN a cycle A↔B plus C→A, WHEN `stripOrder` runs, THEN it
  terminates, returns each of A, B, C exactly once, after every released task
  of the component (R-22, R-23).
- **AC-18**: GIVEN 80 tasks of which 30 are landed, WHEN the strip renders,
  THEN exactly 64 cell buttons exist, the first is a `+17` summary cell, and
  every running, blocked and ready task has its own cell (R-25).
- **AC-19**: GIVEN 30 cells at a 360px viewport, WHEN the strip renders, THEN
  `--strip-gap` resolves to 1px and every marked tick has a rendered width
  ≥ 1px (R-28, R-30).
- **AC-20**: GIVEN the codebase after the change, WHEN `buildMissionBoard`,
  `identifyChains`, `collapseTerminalChains`, `buildFlowTimeline` and
  `stripOrder` are searched, THEN none of them reads `.dependsOn` directly;
  each consumes the shared adjacency helper's result (R-19).
- **AC-21**: GIVEN `MissionProgressBar.tsx` after the change, WHEN searched,
  THEN the literal `{ solid: 0, half: 1, ghost: 2, notch: 3, empty: 4 }`
  appears at most once.
- **AC-23**: GIVEN a pending task whose PR is `ci_failed` or `conflict` and
  whose `startAt` is 3h 52m ahead, WHEN the board is built, THEN its state is
  `fixing`, it reads `Fixing · CI failed` (or `· Merge conflict`), the
  Overview's status line shows `Retry in 3h 52m` and `Retry now`, and it
  carries no waiting cause (R-8a, R-8a1).
- **AC-24**: GIVEN a grouped strip with every state, WHEN it renders, THEN
  each fill's look is merged, running or waiting as R-8b says, only `ci_failed`
  and `failed` carry a red dot and `needs_you` / `waiting` an amber one, only
  the running cell carries `data-drift`, every button keeps its `data-state`,
  and no reduced-motion rule in `globals.css` stops the drift (R-8c).
- **AC-25**: GIVEN a closed, unshipped PR with a named replacement #812, WHEN
  the Overview cells are built, THEN its word is `Closed → #812` (R-8d).
- **AC-26**: GIVEN a closed, unshipped PR with no replacement known, WHEN it
  is selected, THEN the status line reads `Closed` with `Link replacement`,
  and submitting `#812` posts `{ prNumber: 812 }` to
  `/api/workers/<its PR's worker>/replacement` (R-8d).
- **AC-27**: GIVEN a running task started 12m 04s ago whose last event was
  14s ago, WHEN it is selected, THEN the status line reads
  `Running 12m 04s · Updated 14s ago`. With no event for 12m it reads
  `No activity for 12m` in the warning tone (R-8a2).
- **AC-22** (rejection): GIVEN any strip rendered with state-compacted order
  (R-5), WHEN inspected, THEN it carries no tick numbers, no ordinal and no
  selectable cell.

---

## Code surface

- `apps/web/src/app/app/(protected)/missions/[id]/MissionTaskStrip.tsx` —
  `LandedStrip`, `stripReason`
- `apps/web/src/app/app/(protected)/missions/[id]/MissionBoardParts.tsx` —
  `LandedMeter`, `StripCells`, `StripCell`, `STRIP_CELL_CLASS`,
  `STATUS_WORDS`, `MAX_NUMBERED_TICKS`, `stripTone`
- `apps/web/src/app/app/(protected)/missions/[id]/TaskActionZone.tsx` — the
  "waiting on N dependencies" line
- `apps/web/src/app/app/(protected)/missions/[id]/mission-page-query.ts` —
  loads the board input; gains off-strip dependency rows (R-7)
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
- The History tab's timeline row geometry: `timeline-dependency-geometry.md` owns it;
  this spec only shares its adjacency.
- `SegmentStrip` glyphs and `MissionProgressBar` colours — unchanged beyond
  the delete list.
- Any change to `dependsOn`, `missionPhaseIndex` or what the orchestrator
  stores or emits. Ordering is computed at render time from existing fields.
- A cycle label on the strip. Cycles terminate and render (§7.9); naming them
  is the same open item as `timeline-dependency-geometry.md`'s out-of-scope
  CYCLE chip.

## Renumbered

Rule codes became plain criterion ids on 2026-10-15 so they parse and can be
graded. Old to new: ORD-1..3 to R-1..R-3; ADDR-1, ADDR-2 to R-4, R-5;
ST-1..3 to R-6..R-8; ORDN-1, ORDN-2 to R-9, R-10; SEL-1..3 to R-11..R-13;
MK-1..4 to R-14..R-17; ADJ-1..3 to R-18..R-20; XM-1 to R-21; CYC-1..3
to R-22..R-24; CAP-1..3 to R-25..R-27; W-1..4 to R-28..R-31; NX-1..4
to R-32..R-35. AC-1..AC-22 are unchanged. TR-n ids named here belong to
`timeline-dependency-geometry.md`.
