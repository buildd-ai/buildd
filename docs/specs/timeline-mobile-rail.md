---
title: Mobile Timeline Rail
status: draft
owner: builder
last_verified: 2026-09-14
summary: Below the md breakpoint, the mission Timeline MUST render as one continuous vertical rail from chain heads to the goal root, with day boundaries as ticks and history collapsed to chain rows.
domain: surfaces
surfaces: [apps/web/src/app/app/(protected)/missions/[id]/CondensedTimeline.tsx, apps/web/src/lib/condensed-timeline.ts, apps/web/src/components/SegmentStrip.tsx, apps/web/src/components/DependencyRail.tsx]
related: [timeline-dependency-geometry, mission-structure-view, mission-task-lifecycle]
keywords: [rail, git log --graph, day tick, now tick, goal root, chain collapse, pathmanifest edge, retry stub, mobile]
supersedes: []
---

# Mobile Timeline Rail

**Capability statement**: On a viewport narrower than the `md` breakpoint
(768px — the same threshold `mission-structure-view.md` Rule MOB-1 uses to hide
the Structure canvas), the mission detail Timeline MUST render as ONE
continuous vertical rail graph — chain heads at top, the mission's goal root at
bottom — in which day boundaries are ticks on the rail rather than collapsible
sections, and completed work collapses to one row per chain instead of one row
per task.

> **Scope**: the render path in `CondensedTimeline.tsx` and
> `condensed-timeline.ts` **below the `md` breakpoint only**. Desktop rendering
> (≥768px) is unchanged by this spec — see §9.

---

## 0. Decision summary

| # | Topic | Decision |
|---|-------|----------|
| 1 | Companion vs amendment | New companion file (this document). See §0.1 for justification. |
| 2 | Chain identity in history | Extended: `identifyChains()`'s linear-interior test now also runs over terminal tasks' full `dependsOn` edges, not only unresolved ones (§1). |
| 3 | Lanes | One rail, at most 2 lanes. Width > 2 collapses to a fork glyph with count (§2). |
| 4 | Edge classes | Solid = `dependsOn`. Dashed = pathManifest soft ordering, now computable from already-stored `pathManifest` data (§3). Red stub = retry lineage. Contention: off. |
| 5 | Time | Day and `now` boundaries are 22px tick rows, never section headers (§4). |
| 6 | Goal root | Square node from `goalCriteria`, pass count from `GoalCriteriaState` (§5). |
| 7 | Right column | PR number + terminal PR state; confidence only below threshold (§6). |
| 8 | Fill | `deriveStage()` only, including STRANDED (§7). |
| 9 | Section labels | Only "waiting on you" and "running" survive as muted labels (§8). |
| 10 | New components | Zero. Every rail element is a prop/variant on `SegmentStrip`, `DependencyRail`, `StageChip`, or an inline `<div>`/`<hr>` matching the existing inline-divider pattern (§10). |
| 11 | Desktop | Unchanged (§9). |

### 0.1 Companion file vs amendment — justified

This document amends nothing in `timeline-dependency-geometry.md`; it is a
separate file, for the same reason `mission-structure-view.md` is separate from
it rather than a section appended to it: **the two specs govern disjoint
viewport ranges of the same component tree**, and `timeline-dependency-geometry.md`
already carries an explicit scope note restricting itself to the section-first
list rendering that is precisely what this spec replaces below `md`. Folding a
viewport-conditional rewrite into the existing file would force every future
reader of the desktop geometry rules to first determine which rules still
apply on a phone — the same ambiguity `mission-structure-view.md §1` rejected
for the canvas-vs-list boundary. `related` links both directions instead:
`timeline-dependency-geometry.md.related` gains `timeline-mobile-rail`, and
this file cross-references it in every section that narrows or extends one of
its rules.

**What is inherited unchanged from `timeline-dependency-geometry.md`**: the
six-bucket section priority order in §1 of that spec (`groupTimelineTasks` /
`groupChainUnits`), the gate-parity contract (§2.5), transitive reduction of
blockers (§2.6), and the advisory-manifest predicate (§2.7). This spec narrows
how a `ChainUnit` renders once grouped; it does not re-derive grouping.

---

## 1. Chain identity in history (D1)

### 1.1 The gap

`identifyChains()` (`apps/web/src/lib/condensed-timeline.ts:180`) links tasks
into a chain only when the edge between them is **unresolved**
(`isGateSatisfied()` false — see `unresolvedBlockers`/`unresolvedDependents` at
lines 187–204). A terminal task's dependencies are, by definition, resolved.
So a SPEC→BUILD→REVIEW run that has fully landed produces three `standalone`
`ChainUnit`s in the `done` bucket today — each renders as its own flat row.
This is the defect the field observation describes: "the DAG that
DependencyRail draws while work is in flight is erased the moment a chain
merges."

