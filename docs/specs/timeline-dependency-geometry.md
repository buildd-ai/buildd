---
title: Timeline Dependency Geometry — DAG Shapes
status: active
owner: builder
last_verified: 2026-08-21
supersedes: []
---

# Timeline Dependency Geometry — DAG Shapes

**Capability statement**: The mission detail Timeline tab MUST render every DAG
shape — linear chain, fan-out, fan-in, diamond, sibling chains, cross-section
blockers, and partially-complete chains — with consistent indentation geometry,
DependencyRail connectors, topological ordering, and information-suppression
rules so the dependency structure is unambiguous without prose annotation.

> **Scope**: `apps/web/src/app/app/(protected)/missions/[id]/CondensedTimeline.tsx`
> and `apps/web/src/lib/condensed-timeline.ts`. Not the Activity page or any
> other surface.

---

## 0. Vocabulary

| Term | Definition |
|------|-----------|
| **chain** | A sequence of tasks where each depends on the previous. May be a sub-path in a larger DAG. |
| **chain head** | The task in a chain with no dependency visible in the current section. |
| **elbow** | The visual connector: left-border (`border-l`) + left-margin (`ml-4`) on a task row wrapper that signals "this row descends from the row above." |
| **compact chip** | `DependencyRail` rendered with `blockerVisible=false`: a `← #N` monospaced reference beside the task row. |
| **cross-section blocker** | A blocker task that lands in a different section (e.g., waitingOnYou) from the blocked task (blocked). |
| **intra-section dependency** | Blocker and blocked both in the same section. |
| **topological order** | Within a section, blockers appear before the tasks that depend on them. |
| **gate-satisfied** | `isGateSatisfied()` returns true: dep.status === 'completed' AND no open (unmerged) PR. |

---

## 1. Section grouping (no change from existing logic)

`groupTimelineTasks()` in `apps/web/src/lib/condensed-timeline.ts` partitions
tasks into six buckets in this priority order (first match wins):

1. **running** — has a live worker (running / starting / idle / waiting_input)
2. **waitingOnYou** — completed + open PR + humanActionPending not false
3. **done** — completed + merged PR or no PR
4. **failed** — status=failed
5. **nextQueued** — pending/assigned + all deps gate-satisfied
6. **blocked** — pending/assigned + at least one dep not gate-satisfied

Section order in the rendered timeline (top to bottom): waitingOnYou → running
→ nextQueued → blocked → done/failed (wave-banded).

This grouping is **fixed**. The geometry rules in §2–§8 layer on top; they never
move a task between sections.

---

## 2. Core geometry rules

### 2.1 Topological sort within a section

BEFORE rendering any section, tasks MUST be ordered so that every task appears
after all of its direct blockers that also appear in the same section.

Algorithm: Kahn's topological sort over the intra-section dependency subgraph.
Ties (tasks with no intra-section ordering constraint) MUST be broken by
`taskCreatedAt` ascending.

**Rule TSO-1**: A task MUST NOT appear before any of its direct blockers when
both are in the same section.

**Rule TSO-2**: Tasks with no intra-section deps are sorted by `taskCreatedAt`
ascending relative to their chain head.

### 2.2 Elbow connector — single adjacent blocker

A task row uses an **elbow** (wrapper `ml-4 border-l border-border-default`)
when ALL of the following hold:

1. The task has exactly **one** direct blocker (`chain.blockedBy.length === 1` after accounting for gate state).
2. That blocker is the **immediately preceding row** in the section's rendered order.
3. That blocker is in the **same section** (intra-section).

In this case `DependencyRail` is rendered with `blockerVisible=true` (renders
nothing — the elbow is the signal).

**Rule ELB-1**: Elbow MUST NOT be applied when the task has more than one direct
blocker. Use compact chip instead.

**Rule ELB-2**: Elbow MUST NOT be applied when the direct blocker is not the
immediately preceding row (e.g., the blocker is present in the section but
something else is rendered between them).