### 1.2 Definition — chain identity for terminal tasks

**Rule D1-1**: A new predicate, `isTerminalLinearInterior(id)`, applies the
SAME structural test `identifyChains()` already uses for
`isLinearInterior(id)` (condensed-timeline.ts:208), but over the **full**
`dependsOn`/dependents adjacency — not the unresolved subset — restricted to
tasks whose `status` is `completed` or `failed`:

```
isTerminalLinearInterior(id) =
  the task has exactly 1 blocker within the terminal task set, AND
  that blocker has exactly 1 dependent within the terminal task set
```

This is a second adjacency pass, gated on terminal status, run alongside the
existing unresolved pass — not a replacement of it. `identifyChains()` keeps
producing `blocked`/`nextQueued`/`running` chain units exactly as today; only
tasks that land in `done`/`failed` additionally get evaluated by this second
test before falling back to `standalone`.

**Rule D1-2**: Chain identity for terminal tasks is `dependsOn` edges only.
`parentTaskId` (retry) lineage is explicitly **excluded** from chain
membership — a retry produces a sibling in Lane 2 (§2), not an ordinal member
of the Lane 1 chain. Folding retries into the ordinal count would make "3 SPEC
BUILD REVIEW" ambiguous with "SPEC, BUILD, BUILD-retry" — two structurally
different shapes that must not share a badge.

**Rule D1-3**: A terminal chain's `tail` order is topological (blocker before
blocked), matching Rule TSO-1 in `timeline-dependency-geometry.md` — this is
the same ordering rule, applied to a different (terminal, not
readiness-sectioned) subgraph.

### 1.3 Default posture — collapsed regardless of length

**Rule D1-4**: A terminal `ChainUnit` with `tail.length ≥ 1` (i.e., 2+ tasks)
renders **collapsed by default**, independent of chain length. This is a new,
separate rule from the `chainOverflowAt={6}` depth-collapse in
`timeline-dependency-geometry.md §3.8` — that rule bounds the WIDTH of an
already-rendered chain in the `blocked` section past a length threshold; this
rule governs the DEFAULT POSTURE of every terminal chain in `done`, because a
chain that has already resolved has no "what's actionable" information to lead
with, so leading with an ordinal badge and a count keeps the section scannable.
A 2-task SPEC→BUILD chain collapses exactly like an 8-task chain; both expand
identically on tap.

**Collapsed label**: `▣{N} {head title, truncated to 32 chars}` +
`#{terminal PR} {merged|closed}` on the right column (§6). `N` is the chain's
total task count (head + tail).

**Expanded**: ordinal sub-rows `1 {typePrefix}`, `2 {typePrefix}`, … each
carrying its own PR number/state and, if present, the retry stub (§3) or
reviewer confidence (§6). `typePrefix` is `stripTaskTypePrefix`'s inverse
input — the task's `taskType` (already a field on `CondensedTimelineTask`),
not a new derivation.

A `standalone` terminal task (no chain partner) renders as a single filled
node with no badge — unchanged from today's single-row case.

---

## 2. Lanes (D2)

### 2.1 Shared derivation — no local re-derivation

**Rule D2-1**: The mobile rail's lane assignment consumes the SAME
`ChainUnit[]` that `groupChainUnits()` produces — the identical value
`StructureView` receives via `computeStructureLayout()`'s `chains` parameter
(`mission-structure-view.md §8.4`). The rail does **not** call
`computeStructureLayout()` itself: that function's Sugiyama rank/barycenter
coordinate assignment solves a multi-column desktop layout problem the rail
does not have (there is exactly one visual column). Calling it and discarding
the `x`/`rank` fields would be a second, wasted adjacency walk. The one thing
genuinely shared across all three consumers (desktop Timeline sections,
Structure canvas, mobile rail) is `identifyChains()`/`ChainUnit` — that is the
ONE adjacency derivation, and this spec names it explicitly to satisfy the
"confirm nothing is re-derived locally" requirement.

### 2.2 Lane assignment

**Lane 1 (mission mainline)**: the chain's `head` and topologically-ordered
`tail` — i.e., a `linear` `ChainUnit`, or a `fan-in`/`standalone` unit's single
row.

**Lane 2 (siblings)**: for a `fan-out` `ChainUnit`, the `tail` array (the
independent dependent siblings) renders as a second, right-indented lane
branching from the head via a fork glyph, and for a `standalone`/`linear` task
with retry lineage (`parentTaskId` pointing at a task already in Lane 1), the
retry renders in Lane 2 as the red stub (§3).