**Rule ELB-3**: Elbow is **flat** — depth does not multiply margin. A chain of
depth 8 renders as 8 consecutive rows each at `ml-4`, not `ml-4`, `ml-8`,
`ml-12`, etc. Chain depth is communicated by the chain-position indicator (§5),
not by nesting.

### 2.3 Compact chip — everything else

When the elbow conditions in §2.2 are not met, `DependencyRail` is rendered
with `blockerVisible=false`. It emits a monospaced `← #N` chip for each direct
blocker with a PR, or `← ${id.slice(0,6)}` for blockers without a PR.

**Rule CC-1**: Multiple blockers are rendered as comma-separated chips on a
single line: `← #12, #47`.

**Rule CC-2**: The compact chip MUST replace the prose `← blocked on {title}`
div currently in `TaskRow`. The prose form is deleted; `DependencyRail` is the
sole dependency signal.

**Rule CC-3**: A task's compact chip references only its **direct** blockers
(`chain.blockedBy`), never transitive blockers. Transitive depth is visible via
the chain-position indicator.

### 2.4 Cross-section blocker — the root-cause decision

**Decision**: when a chain's head is in one section (e.g., waitingOnYou) and its
downstream tasks are in another section (e.g., blocked), the **blocked tasks
stay in their section and use a compact chip pointing up to the head**. The
chain is NOT rendered whole across section boundaries.