**Rule D2-2**: Width > 2 in Lane 2 (i.e., a fan-out with more than 2 siblings,
or 2+ siblings plus a retry) collapses to a single fork glyph carrying a count
— `├╮ +N` — expandable on tap, mirroring `mission-structure-view.md`'s
`RANK_NODE_CAP` disclosure pattern (`applyRankCap`) but at a width of 2, not 8:
the rail is one column wide on a 360px screen, so the room budget is much
smaller than a desktop canvas rank.

**Rule D2-3**: Lane 2 never nests a third lane. A fan-out sibling that is
itself a fan-out head renders its own siblings as a nested fork on tap-expand,
not as simultaneous additional lanes — this keeps the rail exactly 2 columns
wide at every scroll position.

---

## 3. Edge classes (D3)

Three edge classes render on mobile; contention (the fourth class in
`mission-structure-view.md §4.4`) is explicitly **off**, with no toggle — a
360px rail has no room for a conflict-visualization affordance, and the
underlying `workers.touchedPaths` data source that class depends on has not
landed (`mission-structure-view.md` "M1 observed-touch index status").

### 3.1 Hard dependency — solid rail

**Shape**: solid vertical line segment between vertically adjacent nodes in
the same lane.

**Colour**: `text-status-warning` — the same amber token
`DependencyRail` chips and `mission-structure-view.md §4.1`'s `dependsOn`
edges already use. Reusing the token, not inventing a new one, is what keeps
"this is a hard dependency" meaning the same thing across Timeline, Structure,
and the rail.

**Rule D3-1**: Rendered whenever consecutive rail nodes are linked by a
`dependsOn` edge already known to the chain unit (head→tail, or a fan-in's
join). No new data requirement — this is the same edge the desktop rail
(`DependencyRail`) already draws as a chip; here it draws as a line segment
instead, because the rail's whole premise is that adjacency IS the chip.

### 3.2 Soft ordering — dashed node + dashed rejoin (`after ↑ paths`)

**The reconciliation this spec makes with `mission-structure-view.md §4.3`**:
that spec deferred soft-ordering edges entirely, reasoning "the advisory
deferral is ephemeral (claim-time, not persisted) and therefore cannot be
surfaced as a graph edge without querying live claim state." That reasoning
applies to whether a task **is currently** deferred at claim time — genuinely
ephemeral, genuinely un-renderable without a new query. It does **not** apply
to whether two sibling tasks **would** be advisory-serialized, which is a pure
function of each task's own stored `pathManifest` column:
`isAdvisoryManifest()` and `shouldSerializeByManifest()`
(`packages/core/path-overlap.ts:36,171`) take only `pathManifest: string[]`
arguments and are already dependency-free, pure predicates. A rail node can
show "this task is advisory-ordered behind its lane sibling" using exactly the
same static data the authoring-time auto-`dependsOn` pass reads — no live
claim-loop query, no schema change.

**Rule D3-2**: `CondensedTimelineTask` gains a `pathManifest: string[] | null`
field, selected by the existing mission-detail page query (a `SELECT`-list
addition, not a schema change — the column already exists on `tasks`). This is
the one new field this spec requires.

**Rule D3-3**: For two Lane-2 siblings (or a Lane-1 task and its immediate
Lane-2 fork), if `shouldSerializeByManifest(a.pathManifest, b.pathManifest)`
is true and neither is linked by a stored `dependsOn` edge, the later-created
sibling renders with a dashed node border and a dashed rejoin stroke back into
Lane 1, labelled `after ↑ paths` in the right column (§6). This computation
runs in the same render pass as lane assignment — a pure function over
`ChainUnit.tail`, no new query beyond D3-2's field addition.

**Rule D3-4**: This edge class is advisory only — Rule AS-1 in
`timeline-dependency-geometry.md` still holds: it MUST NOT be styled as a hard
blocker (no `BLOCKED` stage chip, no solid line). The dashed treatment is the
sole signal.

### 3.3 Retry lineage — red stub

**Shape**: a short dashed-red stub branching from Lane 1 into Lane 2,
terminating in `✗`, then rejoining Lane 1 at the point the retry's outcome is
known (merged PR, or still open).

**Colour**: `text-status-error`, distinct from both the amber solid
`dependsOn` line and the grey dashed pathManifest node — matching
`mission-structure-view.md §4.2`'s requirement that retry edges never share a
visual treatment with soft-ordering (there, grey dashed; here, red dashed —
the rail already needed a third colour since amber is taken by hard deps).

**Rule D3-5**: This replaces the `●● N attempts · CI ×M` text row
(`AttemptStrip.tsx`) as the on-rail signal for a `chain.head`/tail task with an
attempt history. `AttemptStrip`'s expand-on-tap detail view
(`attempt.reason`, `attempt.actor`, `attempt.status`, `attempt.prLink`) is
**not** deleted — the stub replaces only the always-visible collapsed summary
line (`strip.dots` + `strip.summary`); tapping the stub still opens the same
expanded detail `AttemptStrip` already renders. No new data derivation: `strip`
already carries everything the stub needs (`attempt.settled`, `attempt.status`).

**Rule D3-6**: `parentTaskId` retry edges are keyed off the same source
`mission-structure-view.md §4.2` uses (`retryLinks: Map<childId, parentId>`)
— not a second lookup.

### 3.4 Greyscale survival

| Class | Colour signal | Greyscale signal |
|---|---|---|
| Hard (`dependsOn`) | amber | solid line |
| Soft (pathManifest) | grey/muted | dashed node border + dashed rejoin |
| Retry | red | dashed stub + `✗` glyph terminator |

No two classes share a greyscale pattern: solid vs. two distinct dash
treatments (bordered node vs. terminated stub) — matching the discipline
`mission-structure-view.md §4` already established for the desktop canvas.

---

## 4. Time is a tick, not a section (D4)

### 4.1 What is deleted / gated

**Rule D4-1**: The following are gated off (not called) on mobile — never
replaced with an equivalent section-header pattern:

- `WaveBandedDone` (`CondensedTimeline.tsx:683–832`) — the entire day-banded
  render path, including its per-band `Collapse` footer button
  (lines 745–753) and the collapsed-band summary row (lines 754–770).
- `deriveBandKey()` (`condensed-timeline.ts:360–394`) — the gap-clustering
  wave-band function that produces the `Today`/`Yesterday`/`Friday (2)`
  labels, including the ordinal-suffix logic (lines 382–389) that is the
  documented source of the duplicate-`Friday`-header bug. This spec does not
  fix that bug — it makes the code path that produces it unreachable on
  mobile, per the task's framing ("makes the bug class impossible").
- `deriveDayBands()` (`condensed-timeline.ts:404–425`) — unused by
  `CondensedTimeline.tsx` today (`grep` shows no call site in that file as of
  this spec's writing) but named here because it is the same gap-clustering
  family and must not be reached for on mobile either if a future call site is
  added.

**Rule D4-2**: `deriveBandKey`/`deriveDayBands`/`WaveBandedDone` are NOT
deleted from the codebase — desktop (§9) still uses `WaveBandedDone` and
`deriveBandKey` unchanged. "Gated off" means the mobile render branch
(§10.1) never calls them; it is a routing decision, not a deletion.

### 4.2 Tick rows

**Rule D4-3**: A day boundary renders as a 22px-tall tick row spanning the
rail's width, containing only a weekday + date label (`Sat 12`) in muted
IBM Plex Mono, with a horizontal rule through the rail line. It carries no
task count, no PR count, no histogram, and no interactive affordance —
`Rule D4-1`'s deleted chrome (count, `Collapse`, mini progress bar) has no
tick-row equivalent; the count information is now on each chain's own
collapsed badge (`▣{N}`, §1.3).

**Rule D4-4**: Ticks are computed by grouping the flattened, topologically-
ordered node list (Lane 1 + Lane 2, in render order) by calendar day of
`completionTs` (done) or `taskCreatedAt` (not yet done) — a simple `Map`
group-by, not `deriveBandKey`'s gap-clustering (no 4-hour-gap merge logic;
a tick is inserted at every calendar-day transition in the rendered node
sequence, full stop). This avoids reintroducing the duplicate-label defect:
there is no per-band ordinal suffix because there is no "band," only day
transitions in a strictly ordered list.

**Rule D4-5**: A `now` tick renders once, dashed, at the boundary between the
last terminal/running node and the first not-yet-started node. Nodes above
the `now` tick (older) render filled per §7; nodes below (future/queued)
render hollow. The `now` tick's label is `now · {weekday date}` — it doubles
as that day's tick when "now" falls within the current calendar day, so no
duplicate `Sat 12` / `now · Sat 12` pair renders for the same day (a day with
in-flight work gets exactly one tick, labelled with `now ·` prefix).

---

## 5. Goal root (D5)