**Justification**: Section grouping is the primary navigation signal — each
section answers a different question ("what needs your attention?", "what's
running?", "what's gated?"). Stretching a chain across sections would demote a
`waitingOnYou` task (which demands human action) into the lower-priority blocked
section, causing it to be missed. The compact chip `← #146` gives the reader an
exact pointer to the head without reordering the hierarchy.

**Rule XS-1**: A task in `blocked` whose direct blocker is in `waitingOnYou`
or `running` MUST show a cross-section compact chip, NOT an elbow.

**Rule XS-2**: The `waitingOnYou` task remains in its section; the `blocked`
tasks remain in theirs. No task is moved between sections to complete a visual
chain.

**Rule XS-3**: The cross-section chip carries the PR number (`← #N`) when the
blocker has one, making it directly navigable.

---

## 3. Shape-by-shape specification

### 3.1 Linear chain — A→B→C→D→E→F→G→H (8-deep)

Scenario: #146 (A) is in `waitingOnYou`; B–H are all in `blocked`.

**Row order (top to bottom within blocked)**: B, C, D, E, F, G, H (topological
order; B is shallowest, H is deepest).

**Geometry**:

| Row | Preceding row | Elbow? | DependencyRail form |
|-----|--------------|--------|---------------------|
| B (dep: A) | — (A is in waitingOnYou) | No | Cross-section chip `← #146` |
| C (dep: B) | B (immediately above) | Yes | `blockerVisible=true` (nothing rendered) |
| D (dep: C) | C | Yes | `blockerVisible=true` |
| E (dep: D) | D | Yes | `blockerVisible=true` |
| F (dep: E) | E | Yes | `blockerVisible=true` |
| G (dep: F) | F | Yes | `blockerVisible=true` |
| H (dep: G) | G | Yes | `blockerVisible=true` |

**Indent**: all rows with elbow sit at `ml-4`. Row B sits at `ml-0` (no intra-section parent).

**Chain position indicator**: shown for tasks where `chain.total ≥ 3` AND the
task is in `blocked` or `nextQueued`. B shows `step 1/8`, C shows `step 2/8`,
etc. (see §5).

**Timestamp**: suppressed for all blocked rows (B–H). See §6.

**queued Xm**: MUST NOT appear for any row in this chain. The DependencyRail
chip communicates the wait reason.

### 3.2 Fan-out — A blocks B, C, D simultaneously

Scenario: A is in `waitingOnYou`; B, C, D are in `blocked` with no deps on each other.

**Row order**: B, C, D sorted by `taskCreatedAt` (no intra-section order constraint between them).

**Geometry**: B, C, D all have A as their sole direct blocker. A is in `waitingOnYou`
(cross-section). All three show the cross-section compact chip `← #A_pr`.

No elbow is applied — A is not in the same section. All three rows sit at `ml-0`.

**DependencyRail distinguishes fan-out from unrelated parallel tasks**: unrelated
tasks (no `chain.blockedBy`) render no DependencyRail at all. Fan-out siblings
all share the same chip reference.

**Chain separators**: fan-out siblings are NOT separated by a divider. They
share the same chain head and form a logical unit.

### 3.3 Fan-in / join — B, C both block D

Scenario: A→B, A→C, B→D, C→D (all in `blocked`).

**Row order** (topological): A (or cross-section), B, C, D.

**Geometry of D**:
- D has two direct blockers: B and C.
- The immediately preceding row is C (or B if sorted that way).
- **Rule ELB-1 fires**: D has more than one blocker → NO elbow.
- D shows compact chip `← #B, #C` (multi-blocker form).
- D sits at `ml-0`.

**The chip communicates the join** — two references make the gate visible. The
layout does NOT suggest B→C or C→B (they are peers at the same indent level).

### 3.4 Diamond — A→B, A→C, B→D, C→D

This combines fan-out (§3.2) and fan-in (§3.3).

Scenario: all four in `blocked`.

**Row order** (topological): A, B, C, D.

**Geometry**:

| Row | Preceding row | Elbow? | Form |
|-----|--------------|--------|------|
| A (chain head) | — | No | Cross-section chip or no chip if deps are done |
| B (dep: A) | A (immediately above) | Yes | `blockerVisible=true` |
| C (dep: A) | B | No — B is not a blocker of C | Compact chip `← #A_pr` |
| D (dep: B, C) | C | No — multi-blocker | Compact chip `← #B, #C` |

**Critical**: the layout MUST NOT suggest B→C. C's chip points at A, not B.
B→C or C→B is structurally false and must be invisible in the rendering.

**D's chip**: `← #B_pr, #C_pr` if both have PRs; `← #B_id, #C_id` otherwise.

### 3.5 Multiple sibling chains in one section

Scenario: Chain 1 (A→B→C) and Chain 2 (X→Y) — no cross-chain deps — both in `blocked`.

**Row order**: A, B, C, X, Y (A chain first by `taskCreatedAt` of chain head; or interleaved by created order if chains have no relative constraint).

**Chain boundary detection**: a task is a chain head if it has no direct blockers in the same section (`chain.blockedBy.length === 0` or all its blockers are cross-section). Between consecutive chain heads, render a horizontal rule: `<hr className="border-t border-border-default my-1 opacity-40" />`.

**Rule DIV-1**: A divider MUST appear between the last task of Chain 1 and the
head of Chain 2 when both chains are in the same section and neither is a
dependency of the other.

**Rule DIV-2**: No divider MUST appear within a chain (between directly dependent tasks).

**Rule DIV-3**: No divider for single-task "chains" (tasks with no `dependsOn`
and no dependents). These render as plain rows without chain indicators.

### 3.6 Cross-chain / off-screen blocker (the screenshot failure)

This is the exact case from the failing screenshot: task #146 is in `waitingOnYou`,
its 7 downstream tasks are in `blocked`.

**Root-cause decision** (restated from §2.4): blocked tasks use a compact chip
pointing at the waitingOnYou entry. The chain is NOT reordered across sections.

**Full layout for this case**:

```
┌─ WAITING ON YOU ─────────────────────────────────────────┐
│  ● #146  [REVIEW #146]  ready to merge                    │
└──────────────────────────────────────────────────────────┘

┌─ WAITING ON DEPENDENCIES ────────────────────────────────┐
│  ● B   [BLOCKED] ← #146       step 1/8                   │
│    ● C [BLOCKED]               step 2/8                   │
│    ● D [BLOCKED]               step 3/8                   │
│    ● E [BLOCKED]               step 4/8                   │
│    ● F [BLOCKED]               step 5/8                   │
│    ● G [BLOCKED]               step 6/8                   │
│    ● H [BLOCKED]               step 7/8                   │
└──────────────────────────────────────────────────────────┘
```

Notes:
- B shows cross-section chip `← #146`.
- C–H show elbow (C directly below B, each subsequent row directly below its blocker).
- `step N/8` appears for all rows since `chain.total ≥ 3`.
- No `queued Xm` timestamp on any row.

### 3.7 Partially-complete chain — A→B→C where A is DONE, B is RUNNING, C is QUEUED

Each task lands in its section independently:

- A → `done` (wave-banded, collapsed unless expanded)
- B → `running`
- C → `nextQueued` (all deps gate-satisfied: A is done+merged)

**C is in nextQueued, not blocked.** The `allDepsGateSatisfied` predicate
fires correctly once A's PR merges and B completes.

**Geometry of C in nextQueued**: C has `chain.blockedBy = []` (all gates satisfied).
No DependencyRail is shown. C renders as a plain `nextQueued` row. The chain
position indicator `step 3/3` MAY appear as an informational signal (B is running,
so C is "next in the chain").

**Done tasks in the chain** (A): A is collapsed in the wave-banded done section.
It does NOT appear in the running or nextQueued section. Done tasks are NOT
dimmed inline — they are collapsed by section grouping.

**SegmentStrip on A** (inside the done wave-band): shows solid segment for A,
indicating completed.

**Rule PC-1**: Done tasks MUST NOT appear in the blocked/running/nextQueued
section to avoid visual duplication.

**Rule PC-2**: A queued task whose dependencies are all gate-satisfied MUST land
in `nextQueued`, not `blocked`, regardless of the chain position of other members.

### 3.8 Degenerate cases

**Depth > 8**:
Within a section, if a linear chain has more than 8 tasks, show the first 6
rows in full, then a collapse toggle `▶ +N more in chain` using the existing
accordion pattern (same as `queuedOverflow`). Collapsed rows are not rendered in
DOM. This is a **new prop on the section list**, not a new component: pass
`chainOverflowAt={6}` to the task list renderer.

**Width > 6 in fan-out**:
If a single task blocks more than 6 downstream tasks in the same section, show
the first 5 rows plus a count chip `+N more blocked by #X` as a non-interactive
text line. This mirrors the `queuedOverflow` pattern.

**Cycles**:
If `dependsOn` contains a cycle (A→B→A or longer), the topological sort would
loop. Detection: if Kahn's algorithm exits with unprocessed nodes, a cycle exists.
Render ALL cycle participants with a warning chip `⚠ cycle` in the
`StageChip` (`stage='BLOCKED'` + an `isCycle` prop that replaces the label with
`⚠ CYCLE`). Do NOT loop. Cycle detection runs at O(N+E) over the section's
intra-section dependency subgraph.

---

## 4. DependencyRail geometry details

`DependencyRail` at `apps/web/src/components/DependencyRail.tsx` accepts two props:

```ts
interface DependencyRailProps {
  blockedBy: BlockRef[];
  blockerVisible: boolean;
}
```

**Addition needed (no new component — prop extension only)**:

The existing `blockerVisible` boolean covers two distinct cases that now need
distinguishing:

- `blockerVisible=true` → elbow (blocker is immediately above, same section) → renders nothing
- `blockerVisible=false` + `blockedBy` non-empty → compact chip → renders `← #N` refs

The calling code in `TaskRow` MUST compute `blockerVisible` as:

```ts
const directBlockerIds = new Set(task.chain?.blockedBy.map(b => b.id) ?? []);
const prevTaskId = prevRow?.id ?? null;  // id of the row rendered just above
const blockerVisible =
  directBlockerIds.size === 1 &&          // single-blocker only
  prevTaskId !== null &&
  directBlockerIds.has(prevTaskId);       // that blocker is immediately above
```

`prevRow` is threaded from the `TaskList` mapping function — the index is
available since `tasks.map((task, i) => ...)`.

---

## 5. Chain-position indicator — step N/M

**Rule CPI-1**: `step N/M` MUST appear if and only if ALL of the following:

1. `chain.total ≥ 3` (a two-step chain is trivial; the indicator adds no information)
2. The task is in the `blocked` or `nextQueued` section (running tasks focus on elapsed time; waitingOnYou on the PR)
3. `chain` is non-null

**Rule CPI-2**: The indicator is `step {chain.index}/{chain.total}` in IBM Plex
Mono at 10px, rendered as a `StageChip`-adjacent muted text span, NOT inside
the StageChip itself (to avoid overloading the stage signal).

**Rule CPI-3**: The `step N/M` label MUST NOT appear for `done`, `running`,
`waitingOnYou`, or `failed` tasks.

**Rule CPI-4**: `step N/M` where `chain.total` includes both upstream deps and
downstream dependents: it represents position in the full chain, not just the
local section view.

---

## 6. Timestamp suppression

The `deriveTimestampLabel()` function in `apps/web/src/lib/task-presentation.ts`
returns `queued Xm` for pending tasks. This timestamp anchors to task creation,
which predates the blocking condition — a task blocked for 3 days truthfully
shows `queued 3d` but the signal is misleading.

**Rule TS-1**: For a task in `blocked` where `chain.blockedBy.length > 0`, the
`queued Xm` timestamp label MUST be suppressed (rendered as empty string or
omitted). The DependencyRail chip communicates the wait reason.

**Rule TS-2**: For a task in `nextQueued` (all deps gate-satisfied), show `queued
Xm` normally — it is now truly waiting for a worker, and the queue time is the
relevant signal.

**Rule TS-3**: For a task in `blocked` with NO direct blockers in `chain.blockedBy`
(edge case: deps are all in unknown/external state), show `queued Xm` normally
as a fallback — the blocker is not identifiable.

---

## 7. Suppression table — what the old prose lines become

| Old behaviour | New behaviour | Rule |
|---|---|---|
| `← blocked on {title}` prose div (TaskRow line ~284) | Deleted. Replaced by `DependencyRail blockerVisible={...}`. | CC-2 |
| `queued 3d` timestamp on a chain task in `blocked` | Suppressed. | TS-1 |
| `step 2/3` shown on every task with chain data | Shown only for `chain.total ≥ 3` in blocked/nextQueued. | CPI-1 |
| No ordering within `blocked` | Topological sort by intra-section deps, ties by createdAt. | TSO-1 |
| Cross-section chain rendered as flat unrelated rows | Head in its section; descendants show cross-section chip. | XS-1 |

---

## 8. Failure-mode prevention rules (summary)

Each of the six documented failures maps to a rule:

1. **Grouping severs chain** → Rules XS-1, XS-2, XS-3: blocked tasks stay in
   `blocked`; cross-section chip provides navigation pointer. Section order is
   preserved.

2. **Flat peer rows** → Rule ELB-3 + TSO-1: topological sort places blockers
   before blocked; elbow indent makes adjacency visible. `ml-4` on the wrapper
   div of each intra-section dependent row.

3. **Prose dependency** → Rule CC-2: `← blocked on {title}` div is deleted.
   `DependencyRail` is the sole signal.

4. **Simultaneous timestamps** → Rules TS-1, TS-2: `queued Xm` suppressed on
   blocked chain tasks; only nextQueued tasks show queue time.

5. **`step 2/3` misuse** → Rules CPI-1, CPI-3: shown only in blocked/nextQueued
   when `chain.total ≥ 3`. Never on running/waitingOnYou/done.

6. **Topological sort** → Rule TSO-1: Kahn's algorithm on intra-section
   dependency subgraph; ties by `taskCreatedAt` ascending.

---

## 9. Constraints (enforced)

**Zero new components.** All geometry is expressed as:

- Props changes on `DependencyRail` (existing `blockerVisible` logic extended by calling code)
- A new `prev` index thread in `TaskList`'s `map()` to compute `blockerVisible`
- CSS utility classes (`ml-4 border-l`) on the existing row wrapper
- A chain-boundary divider `<hr>` rendered inline in `TaskList`
- `StageChip`-adjacent muted span for `step N/M`
- Suppression of `queued Xm` in the `taskUpdatedAt` display prop

**Presentation only.** No changes to what the orchestrator stores. No schema
changes. `dependsOn`, `chain`, and all existing task fields are read-only inputs.

**Brutalist language preserved.** All new visual elements use:
- 2px borders where borders appear (`border-2`)
- IBM Plex Mono (`font-mono`) for chip labels and compact references
- Hard-offset shadow pattern (`shadow-[2px_2px_0]`) if any shadow is introduced

---

## Code surface

Primary files implementing this spec:

- `apps/web/src/app/app/(protected)/missions/[id]/CondensedTimeline.tsx` — `TaskRow`, `TaskList`, `TimelineView`
- `apps/web/src/lib/condensed-timeline.ts` — `groupTimelineTasks`, `TimelineGroups`
- `apps/web/src/components/DependencyRail.tsx` — `DependencyRail`
- `apps/web/src/components/StageChip.tsx` — `StageChip`, `deriveStage`
- `apps/web/src/components/SegmentStrip.tsx` — `SegmentStrip`
- `apps/web/src/lib/task-presentation.ts` — `deriveChainPosition`, `ChainPositionResult`, `deriveTimestampLabel`

---

## Acceptance criteria

**AC-1**: GIVEN a linear chain A→B→C→D (all in `blocked`, A blocked by a cross-section `waitingOnYou` task), WHEN the timeline renders, THEN B shows a compact chip `← #N`, and C/D/E each render with `ml-4 border-l` elbow wrapper (no prose `← blocked on` text appears).

**AC-2**: GIVEN the same chain with `chain.total = 4`, WHEN the timeline renders, THEN each of B/C/D shows `step N/4` muted indicator, NOT on the waitingOnYou task at the head.

**AC-3**: GIVEN a fan-in task D blocked by both B and C (`chain.blockedBy.length === 2`), WHEN the timeline renders, THEN D shows NO elbow indent and shows compact chip `← #B_pr, #C_pr` (multi-ref form).

**AC-4**: GIVEN a diamond A→B, A→C, B→D, C→D (all in `blocked`), WHEN the timeline renders, THEN C's chip references A (not B), and D's chip references B and C. The rendering MUST NOT imply any dependency between B and C.

**AC-5**: GIVEN a task in `blocked` with `chain.blockedBy.length > 0`, WHEN the timeline renders, THEN the `queued Xm` timestamp label is absent for that row.

**AC-6**: GIVEN two independent chains in `blocked` (Chain1: A→B→C, Chain2: X→Y), WHEN the timeline renders, THEN a divider `<hr>` appears between C and X, and NOT between any within-chain consecutive rows.

**AC-7**: GIVEN a chain of depth 9 in `blocked`, WHEN the timeline renders, THEN only the first 6 rows are visible and a `▶ +3 more in chain` toggle is rendered.

**AC-8**: GIVEN a cycle A→B→A detected in `dependsOn`, WHEN the timeline renders, THEN both A and B show `⚠ CYCLE` in their stage chip and the topological sort does NOT loop.

**AC-9**: GIVEN a partially-complete chain A→B→C where A is done, B is running, C is nextQueued, WHEN the timeline renders, THEN A appears only in the done (wave-banded) section; C appears in nextQueued with no DependencyRail chip (all gates satisfied).

**AC-10** (rejection): GIVEN any task row in the timeline, WHEN it is in the `blocked` group with a direct blocker, THEN the prose text `← blocked on` MUST NOT appear.

---

## Out of scope

- Activity page / full task history view — separate spec (13551a50)
- Server-side changes to `dependsOn` storage or `chain` computation
- The `done` section internal ordering (wave-banded by completion time — unchanged)
- Mobile swipe actions (`SwipeableRow`) — unaffected
- Bookkeeping footer (§3.6 of timeline) — unaffected
- Summary view (§3.5 of timeline) — unaffected; dependency geometry only applies to Timeline view