**Rule D5-1**: The rail's terminal (bottom-most) element is a **square** node
— the one deliberate break from the circular node vocabulary (§7), signalling
"this is not a task." It renders only when the mission has
`goalCriteria` set (non-null, non-empty array on `missions.goalCriteria`).

**Rule D5-2**: The pass count (`2 / 3`) is computed as
`criteria.filter(c => c.verdict === 'pass').length / criteria.length` from the
mission's `GoalCriteriaState` (`packages/shared/src/types.ts:1487`+,
`criteria: Array<{verdict: CriterionVerdict, ...}>`). This is a new inline
computation in the mobile-rail render path — not a reuse of
`deriveCriteriaGatePresentation()` (`packages/core/mission-helpers.ts:574`),
which returns a label/tone/detail triple for the existing gate banner, not a
raw pass count. Both read the same `GoalCriteriaState`; they answer different
questions (gate banner: "what should I tell the user right now"; goal root:
"how many of N passed").

**Rule D5-3**: When `goalCriteriaState` is null (never evaluated), the pass
count renders as `?/N` — never `0/N`, which would misreport "all failing"
when the true state is "not yet checked" (the same `NOT_EVALUATED` ≠ `fail`
distinction `GoalCriteriaState`'s own type comment enforces).

**Rule D5-4 (no goal)**: When a mission has no `goalCriteria`, the rail simply
ends after its last node — no root, no placeholder, no "no goal set" message.
An absent gate is not a gap to fill; the existing desktop Summary view already
renders nothing in this case (`CondensedTimeline.tsx:663–669`, the `!criteriaGate`
branch), and the rail matches that precedent rather than inventing new empty-
state copy.

---

## 6. Right column (D6)

**Rule D6-1**: The right column shows, per node: PR number (when present) and
its terminal lifecycle word, reusing the existing `PR_STATUS` record
(`CondensedTimeline.tsx:123–128`: `ci_running`/`ci_failed`/`conflict`/
`pr_open` → label + colour class) plus the `merged`/`closed — not merged`
cases already handled inline in `PrStatusLine` (lines 140–161). **Note on
naming**: the task brief calls these "the `git-*` roles" — no such token or
component exists in the codebase (confirmed by search); the actual code
surface is the `PR_STATUS` record and `PrStatusLine`'s inline terminal-state
branches. This spec cites the real names per `SPEC-FORMAT.md` rule 7 rather
than inventing a `git-*` vocabulary that isn't there.

**Rule D6-2**: Reviewer confidence (`note.title.match(/\(confidence
([\d.]+)\)/)` — the only existing confidence source, in
`ApprovedVerdictChip`, `CondensedTimeline.tsx:213`) renders in the right
column ONLY when confidence < **0.85** or the verdict is not `approve`
(i.e., `reviewer_request_changes` / `reviewer_escalated`, both already
distinct note types). This is a new threshold decision — no
`docs/design/review-gate-ux.md` precedent sets one (checked; that document
does not mention a confidence threshold), so 0.85 is proposed fresh here,
matching the desktop `ApprovedVerdictChip`'s existing collapsed-by-default
posture for approvals (a confident approval is already de-emphasized on
desktop; the rail extends the same judgment to "don't show the number at
all unless it's low"). Rendered in `text-status-warning` (the existing
warning token, not a new colour) when shown.

**Rule D6-3**: Attempts are never rendered as text in the right column — that
is `AttemptStrip`'s old collapsed summary line, replaced by the D3 retry stub.
The right column shows outcome (PR/merge state, low-confidence flag), not
process (how many tries it took).

---

## 7. Fill from `deriveStage()` only (D7)

**Rule D7-1**: Every rail node's fill derives from `deriveStage()`
(`apps/web/src/lib/stage.ts:59`) — no second vocabulary, matching
`mission-structure-view.md` Rule STF-1 verbatim, applied to the rail instead
of a canvas node.

| `Stage` | Rail glyph |
|---|---|
| `QUEUED` | hollow circle |
| `BLOCKED` | hollow circle, amber dashed border (matches D3's advisory dashing only when the reason is pathManifest — a hard `BLOCKED` stage still gets the plain hollow circle; only the edge class is dashed, never the node fill, to avoid double-encoding) |
| `RUNNING` | ring (pulsing border, matching `StageChip`'s existing `pulse` treatment) |
| `WAITING_INPUT` | amber ring |
| `DONE` | filled circle |
| `FAILED` | filled circle, `text-status-error` |
| `CANCELLED` | filled circle, `skipped` glyph treatment (struck box pattern from `SegmentGlyph`, per Rule GP-4 in `timeline-dependency-geometry.md` — cancelled is satisfied but never delivered, and that distinction must survive on the rail too) |
| a `waitingOnYou` node (completed + open PR) | amber ring (same visual as `WAITING_INPUT` — both mean "a human must act"; distinguished by the right-column PR state, not the glyph) |
| STRANDED | dashed-hollow with the `notch` glyph pattern (§7.1) |
| `pathManifest`-gated (D3) | dashed-hollow border, from the edge class, not the stage |

**Rule D7-2 (STRANDED)**: Reuses `isStrandedTask()`
(`apps/web/src/lib/structure-layout.ts:130–143`) verbatim — that function is
already pure (`taskId`, `taskMap` in; `boolean` out) with no Structure-specific
dependency, so the mobile rail imports it directly rather than reimplementing
the terminal-dep-with-no-open-PR predicate a second time. (It is presently not
exported — this spec requires adding `export` to that one function signature,
which is the only production code change this spec's acceptance criteria
require beyond the `pathManifest` field selection in D3-2; everything else is
new render-path code in the build task that implements this spec.)

**Rule D7-3**: The goal root (§5) is exempt from this table — it is not a
task, so it has no `Stage`. Its fill is binary: fully-passed (all criteria
`pass`) renders solid; anything else renders the same hollow-square pattern
regardless of partial progress (a `2/3` root looks identical to a `0/3` root
except for the printed count) — the rail does not attempt a fractional-fill
visualization for the root, matching D5-3's "count is the signal, not a bar."

---

## 8. Readiness sections (D8)

**Rule D8-1**: `waiting on you` and `running` are the only two survivors of
today's six section labels. Both keep the existing `SectionLabel` function
(`CondensedTimeline.tsx:194–200`, already viewport-agnostic — no change
needed) rendered as a small muted label immediately above the rail segment
containing those nodes.

**Rule D8-2**: `nextQueued`, `blocked`, `done`, `failed` — the remaining four
— render as **plain position on the rail**: no label, no `<SectionLabel>`
call, no `GroupSection` (that component is the day-band header being removed
per D4-1 and was never the section-label mechanism to begin with — see
§10.2). Their meaning is now carried entirely by glyph fill (§7) and rail
position (above/below the `now` tick, §4.2) — a hollow node above the goal
root and below `now` reads as queued/blocked without needing a label to say
so.

**Rule D8-3**: The `waiting on you` and `running` labels appear at most once
each per rail (they are not repeated per day-tick) — they mark the TOP of the
rail's live-work region, above the first day tick, matching the field mock's
layout (`waiting on you` / `now · Sun 13` appear once, above all ticked
history).

---

## 9. Desktop — explicitly unchanged

**Decision**: desktop Timeline (`≥ md`, 768px) renders exactly as
`timeline-dependency-geometry.md` already specifies — the six-section list,
`WaveBandedDone` day banding, `AttemptStrip` text summaries, prose-free
`DependencyRail` chips. **No lane-budget widening, no rail.**

**Justification**: `mission-structure-view.md §7` already gives desktop a
dedicated DAG-shape surface (the Structure tab) precisely because "Timeline's
section-grouping SEVERS the visual chain" and a second tab resolves that
without compromising either view's hierarchy. Extending the rail to desktop
would produce two competing full-DAG renderers on the same viewport class —
the Structure canvas (multi-column, Sugiyama-laid-out, selection/highlight)
and a widened rail (single-column, chain-collapsed) — answering the same
"what's the shape" question with two different visual grammars. The rail
exists BECAUSE mobile has no Structure tab (`mission-structure-view.md`
Rule MOB-1 hides it below `md`); once a viewport has Structure available,
introducing a competing graph on Timeline reopens the exact ambiguity §0.1
of this spec argues against. Desktop Timeline keeps optimizing for "what's
actionable now," unchanged.

---

## 10. Constraints — zero new components

### 10.1 Mobile/desktop branching mechanism

**Rule D10-1**: The mobile rail and the existing desktop section list both
render into the DOM simultaneously, gated by CSS utility classes
(`md:hidden` on the rail tree, `hidden md:block` on the existing
`TimelineView` tree) — the SAME technique `mission-structure-view.md` Rule
MOB-1 already established for hiding the Structure tab (`hidden md:flex`).
This is a routing decision inside `TimelineView`/`CondensedTimeline.tsx`, not
a new component: no new file, no client-side viewport detection (which would
risk a hydration mismatch this codebase has no existing pattern for handling).

### 10.2 Every rail element maps to an existing file

| Rail element | Implementation |
|---|---|
| Rail node (circle/ring/square glyphs, §7) | New `shape` prop (`'circle' \| 'square'`) and new glyph states (`ring`, `dashed-hollow`) on `SegmentStrip`'s existing glyph vocabulary (`SegmentGlyph`, `SegmentStrip.tsx:11–20`) — that module already owns the box-glyph state machine (`solid`/`half`/`ghost`/`notch`/`skipped`/`empty`); this is a variant, not a new module. |
| Solid/dashed/retry edge lines (§3) | New prop on `DependencyRail` distinguishing a "line" render mode from its current "chip" render mode — same component, same file, additive prop. |
| Day/`now` tick row (§4.2) | Inline `<div>` in the mobile render branch, directly analogous to the existing inline `<hr className="border-t border-border-default ...">` chain-boundary divider already used in `timeline-dependency-geometry.md` Rule DIV-1 and implemented ad hoc in `TaskList`/`ChainList` — not a component then, not one now. |
| `waiting on you` / `running` labels (§8) | Existing `SectionLabel` function, unchanged. |
| Chain collapse badge (`▣N`, §1.3) | New prop on `StageChip`'s adjacent muted-span pattern (the same `step N/M` slot `timeline-dependency-geometry.md §5` already defines as "StageChip-adjacent muted text span, NOT inside the StageChip itself") — this spec's badge occupies that same slot with different content, on terminal chains instead of blocked ones. |
| Fork glyph (`├╮ +N`, §2.2) | Additive prop on `DependencyRail`'s line-render mode (same file as the edge lines above). |
| PR/confidence right column (§6) | Existing `PrStatusLine` and `ApprovedVerdictChip`, unchanged logic, new threshold constant (D6-2). |

**No new component files.** `GroupSection` is explicitly **not** part of this
design — it is the day-band header component being removed from the mobile
path per D4-1, not a target for extension; naming it in the task brief's
constraint list was a candidate to rule out, and this spec rules it out
explicitly rather than leaving it ambiguous.

### 10.3 `TypeGlyph` does not exist

The required-reading list for this task names
`apps/web/src/components/TypeGlyph.tsx`. A repository-wide search finds no
such file and no `TypeGlyph` identifier anywhere in `apps/web/src` — the
closest existing concept is `SegmentGlyph`, an unexported internal function
inside `SegmentStrip.tsx`. This spec does not extend a `TypeGlyph` component
because none exists to extend; every glyph decision in §10.2 targets
`SegmentStrip`'s actual internal glyph machinery instead. Per `SPEC-FORMAT.md`
rule 7, `TypeGlyph` is written here in plain text, not backticks, because it
names something absent, not a live code surface.

---

## Invariants

- The mobile rail and desktop Timeline render from the identical
  `groupChainUnits()` / `ChainUnit[]` value — no mobile-only re-derivation of
  chain structure.
- A rail node's fill is derived from `deriveStage()` and nothing else (Rule
  D7-1); a rail edge's class is one of hard/soft/retry and never blends two
  classes' visual treatments (§3.4).
- No day-bucketing function (`deriveBandKey`, `deriveDayBands`) is reachable
  from the mobile render branch (Rule D4-1/D4-2).
- The goal root never renders when `goalCriteria` is absent (Rule D5-4).
- Retry lineage never renders as ordinal chain membership (Rule D1-2).

---

## Acceptance criteria

**AC-1**: GIVEN a mission where SPEC(#2270)→BUILD(#2287)→REVIEW(#2295) are all
`completed` and merged, WHEN the Timeline renders at a viewport < 768px, THEN
these three tasks render as ONE collapsed rail row (`▣3 {head title}`) rather
than three separate rows, and tapping it expands to three ordinal sub-rows
labelled `1 SPEC`, `2 BUILD`, `3 REVIEW`.

**AC-2**: GIVEN the same chain but with only 2 tasks (SPEC→BUILD, no REVIEW),
WHEN rendered on mobile, THEN it STILL collapses by default (Rule D1-4) —
collapse posture does not depend on a length threshold in the `done` section.

**AC-3**: GIVEN a task with a `parentTaskId` retry whose original attempt
failed CI, WHEN rendered on mobile, THEN the retry appears as a dashed-red
stub in Lane 2 terminating in `✗` and rejoining Lane 1 — NOT as a text row
reading `●● 2 attempts · CI ×1`, and NOT as an additional ordinal member of
any Lane-1 chain count.

**AC-4**: GIVEN two sibling pending tasks in the same fan-out whose
`pathManifest` values cause `shouldSerializeByManifest()` to return true, and
no `dependsOn` edge exists between them, WHEN rendered on mobile, THEN the
later-created sibling shows a dashed node border with rejoin label
`after ↑ paths` — and this renders without any new server query beyond the
`pathManifest` field selection (Rule D3-2).

**AC-5**: GIVEN a mission whose task set spans "today," "yesterday," and
"last Friday," WHEN the Timeline renders on mobile, THEN NO section header
reading `Today`, `Yesterday`, or `Friday (2)` appears anywhere, and the same
information is conveyed by three 22px tick rows inline on the rail (Rule D4-3).

**AC-6**: GIVEN a mission with `goalCriteria` set (3 criteria, 2 currently
passing) and `goalCriteriaState` populated, WHEN the Timeline renders on
mobile, THEN a square node appears at the bottom of the rail reading `2 / 3`.

**AC-7 (rejection)**: GIVEN a mission with no `goalCriteria` set, WHEN the
Timeline renders on mobile, THEN NO square root node, placeholder, or
"no goal" message appears — the rail simply ends after its last task node
(Rule D5-4).

**AC-8**: GIVEN a viewport ≥ 768px, WHEN the same mission's Timeline renders,
THEN the six-section list, `WaveBandedDone` day banding, and `AttemptStrip`
text summaries render exactly as `timeline-dependency-geometry.md` specifies
— no rail, no ticks, no chain-collapsed history rows (§9).

**AC-9 (rejection)**: GIVEN a reviewer-approved task with confidence 0.94,
WHEN its collapsed rail row renders, THEN the confidence number is absent from
the right column (Rule D6-2 — only sub-0.85 or non-approve verdicts show it).

**AC-10**: GIVEN a fan-out chain head with 4 independent dependent siblings on
mobile, WHEN rendered, THEN Lane 2 shows at most 2 individual sibling rows
plus a fork glyph reading `+2`, not 4 simultaneous Lane-2 rows (Rule D2-2).

---

## Code surface

- `apps/web/src/lib/condensed-timeline.ts` — `identifyChains`, new
  `isTerminalLinearInterior` pass (§1), `groupChainUnits`, `ChainUnit` (all
  reused; new terminal-chain logic is additive)
- `apps/web/src/app/app/(protected)/missions/[id]/CondensedTimeline.tsx` —
  `TimelineView`, `ChainBlock`, `ChainList`, new mobile render branch gated by
  `md:hidden` / `hidden md:block` (§10.1); `WaveBandedDone`, `deriveBandKey`
  unreachable from that branch only (§4)
- `apps/web/src/components/SegmentStrip.tsx` — `SegmentStrip`, `SegmentGlyph`
  — new `shape` prop and glyph states (§10.2)
- `apps/web/src/components/DependencyRail.tsx` — `DependencyRail` — new line-
  render mode alongside the existing chip mode (§3, §10.2)
- `apps/web/src/components/StageChip.tsx` — `StageChip` (fill source only, no
  new prop — reused per Rule D7-1)
- `apps/web/src/lib/stage.ts` — `deriveStage` (sole stage-to-fill path)
- `apps/web/src/lib/structure-layout.ts` — `isStrandedTask` (Rule D7-2 requires
  exporting this existing function; no logic change)
- `packages/core/path-overlap.ts` — `isAdvisoryManifest`,
  `shouldSerializeByManifest` (Rule D3-2/D3-3, reused unchanged)
- `apps/web/src/app/app/(protected)/missions/[id]/AttemptStrip.tsx` — retained
  for expand-on-tap detail (Rule D3-5); its collapsed summary line is what the
  retry stub replaces, not the component itself
- `packages/shared/src/types.ts` — `GoalCriterion`, `GoalCriteriaState` (§5,
  read-only)

---

## Out of scope

- Any change to `timeline-dependency-geometry.md`'s desktop rules — this spec
  amends nothing there; §0.1 explains the companion-file decision.
- Fixing the duplicate-`Friday`-label bug in `deriveBandKey` — out of scope by
  the task brief; this spec makes the code path unreachable on mobile only
  (§4.1), leaving the desktop bug for its own filed task.
- Contention edges on mobile — explicitly off, no toggle (§3, matching
  `mission-structure-view.md`'s M1-gated deferral for the same edge class).
- A `TypeGlyph` component — does not exist; not created by this spec (§10.3).
- Horizontal scrolling, pinch-zoom, or pan gestures on the rail — the rail is
  a normal vertically-scrolling list; no canvas gesture model.
- Swipe actions (`SwipeableRow`) — unaffected, out of scope per
  `timeline-dependency-geometry.md`'s own "Out of scope" list, inherited here.
- Changing what the orchestrator stores or the `dependsOn`/`goalCriteria`
  schema — presentation only, per the task's stated constraint.
