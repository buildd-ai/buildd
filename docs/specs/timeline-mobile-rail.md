---
title: Mobile Timeline Rail
status: draft
owner: builder
last_verified: 2026-09-16
summary: Below the md breakpoint, the mission Timeline MUST render as one continuous vertical rail from chain heads to the goal root, in which every disclosure is in-place and only a row standing for exactly one task navigates.
domain: surfaces
surfaces: [apps/web/src/app/app/(protected)/missions/[id]/CondensedTimeline.tsx, apps/web/src/lib/condensed-timeline.ts, apps/web/src/app/app/(protected)/missions/[id]/TaskPanelWrapper.tsx, apps/web/src/lib/attempt-strip.ts]
related: [timeline-dependency-geometry, mission-structure-view, mission-task-lifecycle]
keywords: [rail, git log --graph, day tick, now tick, goal root, chain collapse, pathmanifest edge, retry stub, attempt ledger, outcome mark, disclosure, touch target, mobile, task sheet, task peek, delegated click, chain badge, criteria evaluator, verification task, bookkeeping footer]
supersedes: []
# Draft assertions — Tier 3 weekly cron (docs/design/spec-conformance.md §Tier 3).
# Checked against the v1 baseline of the Code surface section only — the v2/v3
# rewrite items (RailNode.retries removal, RailRightColumn disclosure rewrite,
# RailNodeRow badge-plus-title toggle) were not individually verified here.
# The mobile branch and rail-attempt-toggle test id already exist in the tree,
# which reads as further along than a `draft` status suggests — worth a closer
# look, not resolved by this draft.
assertions:
  - id: "condensed-timeline-identify-chains"
    type: "symbol"
    name: "identifyChains"
    path: "apps/web/src/lib/condensed-timeline.ts"
  - id: "condensed-timeline-build-rail"
    type: "symbol"
    name: "buildRail"
    path: "apps/web/src/lib/condensed-timeline.ts"
  - id: "build-rail-reachable-from-rail-view"
    type: "symbol_reachable"
    symbol: "buildRail"
    entry: "apps/web/src/app/app/(protected)/missions/[id]/CondensedTimeline.tsx"
  - id: "attempt-strip-attempt-kind"
    type: "symbol"
    name: "attemptKind"
    path: "apps/web/src/lib/attempt-strip.ts"
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
| 3 | Lanes | One rail, at most 2 lanes. Width > 2 collapses to a fork glyph with count (§2). Lane 2 carries fan-out siblings **only** — v2 removed retries from it (§3.3). |
| 4 | Edge classes | Solid = `dependsOn`. Dashed = pathManifest soft ordering, computable from already-stored `pathManifest` data (§3). **v2: retry is no longer an edge class** (§3.3). Contention: off. |
| 5 | Time | Day and `now` boundaries are 22px tick rows, never section headers (§4). |
| 6 | Goal root | Square node from `goalCriteria`, pass count from `GoalCriteriaState` (§5). |
| 7 | Right column | PR number + terminal PR state; confidence only below threshold; **v2: plus an outcome mark that renders only when the outcome is not clean, and a neutral disclosure chevron** (§6, §6.4). |
| 8 | Fill | `deriveStage()` only, including STRANDED (§7). Attempt history never re-tints a node (Rule D7-4). |
| 9 | Section labels | Only "waiting on you" and "running" survive as muted labels (§8). |
| 10 | New components | Zero. Every rail element is a prop/variant on `SegmentStrip`, `DependencyRail`, `StageChip`, `AttemptStrip`, or an inline `<div>`/`<hr>` matching the existing inline-divider pattern (§10). |
| 11 | Desktop | Unchanged (§9). |
| 12 | Reference layouts | Twenty ASCII 360px diagrams, §11.1–§11.21 (§11.3 is superseded and kept as a marker). |
| 13 | What is an attempt | **v2**: an attempt is a re-run of the parent's own deliverable after an adverse outcome on it. The discriminator is the three retry counter columns, not `taskClass`. Companion children — reviewer passes, drift diagnoses, continuations — are not attempts (§12). |
| 14 | Disclosure | **v2**: the right column IS the disclosure control — one button, full row height, ≥44 CSS px wide, never nested inside the row's title link (§13). |
| 15 | Navigation | **v3**: a tap on the rail leaves the page only from a row that stands for **exactly one task**. Every other tap is an in-place disclosure. The delegated task-sheet handler is scoped per row, not per chain unit (§13.3). |
| 16 | Chain disclosure | **v3**: the `▣N` badge and the chain row's title are ONE `<button>` — the chain row has no link at all; the ordinal sub-rows are the navigators (§13.4). Collapsed `▣N`, expanded `▼N`. |
| 17 | Chain right column | **v3**: names the **terminal** member's PR, not the head's — the title and the PR come from two different tasks (Rule D1-5). |
| 18 | Migration | **v2**: AC-3 superseded. **v3**: AC-1 restated as AC-36, §11.1b/§11.12b redrawn, Rule D13-10 amended. **v3.1**: nothing superseded; §14.3 maps every edge case the v2 brief enumerated to its rule, layout and AC. Full tables in §14. |
| 19 | Goal root vs evaluators | **v3.1**: a criteria evaluator is `bookkeeping`, never a rail node, and cannot be attempt-bearing; the root reads stored verdicts only, so an in-flight verification is not distinguishable from an evaluated failure and MUST NOT be made so (§5, Rules D5-5..D5-7). |

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

### 0.2 v2 amendment — the rail was designed for a rate that does not hold

v1 shipped and runs on mobile. Operating it against a live mission produced
three findings. Two are spec gaps, not implementation bugs; the third is a
definitional question v1 never asked.

**Finding 1 — the disclosure never runs.** Rule D3-5 says tapping the retry
stub opens `AttemptStrip`'s expanded detail. The control exists
(`CondensedTimeline.tsx:1106–1117`, `data-testid="rail-retry-stub"`), but its
hit box is a 12px dashed rule plus a 10px `✗` — roughly **24 × 15 CSS px** —
sitting immediately beside a `flex-1` title `<Link>` that spans the rest of the
row. A finger aimed at the glyph lands on the link, navigates to
`/app/tasks/{id}`, and the only way a reader ever sees the expanded section is
to come back to a row whose React state happens to have survived. v1 named the
behaviour and specified no affordance: no hit region, no minimum target, no
collapsed-vs-expanded indication, no reflow rule. §13 supplies all four.

**Finding 2 — the count does not reconcile with its own breakdown.** Every
observed row read `2 attempts · reviewer ×1`. Traced: `attachAttempts`
(`packages/core/mission-helpers.ts:656`) groups on
`taskClass === 'attempt' && parentTaskId`, and the **reviewer pass itself** is
created with exactly that shape (`createReviewerTask`,
`apps/web/src/lib/reviewer.ts:492–537`: `taskClass: 'attempt'`,
`parentTaskId: originalTaskId`, `creationSource: 'webhook'`, and **no** retry
counter column). `deriveTaskOrigin` therefore resolves its mechanism to
`webhook`, v1's kindOf files it under `other`, and `summarise` prints only
ci/reviewer/conflict — so the review pass is counted in the total and named
nowhere. §12 settles the definition; the arithmetic then closes by
construction rather than by printing a fourth bucket. (kindOf is written in
plain text here and in the code surface below, per `SPEC-FORMAT.md` rule 7: the
shipped v2 removed it, so it names something absent.)

**Finding 3 — the stub has no discriminating power.** Nearly every PR takes one
reviewer request-changes round, so the dashed-red `✗` rendered on nearly every
row. A glyph present on ~100% of rows carries no information, and `✗` actively
misreads on a row where the retry succeeded and the PR merged. Meanwhile the
one shape that genuinely needs attention — a PR merged while the reviewer's
finding never landed — rendered identically to a clean merge. §6.4 re-derives
the encoding from the real rate: the healthy path renders **nothing**, and the
ink is spent only where the outcome is not clean.

v1's structure is kept: one continuous rail, chains collapsed, day ticks, goal
root, two lanes, zero new component files, 360px reference width, every edge
class distinguishable in greyscale.

### 0.3 v3 amendment — the whole chain unit is one navigation target

v2 shipped and runs. §13's disclosure works: the right-column control is tappable,
its state is visible, and it does not navigate. v3 is Finding 1 again, one row
type over — and this time the cause is not the affordance's size.

**Finding 4 — the chain row navigates, and the expand is the side effect.** On a
360px device the collapsed chain row `▣3 {head title}` opens the **task sheet for
the head task**. The expansion does happen — it is just invisible until the sheet
is dismissed. v1's AC-1 named the behaviour ("tapping it expands to three ordinal
sub-rows") and, exactly as with the retry stub, specified no affordance; the
implementation supplied one, and something above it ate the tap.

The mechanism is not the badge. The badge is already a `<button>` with
`aria-expanded` and a 44px minimum (`CondensedTimeline.tsx:1194–1203`) — it is a
sibling of the title link and it fires. The mechanism is one attribute two levels
up: `RailNodeRow`'s root element carries `data-task-id={node.head.id}`
(`CondensedTimeline.tsx:1185`), and `TaskPanelWrapper` (`TaskPanelWrapper.tsx:37–52`)
installs a **delegated** click handler that runs `closest('[data-task-id]')` on
every click inside the mission page, calls `preventDefault()`, and opens that
task's sheet. On desktop that attribute scopes exactly one task's row
(`CondensedTimeline.tsx:323–327`). On the rail it wraps the entire unit — the
badge, every ordinal sub-row, every Lane-2 sibling, and the expanded attempt
panel. So:

- the badge toggles expansion **and** the bubbled click opens the head's sheet;
- an ordinal sub-row's own `<Link href="/app/tasks/{member.id}">` is intercepted
  and resolves to the **head's** id — tapping `2 BUILD` opens SPEC;
- so does a Lane-2 sibling, and so does the attempt panel's text.

§13's control survives all of this for exactly one reason: its `onClick` calls
`stopPropagation` (`CondensedTimeline.tsx:1007`), so the delegated handler never
sees it. Nothing else on the rail does — not the `▣N` badge (line 1196), not the
fork glyph (line 1265). That is a contract v2 stated for one control and v3 makes
general (§13.3).

**Finding 5 — the collapsed chain names the wrong PR.** §1.3 already requires the
terminal member's PR in the right column; the shipped row prints the head's,
because `RailTaskLine` (`CondensedTimeline.tsx:1070`) takes a single task that
drives the title, the link, and the PR at once. This was filed as a follow-up
after the v2 verification pass and is folded in here as Rule D1-5 rather than left
loose: it is the same defect as Finding 4 in a different slot — a row that stands
for N tasks resolving every one of its questions to the head.

The rule v3 writes down, which both findings violate:

> **On the rail, a tap never leaves the page unless it lands on a row that stands
> for exactly one task.** Every disclosure — chain expand, attempt detail, fork
> glyph — is an in-place control obeying §13's contract.

v1's structure and v2's disclosure contract are kept entire. v3 adds no glyph, no
derivation and no field; it decides which element owns which tap.

### 0.4 v3.1 amendment — closing the v2 brief's edge-case list

The v2 brief enumerated thirteen edge cases and asked for a layout wherever one
changes the drawing. v2 (#2415) and v3 (#2449) answered twelve of them by rule,
layout and criterion, and §14.3 now says where each one lives so the list can be
checked mechanically rather than re-read. One was never answered: **the goal
root when a criteria evaluator is itself an attempt-bearing task.** It was not
skipped for being hard — the answer is structural, and nothing in v2 or v3 had
written it down:

- every criteria evaluator is `taskClass: 'bookkeeping'`, and the rail renders
  `work` tasks only, so an evaluator is never a rail node;
- every retry column is keyed on a PR number, and an evaluator has
  `outputRequirement: 'none'` and never opens one, so under Rule D12-2 it cannot
  be attempt-bearing at all;
- the root reads the stored `GoalCriteriaState` and nothing else, so an
  evaluator that is running, failed, or re-claimed changes the root only through
  the verdict it eventually writes.

§5 states this as Rules D5-5..D5-7, with the degraded rendering the data forces
(an in-flight verification is not distinguishable from an evaluated failure on
the root), §11.21 draws it, and AC-48..AC-50 reject the two things an
implementer would otherwise be tempted to add — an evaluator node on the rail,
and a `✗` for an evaluator that died. v3.1 adds no glyph, no derivation and no
field.

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

**Rule D1-2** (amended in v2): Chain identity for terminal tasks is
`dependsOn` edges only. `parentTaskId` (retry) lineage is explicitly
**excluded** from chain membership. Folding retries into the ordinal count
would make "3 SPEC BUILD REVIEW" ambiguous with "SPEC, BUILD, BUILD-retry" —
two structurally different shapes that must not share a badge. v1 sent the
retry to Lane 2; **v2 sends it out of the graph entirely**, to the right-column
ledger (§3.3, §6.4). The exclusion from `▣N` is unchanged and still binding.

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
total task count (head + tail) — `RailNode.count`
(`condensed-timeline.ts:471`).

**Expanded**: ordinal sub-rows `1 {typePrefix}`, `2 {typePrefix}`, … each
carrying its own PR number/state and, if present, its outcome mark (§6.4) or
reviewer confidence (§6). The ordinal label is derived by `ordinalLabel`
(`CondensedTimeline.tsx:886`) from the task's own bracketed title prefix, falling
back to the stripped title — the same value `stripTaskTypePrefix` removes, not a
new derivation.

A `standalone` terminal task (no chain partner) renders as a single filled
node with no badge — unchanged from today's single-row case.

**Rule D1-5 (v3 — the right column names the terminal PR, the title names the
head)**: On a collapsed chain row (`count > 1`) the right column's PR number and
lifecycle word come from the **last member of `members` that has a PR** — the
terminal one — while the badge count and the title text come from `head`. These
are two different tasks and the row MUST read them from two different sources.
The rolled-up outcome mark (Rule D7-5) is computed across all members and is
unaffected. Expanded, each ordinal sub-row shows its own member's PR, as it
already does.

This is a v1 gap, not a v2 regression: §14's v2 table lists §1.3 as surviving
unchanged, and §11.12a/§11.1a both already draw `▣3 Ledger slice 2 … #2295
merged` for a SPEC(#2270)→BUILD(#2287)→REVIEW(#2295) chain. The shipped row
printed `#2270` because `RailTaskLine` (`CondensedTimeline.tsx:1070`) took one
task and let it drive the title, the link and the PR together. The fix is to give
the right column its own task source, decoupled from the title task (implemented
as a prTask prop in PR #2447); it is stated here as a rule so the chain row's
"one row, two tasks" nature is written down once rather than rediscovered per
slot.

**Rule D1-6 (v3 — collapsed vs expanded glyph)**: The badge renders `▣{N}` when
collapsed and `▼{N}` when expanded. The distinction is carried by **character
shape** — an outlined square versus a solid down-pointing triangle — and survives
greyscale, per §3.4's discipline. Neither form is `⌃`/`⌄`: those are §6.4's
attempt chevron, a different control on the same row (Rule D13-10), and the two
MUST NOT share a glyph.

**Rule D1-7 (v3 — a chain row is not a link)**: A rail row with `count > 1`
contains **no** navigation target for a task. Its badge and its title are one
disclosure control (§13.4) and its head is reachable as ordinal member 1. See
§13.4 for why the title is part of the control rather than a link to the head.

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

**Lane 2 (siblings)** (amended in v2): for a `fan-out` `ChainUnit`, the `tail`
array (the independent dependent siblings) renders as a second, right-indented
lane branching from the head via a fork glyph. **That is the only thing Lane 2
carries.** v1 also placed retry lineage here; v2 removes it (§3.3).

**Rule D2-2** (amended in v2): Width > 2 in Lane 2 — i.e., a fan-out with more
than 2 siblings — collapses to a single fork glyph carrying a count `├╮ +N`,
expandable on tap, mirroring `mission-structure-view.md`'s `RANK_NODE_CAP`
disclosure pattern (`applyRankCap`) but at a width of 2, not 8: the rail is one
column wide on a 360px screen, so the room budget is much smaller than a
desktop canvas rank.

**Rule D2-4 (v2)**: The Lane-2 budget is the full `laneCap` for siblings. The
reservation v1 required — "a retry stub always gets its slot and the sibling
list gives way", implemented as `room = laneCap - 1` in `buildRail`
(`condensed-timeline.ts:587`) — is **retired**. With retries out of the lane,
a fan-out of 2 siblings can never be truncated to 1 by an unrelated retry, and
the `▣N`/fork/retry three-way interaction v1 §11.3 left undrawn cannot arise.

**Rule D2-3**: Lane 2 never nests a third lane. A fan-out sibling that is
itself a fan-out head renders its own siblings as a nested fork on tap-expand,
not as simultaneous additional lanes — this keeps the rail exactly 2 columns
wide at every scroll position.

---

## 3. Edge classes (D3)

**v2**: **two** edge classes render on mobile — hard and soft. Retry lineage
was v1's third class and is no longer an edge at all (§3.3). Contention (the
fourth class in
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

### 3.3 Retry lineage is not an edge class (v2 — supersedes D3-5/D3-6)

v1 drew retry lineage as a dashed-red Lane-2 stub terminating in `✗`. **v2
deletes that stub.** Three reasons, in order of weight:

**(a) A retry is a property of a node, not a branch between nodes.** An edge on
this rail answers "what had to happen before this could start" — that is what
`dependsOn` and the pathManifest ordering both say. A retry says "this node ran
more than once." Nothing downstream waits on it; nothing upstream produced it.
Rendering it as a branch borrowed the graph's vocabulary to say something the
graph does not mean, and cost a lane slot (Rule D2-4) to do it.

**(b) At the observed rate the glyph is noise.** A review round is the norm, not
the exception, so the stub rendered on nearly every row — and a mark on ~100% of
rows is not a signal. Worse, `✗` reads as failure, so it was *wrong* on the
majority case (a retry that succeeded and merged) and *silent* on the case that
needs a human (a merge whose review feedback never landed). §6.4 inverts this:
the healthy path renders nothing, and `✗` regains its meaning by firing only
when a retry actually failed.

**(c) The lane it occupied was never populated anyway.** `buildRail` fills
`RailNode.retries` from the `retryLinks` map, which the mission page builds
**only over `timelineTasks`** — the `taskClass === 'work'` subset
(`page.tsx:526`, `page.tsx:719–726`). Every retry row is `taskClass = 'attempt'`
(§12), so no retry is ever in that set and `retries` is always empty. The stub
that shipped is driven by the fallback at `CondensedTimeline.tsx:1043–1045`
(`node.head.attempts?.total`), not by the lane model the spec described. v2
retires the dead path rather than repairing it.

**Rule D3-5 (v2, supersedes v1 D3-5)**: The mobile rail MUST NOT render a
Lane-2 retry stub, a retry-classed rail segment, or any `✗` in the rail gutter.
Attempt history renders **only** in the right column, per §6.4.

**Rule D3-6 (v2, supersedes v1 D3-6)**: `RailEdgeKind`'s `'retry'` member and
its `EDGE_STROKE` entry (`DependencyRail.tsx:49–53`) are removed, as are
`RailNode.retries` and `RailOptions.retryLinks` (`condensed-timeline.ts`). The
`retryLinks` map the mission page builds for the rail is removed with them;
`mission-structure-view.md §4.2`'s own retry-edge source is untouched, because
the Structure canvas is a different surface with a different viewport budget.

**Rule D3-7 (v2)**: Red (`text-status-error`) is freed as an *edge* colour and
is not reassigned to one. It remains in the rail's vocabulary only as a **node**
fill for `FAILED`/STRANDED (§7) and as the outcome-mark colour for `✗` and the
exhaustion count (§6.4). No edge on the mobile rail is red.

### 3.4 Greyscale survival

| Class | Colour signal | Greyscale signal |
|---|---|---|
| Hard (`dependsOn`) | amber | solid line |
| Soft (pathManifest) | grey/muted | dashed node border + dashed rejoin |

Two classes, two treatments — solid vs. dashed — matching the discipline
`mission-structure-view.md §4` already established for the desktop canvas. The
greyscale budget the retry class used to consume is spent in the right column
instead, where §6.4's marks are distinguished by *character shape* (`⌃` / `!` /
`✗` / `N/N` / `●○`) and never by colour alone.

---

## 4. Time is a tick, not a section (D4)

### 4.1 What is deleted / gated

**Rule D4-1**: The following are gated off (not called) on mobile — never
replaced with an equivalent section-header pattern:

- `WaveBandedDone` (`CondensedTimeline.tsx:715–864`) — the entire day-banded
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
renders nothing in this case (`CondensedTimeline.tsx:695`, the `!criteriaGate`
branch), and the rail matches that precedent rather than inventing new empty-
state copy.

**Rule D5-5 (v3.1 — an evaluator is never a rail node)**: A criteria evaluator
task — the `command` verifier `dispatchCommandCriterionTask` inserts
(`mission-criteria-verify.ts:257–320`), the prose grader `dispatchProseEvalTask`
inserts (`mission-criteria-prose.ts:358`), and the worker-eval grader
`dispatchWorkerEvalTask` inserts (`mission-criteria-worker-eval.ts:300`) — is
`taskClass: 'bookkeeping'` at every one of those sites, and the mission page's
rail input is `taskClass === 'work'` only (`page.tsx:526`). An evaluator
therefore MUST NOT appear as a node, an ordinal sub-row, or a Lane-2 sibling
anywhere above the goal root, whatever its status. Where it IS visible is
unchanged from desktop: `partitionBookkeeping` (`attempt-strip.ts:268`) sends it
to the footer, and `MobileRail` renders `BookkeepingFooter` **after**
`RailGoalRoot` (`CondensedTimeline.tsx:1366–1367`). The root is the rail's last
node; the footer is not part of the rail.

**Rule D5-6 (v3.1 — an evaluator cannot be attempt-bearing)**: Under Rule D12-2
a row is an attempt only if one of `ciRetryPrNumber`, `reviewerRetryPrNumber` or
`conflictRetryPrNumber` is set, and each of those is a PR number. An evaluator
carries `outputRequirement: 'none'`, is instructed never to open a PR, and opts
out of the mission auto-retry with `context.retryCount: 1`
(`mission-criteria-verify.ts:279,317`). No mechanism that writes a retry column
can fire on it, so `attempts.total` for an evaluator is 0 by construction. The
one child an evaluator CAN acquire is a stalled-worker reclaim (§12.2 site 8),
which Rule D12-6 already classes as a companion. The brief's premise — "a
criteria evaluator that is itself an attempt-bearing task" — is therefore a
shape the data cannot produce, and the rail MUST NOT design for it: no
evaluator attempt strip, no mark, no chevron, on the root or anywhere else.

**Rule D5-7 (v3.1 — the root's degraded rendering)**: The root's only inputs
are `RailGoal.total` and `RailGoal.passed` (`condensed-timeline.ts:488`), built
at `page.tsx:737–745` as `criteria.length` and, when the stored state has at
least one criterion item, the count whose `verdict === 'pass'`. Every non-`pass`
member of `CriterionVerdict` (`packages/shared/src/types.ts:1439` — `fail`,
`UNVERIFIED`, `PENDING`, `NOT_EVALUATED`) counts as not passed. Consequences the
rail MUST accept rather than fix:

- A verification in flight (`PENDING`, evaluator `running`), a verifier that
  finished with no command evidence (`UNVERIFIED`, written by
  `handleCriteriaVerificationOutcome`, `mission-criteria-verify.ts:392–401`), and
  a criterion whose command genuinely failed (`fail`) all render the same root:
  the same hollow square, the same `{passed} / {total}`. The root does not
  distinguish them and MUST NOT grow a spinner, a per-criterion glyph, or an
  evaluator status word to do so — `deriveCriteriaGatePresentation` (Rule D5-2)
  and the desktop gate banner own that reading.
- `?/N` (Rule D5-3) fires only when the stored state carries no criterion items
  at all; a state that has been evaluated once and is now being re-verified keeps
  printing its last count, not `?`.
- Solid fill (Rule D7-3) requires `passed >= total`; a root with one
  `UNVERIFIED` criterion stays hollow even if the evaluator task itself reached
  `completed`. That is correct: `completed` on an evaluator proves nothing about
  the command (`mission-criteria-verify.ts:139–146`), and the root MUST read the
  verdict, never the task status.

---

## 6. Right column (D6)

**Rule D6-1**: The right column shows, per node: PR number (when present) and
its terminal lifecycle word, reusing the existing `PR_STATUS` record
(`CondensedTimeline.tsx:155–160`: `ci_running`/`ci_failed`/`conflict`/
`pr_open` → label + colour class) plus the `merged`/`closed — not merged`
cases already handled inline in `PrStatusLine` (lines 140–161). **Note on
naming**: the task brief calls these "the `git-*` roles" — no such token or
component exists in the codebase (confirmed by search); the actual code
surface is the `PR_STATUS` record and `PrStatusLine`'s inline terminal-state
branches. This spec cites the real names per `SPEC-FORMAT.md` rule 7 rather
than inventing a `git-*` vocabulary that isn't there.

**Rule D6-2**: Reviewer confidence (`note.title.match(/\(confidence
([\d.]+)\)/)` — the only existing confidence source, in
`ApprovedVerdictChip`, `CondensedTimeline.tsx:245`) renders in the right
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

**Rule D6-3** (amended in v2): Attempts are never rendered as **prose** in the
right column. `AttemptStrip`'s collapsed summary line — `2 attempts · reviewer
×1` — MUST NOT appear on the rail, in either the Lane-1 row or Lane 2. The
right column shows **outcome**, not **process**: how many tries it took is a
fact about the run, and it belongs in the disclosure (§13), not on the row.

v1 stated this rule and then contradicted it by drawing a stub for every
retry — a stub is a process signal wearing a glyph. v2 makes D6-3 actually
hold: §6.4's mark encodes *how the row came out*, and is silent when the answer
is "fine."

### 6.4 The outcome mark (v2)

The rail's job at 360px is to let a reader scroll a mission and stop only where
they are needed. That makes the encoding a **rate** problem, not a taxonomy
problem: whatever renders on most rows must be neutral, and whatever alarms must
be rare. v2 splits the attempt signal into three tiers accordingly.

| Tier | What it says | Mark | Expected rate |
|---|---|---|---|
| Presence | "there is history behind this row" | `⌃` / `⌄` chevron, muted | high — every row with attempts |
| Progress | "a re-run is happening now" | `●○` dot ledger, muted | transient |
| Exception | "this did not come out clean" | `!` / `✗` / `N/N` | low |

The chevron is chrome, not alarm — the same posture `▣N` already has on a
collapsed chain (§1.3): it says *more is available*, never *something is wrong*.
That is what lets it sit on nearly every row without decaying into noise, and it
is the affordance Finding 1 says v1 never had.

**Rule D6-4 (v2)**: Every rail row whose task has `attempts.total ≥ 1` (§12's
definition of an attempt) MUST render a disclosure chevron in the right column:
`⌃` collapsed, `⌄` expanded, in `text-text-muted`. A row with
`attempts.total === 0` MUST render no chevron — the no-empty-chrome invariant
`AttemptStrip.tsx:43` already enforces for the desktop strip, applied to the
rail.

**Rule D6-5 (v2)**: The outcome mark is a single derived value per row. It is
computed by a new pure function in `condensed-timeline.ts` (proposed name
railOutcome) returning one of five states, evaluated in this precedence order —
**first match wins**:

| # | State | Predicate (all fields already on `CondensedTimelineTask`) | Mark | Tone |
|---|---|---|---|---|
| 1 | exhausted | newest attempt has `iteration != null && maxIterations != null && iteration >= maxIterations`, and the row's PR is not merged | `{iteration}/{maxIterations}` | `text-status-error` |
| 2 | failed | newest attempt's `status` is `failed` or `cancelled` | `✗` | `text-status-error` |
| 3 | live | any attempt is not `settled` | `attempts.dots` (`●○`) | `text-text-muted` |
| 4 | unlanded | the row's PR merged, AND its review round did not demonstrably land (Rule D6-7) | `!` | `text-status-warning` |
| 5 | clean | everything else | *(nothing)* | — |

**Rule D6-6 (v2 — why exhausted outranks failed)**: `✗` on a row that still has
retry budget means "an attempt died; another is coming." `N/N` means "the loop
is over; you are the next mover." The second is strictly more actionable and
MUST NOT be masked by the first, so exhaustion is evaluated first even when the
final attempt also failed.

**Rule D6-7 (v2 — what "the feedback landed" means)**: A merged row's review
round counts as **landed** unless one of these holds, in which case the row is
`unlanded`:

- the row's latest `reviewerNote` is `reviewer_request_changes` or
  `reviewer_escalated` **and** its `status` is `'open'` — the verdict was never
  made terminal, so nothing ever confirmed the finding was addressed; or
- `reviewerRetryTask` is non-null, its `status` is `'completed'`, and its
  `prNumber` is null — the retry finished without ever attaching to a PR, which
  is the same evidence the desktop row already prints as the presence or absence
  of "— pushed to #N" (`CondensedTimeline.tsx:414–418`).

Both inputs are already selected and threaded: `missionNotes.status` at
`page.tsx:275`, the note map at `page.tsx:284–296`, `reviewerRetryMap` at
`page.tsx:512–523`.

**Rule D6-8 (v2 — the honest limit of D6-7)**: `reviewerRetryMap` is keyed on
`reviewerRetryPrNumber` only, so the push-evidence half of D6-7 can fire for the
`reviewer` mechanism and for nothing else. The rail MUST NOT invent a
ciRetryTask / conflictRetryTask equivalent to close the gap — neither exists,
and neither is created by this spec. For the `ci` and
`conflict` mechanisms the verdict half is the only test, and that is sufficient
rather than merely tolerable: a CI retry that completed without pushing leaves
the PR's `prLifecycleStatus` at `ci_failed`, which the right column already
prints as its own word (Rule D6-1), and a conflict retry that pushed nothing
leaves the PR unmergeable, so the row could not have reached the merged
precondition D6-7 starts from.

**Rule D6-9 (v2 — the one field this requires)**: `AttemptRow` (`attempt-strip.ts:57`)
MUST carry the two numbers the exhaustion state reads: an iteration and a
maximum, copied from the same `context` keys `iterationClause`
(`task-origin.ts:138`) already reads — `iteration`/`maxIterations`, or
`conflictIteration`/`maxConflictIterations` for the `conflict` mechanism. This
is **not a new query and not a schema change**: `tasks.context` is already
selected (`page.tsx:118`) and already passed into `buildAttemptStrips`
(`page.tsx:546`). It is a display type that drops two numbers on the floor.
Parsing them back out of `AttemptRow.reason` (which reads `Reviewer retry #3 of
3 · …`) is forbidden — the no-title-parsing discipline in `task-origin.ts:17–20`
and `packages/core/__tests__/task-class-invariants.test.ts` binds here too.

**Rule D6-10 (v2 — degraded rendering, not an invented field)**: If the D6-9
numbers are absent on an attempt (a retry row whose `context` never carried
them), the `exhausted` state MUST NOT be guessed from any other source. That row
falls through to the next matching state — `failed` when its final attempt
failed, otherwise `clean` — and the exhaustion fact reaches the reader only
through the disclosure, where `AttemptRow.reason` already prints
`Reviewer retry #3 of 3` as text a human reads rather than a machine parses.

**Rule D6-11 (v2 — dormant is not in-flight)**: An attempt with
`status === 'pending'` on a row whose `missionBudgetExhausted` is true renders
its ledger dot **dashed** (`◌`) rather than hollow (`○`) — queued-and-unclaimable
is a different fact from queued-and-about-to-run, and the mission budget wall is
already on every `CondensedTimelineTask`. Every other reason an attempt can sit
unclaimed (no runner with the role, workspace concurrency cap, a future
`startAt` on the attempt row) is **not derivable** on this surface: the attempt
row's own `startAt` is not threaded into `AttemptRow`, and runner availability is
not loaded at all. Those cases render `○` and are indistinguishable from
in-flight. The rail MUST NOT add a field to close this gap — the
`heartbeat-prepass.ts:52–58` "reviewer/retry task queued" wait reason is the
subsystem that owns dormancy, and it reports on the mission, not on a row.

**Rule D6-12 (v2 — render order)**: The right column renders, left to right:
PR number → PR lifecycle word (Rule D6-1) → confidence, when shown
(Rule D6-2) → outcome mark → chevron. The mark sits inboard of the chevron so
the chevron stays in a fixed rightmost position across every row, which is what
makes the disclosure control's hit box (§13) predictable at thumb reach.

**Rule D6-13 (v2 — a row with no PR still gets a mark)**: `RailRightColumn`
currently returns `null` when there is no PR word and no confidence
(`CondensedTimeline.tsx:983`). A retry dispatched before `create_pr` ran leaves
the parent row with attempt history and no PR number; that row MUST still render
its mark and chevron. The early return is therefore conditioned on all four
signals being absent, not two.

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

**Rule D7-4 (v2 — attempts never re-tint a node)**: Attempt history MUST NOT
change a node's glyph state or tone. In particular, a task whose attempts are
exhausted (`#3 of 3` reached with changes still requested) is `completed` with
an open PR, so `deriveStage()` returns the OPEN family and §7 gives it the amber
"waiting on you" ring. **That is correct and MUST NOT be overridden to
`FAILED`.** The task did not fail — it delivered, and the loop that was meant to
close it ran out; a human is now the next mover, which is exactly what the amber
ring means everywhere else on this rail. Re-tinting it red would be a second
stage vocabulary and would break Rule D7-1. The terminal-but-not-failed fact is
carried by the right column's `N/N` mark (Rule D6-5 state 1), where it can sit
beside the PR word that explains what is still open.

The same holds in the other direction: a row whose every attempt succeeded gets
no fill change either. Fill answers "what phase is this in"; the mark answers
"how did it come out." Two questions, two slots.

**Rule D7-5 (v2 — chain rollup)**: A collapsed terminal chain (`▣N`, §1.3)
carries **one** mark: the highest-precedence outcome across `members`, using
D6-5's order (exhausted > failed > live > unlanded > clean). Its chevron is
present when any member has `attempts.total ≥ 1`. Expanding the chain moves each
member's own mark and chevron onto its ordinal sub-row, and the chain row keeps
its rolled-up mark so a reader who scrolls past a half-expanded chain still sees
the worst thing in it. This rule holds identically whether the attempt-bearing
task is the chain head or an interior member — v1 left that open.

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
(`CondensedTimeline.tsx:226–232`, already viewport-agnostic — no change
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
| Solid/dashed edge lines (§3) | New prop on `DependencyRail` distinguishing a "line" render mode from its current "chip" render mode — same component, same file, additive prop. **v2 removes the `'retry'` member of `RailEdgeKind`; the prop itself stays.** |
| Outcome mark + chevron (§6.4) | Text spans inside the existing `RailRightColumn` (`CondensedTimeline.tsx:952`), which becomes the disclosure `<button>` (§13). No new file; the mark is characters, not a glyph component — deliberately, so it is legible at 10px where a 10px `SegmentGlyph` box is not. |
| Attempt disclosure panel (§13) | Existing `AttemptStrip`, plus one new boolean prop (proposed name hideToggle) that suppresses its own internal summary button so the row's control is the single toggle. Nesting two toggles is what produced Finding 1. |
| Day/`now` tick row (§4.2) | Inline `<div>` in the mobile render branch, directly analogous to the existing inline `<hr className="border-t border-border-default ...">` chain-boundary divider already used in `timeline-dependency-geometry.md` Rule DIV-1 and implemented ad hoc in `TaskList`/`ChainList` — not a component then, not one now. |
| `waiting on you` / `running` labels (§8) | Existing `SectionLabel` function, unchanged. |
| Chain collapse badge (`▣N`/`▼N`, §1.3) | New prop on `StageChip`'s adjacent muted-span pattern (the same `step N/M` slot `timeline-dependency-geometry.md §5` already defines as "StageChip-adjacent muted text span, NOT inside the StageChip itself") — this spec's badge occupies that same slot with different content, on terminal chains instead of blocked ones. **v3: the badge and the row's title text become the children of one `<button>` inside `RailTaskLine` — a `lead`/`children` arrangement, not a new component (§13.4).** |
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

## 11. Reference layouts (360px)

These are the layouts an implementer checks a build against — the spatial
proof that the 2-lane rail, fork glyph, tick row, and goal root actually fit
and stay legible at a 360px width, reusing the field observation mock's
visual vocabulary (§ field observation). ASCII cannot encode colour, so each
diagram is followed by a one-line legend naming the colour/dash pairing from
§3.4 and §7 that a real render would carry; the glyph and position are the
part that must match exactly, the annotations are non-normative.

Glyph key used below: `●` done, `◉` running (ring), `○` queued (hollow),
`◯` waiting-on-you (amber ring), `◌` dashed-hollow (pathManifest-gated /
STRANDED), `▣N`/`▼N` collapsed / expanded terminal chain badge (Rule D1-6),
`▢` goal root, `├╮`/`├╯` fork open/close, `─`/`┄┄` day tick / now tick,
`✗` retry-stub terminator.

### 11.1 Linear chain in history (Rule D1-4, AC-1, AC-2)

**(a) Collapsed — default posture, independent of chain length:**

```
360px ─────────────────────────────────────────────
 │
 ─  Sat 12
 ▣3 Ledger slice 2                  #2295 merged  ⌃
 │
 ─  Fri 11
```

Legend (amended in v3): `▣3` is the collapsed badge, and badge + title together
are ONE `<button>` — the disclosure (§13.4). `⌃` in the right column is the
separate §13 attempt control, present here because a member has attempt history.
`#2295` is the **terminal** member's PR, not the head's (Rule D1-5).

**(b) Expanded — badge tapped open (amended in v3):**

```
360px ─────────────────────────────────────────────
 │
 ─  Sat 12
 ▼3 Ledger slice 2                  #2295 merged
 ├─●  1 SPEC                              #2270
 ├─●  2 BUILD                              #2287
 ├─●  3 REVIEW  0.78                       #2295
 │
 ─  Fri 11
```

Legend: `●` fill is `DONE` per §7; the `├─` connector is the solid amber
`dependsOn` rail line (§3.1) turned sideways to letter the ordinal sub-rows;
`0.78` renders on REVIEW because it is below the 0.85 threshold (Rule D6-2) —
contrast with AC-9, where a 0.94 confidence would print nothing. v3 changes two
things from v1's drawing: the badge is `▼3`, and the chain row's attempt chevron
is gone — once the members are visible each owns its own history control
(Rule D13-17). The ordinal titles ARE links; they are the only navigation targets
in this unit (Rule D13-16).

### 11.2 Fan-out with pathManifest sibling (Rule D2-2, D3-2/D3-3, AC-4, AC-10)

**(a) Width 2 — both siblings render, one soft-ordered:**

```
360px ─────────────────────────────────────────────
 ◉  BUILD: slice 3 dedupe index      running 12m
 ├╮
 │ ○  REVIEW: slice 3 dedupe index          queued
 │ ◌  Backfill assertions into tests   after ↑ paths
 ├╯
```

Legend: `├╮`/`├╯` is Lane 2 opening/closing on the fork glyph (§2.2); the
second sibling's `◌` border and `after ↑ paths` label are the dashed
soft-ordering edge (§3.2) — grey/muted, never the amber hard-dependency line,
and never a `BLOCKED` stage chip (Rule D3-4).

**(b) Width 4 — collapses to a fork glyph with count (Rule D2-2, AC-10):**

```
360px ─────────────────────────────────────────────
 ◉  BUILD: slice 3 dedupe index      running 12m
 ├╮ +2
```

Legend: 2 siblings render individually as in (a); the remaining 2 collapse
behind the `+2` count on the same fork glyph, expandable on tap — Lane 2
never exceeds 2 visible rows at once (Rule D2-2).

### 11.3 Retry lineage — SUPERSEDED by §11.6–§11.10

v1 drew the retry as a dashed-red Lane-2 stub:

```
360px ─────────────────────────────────────────────
 ○  BUILD: dedupe index (attempt 2)       running
 ├┄╮
 │ ┆✗  attempt 1                       CI failed
 ├┄╯
 ─  Sat 12
```

**This layout MUST NOT be built.** Rule D3-5 (v2) forbids the stub, the dashed
red edge, and the `✗` in the gutter. §11.6–§11.10 are the layouts that replace
it. The diagram is kept, marked, rather than deleted, so a reader who finds the
shipped v1 render has something to match it against — and because §14's
migration note points here.

### 11.4 Day tick + now tick (Rule D4-3/D4-4/D4-5, AC-5)

```
360px ─────────────────────────────────────────────
 ◯  Approve plan: ledger slice 3               plan
 ┄┄ now · Sun 13
 ◉  BUILD: slice 3 dedupe index      running 12m
 ├╮
 │ ○  REVIEW: slice 3 dedupe index          queued
 ├╯
 ─  Sat 12
 ▣3 Ledger slice 2                  #2295 merged
 ─  Fri 11
 ●  Wire the §4 delta gate           #2289 merged
```

Legend: `┄┄ now · Sun 13` renders once, dashed, and doubles as that day's
tick (no separate `Sat 13`/`now · Sat 13` pair, Rule D4-5); nodes above it
(older) are filled/ringed per §7, nodes below are hollow. `─ Sat 12` and
`─ Fri 11` are plain 22px tick rows — weekday + date only, no count, no
`Collapse` footer (Rule D4-3). No `Today`/`Yesterday`/`Friday (2)` section
header appears anywhere in this render (AC-5).

### 11.5 Goal root (Rule D5-1..D5-4, AC-6, AC-7)

**(a) With `goalCriteria` set — square node, pass count:**

```
360px ─────────────────────────────────────────────
 ─  Fri 11
 ●  Wire the §4 delta gate           #2289 merged
 ▢  Goal: all PRs merged · tests green      2 / 3
```

Legend: `▢` is the one deliberate break from the circular node vocabulary
(Rule D5-1); `2 / 3` is `criteria.filter(pass).length / criteria.length`
(Rule D5-2) — renders `?/N`, never `0/N`, when `goalCriteriaState` is null
(Rule D5-3).

**(b) Rejection — no `goalCriteria` set, rail simply ends (Rule D5-4, AC-7):**

```
360px ─────────────────────────────────────────────
 ─  Fri 11
 ●  Wire the §4 delta gate           #2289 merged
                                          (end of rail)
```

Legend: `(end of rail)` is not rendered chrome — it marks where the last
real node's row is the final thing on screen; no root node, no placeholder,
no "no goal set" message (Rule D5-4).

### 11.6 The two quiet outcomes (Rule D6-4/D6-5, AC-11, AC-12)

The whole point of v2 is that these two rows look the same, because their
outcome is the same. Row 1 merged first time; row 2 merged after a reviewer
round that landed.

```
360px ─────────────────────────────────────────────
 ─  Sat 12
 ●  Wire the §4 delta gate           #2289 merged
 ●  Ledger slice 2 dedupe         #2295 merged  ⌃
 ─  Fri 11
```

Legend: no `✗`, no `●●`, no `2 attempts · reviewer ×1` anywhere. The only
difference between the rows is the `⌃` on the second — the neutral "there is
history here" chevron (Rule D6-4), which is the *presence* tier, not the
*exception* tier. A reader scanning this section correctly concludes that
nothing needs them.

### 11.7 Merged, but the feedback never landed (Rule D6-7, AC-13)

The shape Finding 3 says v1 could not express. The retry task reached
`completed`; the reviewer's `reviewer_request_changes` note is still `status:
'open'`; the PR merged anyway.

```
360px ─────────────────────────────────────────────
 ─  Sat 12
 ●  Ledger slice 2 dedupe   #2295 merged   ! ⌃
 ─  Fri 11
```

Legend: `!` is `text-status-warning`, inboard of the chevron (Rule D6-12).
Greyscale signal is the character itself, not the tone. This is the ONLY mark
on a merged row — `✗` is forbidden here (AC-18), because nothing failed.

### 11.8 A re-run in flight (Rule D6-5 state 3, AC-14)

```
360px ─────────────────────────────────────────────
 ┄┄ now · Sun 13
 ◯  BUILD: slice 3 dedupe index   #2301 open  ●○ ⌃
 ─  Sat 12
```

Legend: `●○` is `attempts.dots` verbatim — one filled dot per settled attempt,
hollow for the live one. Muted, never red: a retry that is still running has
not failed. When the mission is `budget_exhausted` the trailing dot renders `◌`
instead of `○` (Rule D6-11); every other reason it might be parked renders `○`
and is not distinguishable on this surface.

### 11.9 Failed and exhausted (Rule D6-5 states 1–2, D6-6, D7-4, AC-15, AC-16)

**(a) An attempt died; budget remains:**

```
360px ─────────────────────────────────────────────
 ◯  BUILD: slice 3 dedupe  #2301 ci failed  ✗ ⌃
```

**(b) `#3 of 3` reached, changes still requested:**

```
360px ─────────────────────────────────────────────
 ◯  BUILD: slice 3 dedupe    #2301 open   3/3 ⌃
```

Legend: in (b) the node is still the amber `waiting on you` ring, because
`deriveStage()` returns the OPEN family for a completed task with an open PR and
Rule D7-4 forbids overriding it — the task delivered, the loop ran out, and a
human is the next mover. `3/3` in `text-status-error` is what says the loop is
over; `✗` would say "another attempt is coming," which is false here, so
exhaustion outranks failure (Rule D6-6).

### 11.10 Two mechanisms on one parent, disclosed (Rule D6-4, §12, §13, AC-17)

One CI retry and one reviewer retry on the same task — the case v1 could only
render as a single undifferentiated stub. Collapsed it is one chevron; open, it
is the strip.

```
360px ─────────────────────────────────────────────
 ●  BUILD: slice 3 dedupe   #2301 merged      ⌄
   │ ●● 2 attempts · CI ×1 · reviewer ×1
   │ ● CI retry #1 of 3 · PR #2301 check_suite
   │   failed · Builder · completed      #2301
   │ ● Reviewer retry #1 of 3 · PR #2301
   │   reviewer requested changes · Builder ·
   │   completed                         #2301
 ─  Sat 12
```

Legend: `⌄` is the expanded chevron. The panel is `AttemptStrip` with its own
toggle suppressed (§13, Rule D13-9); every line in it is already assembled by
`buildAttemptStrips` today — `strip.summary`, then one `AttemptRow` per attempt
carrying `reason`, `actor`, `status` and `prLink`. The summary line's arithmetic
closes: total 2, CI ×1 + reviewer ×1 = 2, and no unnamed remainder (§12). The
reviewer **pass** that produced the request-changes verdict is NOT in this list
and NOT in the total — it already has its own surface as a verdict chip
(`ApprovedVerdictChip` / the Changes Requested card, `CondensedTimeline.tsx:395–465`).

### 11.11 Disclosure across a day boundary (Rule D13-6/D13-7, AC-19)

```
360px ─────────────────────────────────────────────
 ─  Sat 12
 ●  Ledger slice 2 dedupe   #2295 merged   ! ⌄
   │ ●● 2 attempts · reviewer ×1
   │ ● Reviewer retry #1 of 3 · PR #2295
   │   reviewer requested changes · completed
 ─  Fri 11
 ●  Wire the §4 delta gate           #2289 merged
```

Legend: the panel renders **inside** the expanded node's own element, between
its row and the next rail row. `─ Fri 11` stays where it was: tick positions
come from each node's bucketing timestamp (`RailNode`'s `ts` field) inside
`buildRail`, which is server-derived and cannot be
touched by client expansion state (Rule D13-6). The gutter stroke runs unbroken
past the panel because `RailGutter`'s trailing segment is already `flex-1`
(`CondensedTimeline.tsx:1055`). A `┄┄ now ·` tick below an expanded row behaves
identically — it is a sibling row, not an overlay.

### 11.12 A collapsed chain rolling up a member's outcome (Rule D7-5, AC-20)

The chain's second member took a reviewer round whose feedback did not land.
Collapsed, the chain row wears it; expanded, it moves to the member AND stays
on the chain row.

**(a) Collapsed:**

```
360px ─────────────────────────────────────────────
 ▣3 Ledger slice 2            #2295 merged  ! ⌃
```

**(b) Expanded (amended in v3):**

```
360px ─────────────────────────────────────────────
 ▼3 Ledger slice 2            #2295 merged  !
 ├─●  1 SPEC                              #2270
 ├─●  2 BUILD                  #2287 merged  ! ⌃
 ├─●  3 REVIEW  0.78                       #2295
```

Legend: the `▣3`/`▼3` badge and each row's right column are independent controls
(Rule D13-10) — the badge toggles the ordinal sub-rows, the right column toggles
that row's attempt panel. The chain row's `!` is the rolled-up highest-precedence
outcome across members (Rule D7-5) and stays put, so a reader who never expands
still sees the worst thing in the chain. v3 removes the chain row's own `⌄`: once
member 2 is on screen with its own `⌃`, a second control re-printing the same
panel is duplicate chrome (Rule D13-17). The retry is still not an ordinal member
— the chain is `▣3`, not `▣4` (Rule D1-2).

### 11.13 Rejections — what MUST NOT render (AC-21, AC-22, AC-23)

**(a) Zero attempts — no mark, no chevron, no stub:**

```
360px ─────────────────────────────────────────────
 ●  Wire the §4 delta gate           #2289 merged
```

**(b) A failure with no attempt lineage at all** — every worker died before any
retry was dispatched (a dispatch-time error, a budget wall hit at claim):

```
360px ─────────────────────────────────────────────
 ●  BUILD: slice 4 backfill               failed
```

Legend: the node is the `FAILED` filled circle in `text-status-error` (§7) and
the right column is empty — no PR, no mark, no chevron, because
`attempts.total === 0`. The failure is a *node* fact and the node already says
it. Rendering `✗` in the right column here would double-encode one event in two
slots and would make `✗` mean two different things (Rule D6-5 state 2 is about
an attempt dying, not about the task dying).

**(c) A retry dispatched before `create_pr` ran** — attempt history, no PR
number. The mark and chevron still render (Rule D6-13):

```
360px ─────────────────────────────────────────────
 ◉  BUILD: slice 4 backfill      running   ●○ ⌃
```

### 11.14 Collapsed chain — the terminal PR (Rule D1-5, D1-7, AC-33, AC-34)

```
360px ─────────────────────────────────────────────
 ─  Sat 12
 ▣3 Ledger slice 2                  #2295 merged
 ─  Fri 11
```

The chain is SPEC(#2270) → BUILD(#2287) → REVIEW(#2295), all merged, none with
attempt history.

Legend: the title is the **head's** (`Ledger slice 2`); `#2295 merged` is the
**terminal** member's PR (Rule D1-5). `#2270` appears nowhere on this row. The
badge and the title are one `<button>` running from the gutter to the right
column — a hit region far wider than D13-3's 44px floor — and this row contains
no `<a>` except the right column's `#2295` PR link, which is not a task link
(Rule D1-7, D13-15).

### 11.15 Expanded chain — three ordinals, member 2 carrying a mark (AC-36, AC-37, AC-41)

```
360px ─────────────────────────────────────────────
 ─  Sat 12
 ▼3 Ledger slice 2                #2295 merged  !
 ├─●  1 SPEC                              #2270
 ├─●  2 BUILD                  #2287 merged  ! ⌃
 ├─●  3 REVIEW  0.78                       #2295
 ─  Fri 11
```

Legend: `▣3` → `▼3` is the only collapsed/expanded indication on the badge
(Rule D1-6), and it is `aria-expanded` on the same button. Member 2's right
column carries its OWN mark and its OWN attempt control (§13, Rule D13-17); the
chain row keeps the rolled-up `!` as static text and no longer offers a control
of its own. Each ordinal title is a link to that member's task and carries that
member's `data-task-id` — tapping `2 BUILD` opens BUILD, not SPEC
(Rule D13-13, D13-16).

### 11.16 Two disclosures open on one unit (Rule D13-10, AC-42)

The chain is expanded AND member 2's attempt detail is open. Two controls, two
independent open states, one unit.

```
360px ─────────────────────────────────────────────
 ─  Sat 12
 ▼3 Ledger slice 2                #2295 merged  !
 ├─●  1 SPEC                              #2270
 ├─●  2 BUILD                  #2287 merged  ! ⌄
 │   │ ●● 2 attempts · reviewer ×1
 │   │ ● Reviewer retry #1 of 3 · PR #2287
 │   │   reviewer requested changes · Builder ·
 │   │   completed                      #2287
 ├─●  3 REVIEW  0.78                       #2295
 ─  Fri 11
```

Legend: exactly two elements in this unit carry `aria-expanded="true"` — the
chain badge and member 2's attempt toggle. The attempt panel renders inside
member 2's own sub-row element, between member 2 and member 3, so member 3 moves
down as a block and the ordinal numbering is untouched (Rule D13-7, extended to a
sub-row). The panel's text sits inside no `data-task-id` other than member 2's,
so a stray tap in it can only ever peek member 2 (Rule D13-13). Collapsing the
attempt panel MUST NOT collapse the chain, and collapsing the chain hides member
2's panel with member 2 without clearing member 2's open state (Rule D13-8,
D13-19).

### 11.17 An expanded chain and a day tick (Rule D4-4, D13-6, AC-45)

```
360px ─────────────────────────────────────────────
 ─  Sat 12
 ▼3 Ledger slice 2                #2295 merged  !
 ├─●  1 SPEC                              #2270
 ├─●  2 BUILD                  #2287 merged  ! ⌃
 ├─●  3 REVIEW  0.78                       #2295
 ─  Fri 11
 ●  Wire the §4 delta gate           #2289 merged
```

Legend: SPEC landed Friday and REVIEW landed Saturday, and the unit still sits
under ONE tick. A chain cannot span a tick: the unit buckets on a single
timestamp, `ts: Math.max(...members.map(railTaskTs))`
(`condensed-timeline.ts:587`), and ticks are emitted **between node rows** in
`buildRail`'s row loop (`condensed-timeline.ts:669–687`), never between a node's
own sub-rows. Expansion is client state that never re-enters `buildRail`, so no
tick can move, gain a label, or appear (Rule D13-6). `─ Fri 11` below belongs to
the next node, and it stays there whether the chain is open or shut.

### 11.18 An expanded chain above the `now` tick and the goal root (AC-46)

```
360px ─────────────────────────────────────────────
 ─  Sat 12
 ▼2 Ledger slice 3                  #2301 merged
 ├─●  1 SPEC                              #2298
 ├─●  2 BUILD                              #2301
 ┄┄ now · Sun 13
 ▢  goal 2 / 3
```

Legend: the `now` tick lands at the end of the ordered node list because nothing
is unstarted and nothing is dated today, and a goal root follows
(`condensed-timeline.ts:648–654`). The unit's gutter stroke runs unbroken past
the expanded sub-rows and down into the tick and the root: the node is not
`isLast` while a goal root exists (`CondensedTimeline.tsx:1347`), so `RailGutter`
renders its trailing `flex-1` segment (`CondensedTimeline.tsx:1055`), which
stretches to whatever height the expansion produced. Expanding the last chain on
the rail therefore pushes the tick and the root down as one block and changes
neither. The root prints `goal {passed} / {total}`
(`CondensedTimeline.tsx:1296–1298`); §11.5's longer `Goal: all PRs merged ·
tests green` line is v1's mock text, not the shipped label.

### 11.19 A 2-member chain still collapses (Rule D1-4, AC-2, AC-43)

**(a) Collapsed — the default, independent of length:**

```
360px ─────────────────────────────────────────────
 ▣2 Ledger slice 3                  #2301 merged
```

**(b) Expanded:**

```
360px ─────────────────────────────────────────────
 ▼2 Ledger slice 3                  #2301 merged
 ├─●  1 SPEC                              #2298
 ├─●  2 BUILD                              #2301
```

Legend: nothing about the drawing changes at N=2 — same badge, same button, same
ordinals, same terminal PR (`#2301`, BUILD's, not SPEC's `#2298`). A 2-member
chain is where the collapse is least obviously worth it and where an
implementation is most tempted to special-case; Rule D1-4 has no threshold and
this layout is the proof obligation.

### 11.20 Lane 2 / fork territory — the badge cannot appear there (AC-44)

```
360px ─────────────────────────────────────────────
 ◉  BUILD: slice 3 dedupe index      running 12m
 ├╮ +2
 │ ○  REVIEW: slice 3 dedupe index          queued
 │ ◌  Backfill assertions into tests  after ↑ paths
 ├╯
```

Legend: the width question the task brief raises — "does the badge still fit at
44px next to a fork arm?" — cannot arise, and that is a structural fact rather
than a layout judgement. Lane 2 is populated only for a `fan-out` `ChainUnit`
(`condensed-timeline.ts:561`), and a fan-out unit's `members` is `[head]` alone
(`condensed-timeline.ts:554`), so its `count` is 1 and Rule D1-4's badge does not
render. `count > 1` and a non-empty Lane 2 are mutually exclusive by
construction. The controls that DO coexist here — the `├╮ +N` fork button and
each sibling row's own §13 control — are subject to §13.3 and §13.4 in full: the
fork button discloses in place, stops propagation, and never opens a sheet
(Rule D13-14, AC-47).

### 11.21 The goal root while a criterion is being verified (Rule D5-5..D5-7, AC-48, AC-49, AC-50)

**(a) One criterion is being re-verified; its evaluator task is `running`:**

```
360px ─────────────────────────────────────────────
 ─  Fri 11
 ●  Wire the §4 delta gate           #2289 merged
 ▢  goal 1 / 3
 ──────── ▶ 2 orchestrator runs · last 4m ────────
```

Legend: the `Verify goal criterion:` task is running right now and appears
nowhere above the root — it is `bookkeeping`, not `work` (Rule D5-5). The root
prints the **stored** count: criterion 1 passed on the last evaluation,
criterion 2 is `PENDING` behind the running verifier, criterion 3 is `fail`;
`PENDING` and `fail` are both "not passed", so `1 / 3` (Rule D5-7). The
`▶ 2 orchestrator runs` line is the existing `BookkeepingFooter`
(`CondensedTimeline.tsx:573`), drawn below the root because it is not part of
the rail; the evaluator is reachable there and only there.

**(b) Rejection — the verifier died and was re-claimed; nothing on the rail
changes:**

```
360px ─────────────────────────────────────────────
 ─  Fri 11
 ●  Wire the §4 delta gate           #2289 merged
 ▢  goal 1 / 3
 ──────── ▶ 3 orchestrator runs · last 1m ────────
```

Legend: the first evaluator `failed` before its command ran and the
stalled-worker reclaim cloned it (§12.2 site 8). The clone carries no retry
column, so it is a companion, not an attempt (Rule D12-6); the evaluator has
`attempts.total === 0` (Rule D5-6). No `✗` renders anywhere — not on the root,
not in the footer line, not on any node — and the root's count is unchanged
because `handleCriteriaVerificationOutcome` left the criterion `UNVERIFIED`
rather than `fail` (`mission-criteria-verify.ts:402–413`). The only visible
change is the footer's run count, which is desktop-inherited chrome, not a rail
signal.

---

## 12. What is an attempt (v2)

### 12.1 The definition

**Rule D12-1**: An **attempt** is a re-run of its parent task's own deliverable,
dispatched because that deliverable met an adverse outcome. A child row that
does a *different job* — reviews the parent, diagnoses it, continues it after a
human answered a question — is a **companion**, not an attempt, and MUST NOT be
counted, dotted, or marked as one.

The rail needs this because Finding 2 is not a printing bug. `2 attempts ·
reviewer ×1` is not "a missing `other ×1` clause"; it is the row asserting that
something was re-tried twice when it was re-tried once. Adding a fourth clause
would make the sentence longer and still wrong. Removing the companion makes it
right.

**Rule D12-2 (the discriminator)**: The stored discriminator is the **three
retry counter columns**, not `taskClass`:

```
attemptKind(task) =
  task.ciRetryPrNumber       != null && context.driftDiagnosis !== true  → 'ci'
  task.reviewerRetryPrNumber != null                                     → 'reviewer'
  task.conflictRetryPrNumber != null                                     → 'conflict'
  otherwise                                                              → not an attempt
```

This is the same precedence, over the same columns, that `retryKind`
(`task-origin.ts:157–196`) already applies — v2 adds only the
`context.driftDiagnosis` carve-out (D12-4) and makes "no column" mean *not an
attempt* instead of `other`.

`taskClass = 'attempt'` is **not** the discriminator, and the codebase already
says so: `heartbeat-prepass.ts:52–55` documents the column as meaning
"collapses under its parent," and both a reviewer pass and a retry collapse
under their parent. Nesting and attempt-hood are different questions that
happened to share a column.

**Rule D12-3 (the arithmetic closes by construction)**: With D12-2 in force,
`total === kindCounts.ci + kindCounts.reviewer + kindCounts.conflict` for every
strip, because every counted row has exactly one of the three columns set. The
`'other'` member of `ATTEMPT_KINDS` (`attempt-strip.ts:27`) becomes unreachable
and MUST be removed from the tuple, so the invariant is enforced by the type
rather than by a comment. `summarise`'s hardcoded
`['ci', 'reviewer', 'conflict']` filter (`attempt-strip.ts:140`) then covers the
whole vocabulary and stops being a silent truncation.

**Rule D12-4 (diagnose-only is not an attempt)**: `buildDriftDiagnoseTask`
(`ci-drift-diagnose.ts:61`) is inserted with `ciRetryPrNumber` set
(`webhook/route.ts:1551`, `retry-ci/route.ts:157`) but is explicitly not a
re-run: its own description forbids generating a migration, touching the
database, or opening a PR, and it carries `outputRequirement:
'artifact_required'`. Counting it as `CI ×1` claims the build was retried when
it was only examined. It is excluded by `context.driftDiagnosis === true`, the
marker its builder already writes (`ci-drift-diagnose.ts:102`).

**Rule D12-5 (`attachAttempts` is not narrowed)**: The filter lives in
`buildAttemptStrips` (`attempt-strip.ts:152`), applied to `attachAttempts`'
output — NOT inside `attachAttempts` itself. `attachAttempts`
(`mission-helpers.ts:656`) is the canonical *nesting* map and has two other
consumers that need the companion rows to keep nesting under their parent:
`explain.ts:190` (whose `history` provenance string names the grouper
explicitly, `explain.ts:367`) and the strip. Narrowing the shared grouper to fix
one display would silently change what "history" means in `explain`. Attempt-hood
is a display question; nesting is a structural one.

### 12.2 Every `taskClass = 'attempt'` creation site, and what D12-2 makes of it

Verified by search over `apps/` and `packages/` at the time of writing. Every
row below sets `taskClass: 'attempt'` and a `parentTaskId`, so every one of them
reaches `attachAttempts`.

| # | Site | Retry column set | v1 kind | v2 verdict |
|---|---|---|---|---|
| 1 | `createReviewerTask`, `reviewer.ts:492–537` — the reviewer **pass** | none (`creationSource: 'webhook'`) | `other`, counted, unnamed | **companion** — not an attempt |
| 2 | `buildCIRetryTask`, `ci-retry.ts:71`, inserted `webhook/route.ts:1697`, `retry-ci/route.ts:231` | `ciRetryPrNumber` | `ci` | **attempt** — `ci` |
| 3 | `buildDriftDiagnoseTask`, `ci-drift-diagnose.ts:61`, inserted `webhook/route.ts:1551`, `retry-ci/route.ts:157` | `ciRetryPrNumber` | `ci` | **companion** — excluded by D12-4 |
| 4 | reviewer request-changes retry, `workers/[id]/route.ts:3919–3953` | `reviewerRetryPrNumber` | `reviewer` | **attempt** — `reviewer` |
| 5 | Apply-recommendation, `prs/[prNumber]/apply-recommendation/route.ts:155–185` | `reviewerRetryPrNumber` | `reviewer` | **attempt** — `reviewer` |
| 6 | `buildConflictRetryTask`, `conflict-retry.ts:175`, inserted `conflict-retry.ts:484` | `conflictRetryPrNumber` | `conflict` | **attempt** — `conflict` |
| 7 | Dead-zone sweep conflict retry, `dead-zone-sweep.ts:390` | `conflictRetryPrNumber` | `conflict` | **attempt** — `conflict` |
| 8 | Stalled-worker reclaim, `stale-workers.ts:910–929` — copies `taskClass` and `parentTaskId` from the original | none copied | `other` | **companion** — see D12-6 |
| 9 | Human-answer continuation, `workers/[id]/respond/route.ts:175–192` — copies `taskClass` | none | `other` | **companion** — not an adverse outcome |

**Rule D12-6 (the one known undercount, stated rather than papered over)**: Site
8 is a genuine re-run — a stalled attempt reclaimed — but it copies neither the
retry columns nor `creationSource`, so on the rendered row it is
indistinguishable from site 9's continuation. D12-2 classifies both as
companions, which undercounts the reclaim. The rail MUST NOT guess its way out
of this by matching titles or timestamps. The fix belongs at the write site
(carrying the parent's retry column forward on reclaim), not in the renderer; it
is out of scope here and named so that a reader who sees `2 attempts` on a row
with three visible runs knows which of the three is missing and why.

**Rule D12-7 (site 9 usually never arises)**: `workers/[id]/respond/route.ts:186`
copies the parent's `taskClass`, so a continuation of a normal `work` task is
`work` with a `parentTaskId` — already outside `attachAttempts`, which requires
`taskClass === 'attempt'`. The site only produces an attempt-classed row when
the task that asked the question was itself an attempt-classed row, in which
case the continuation nests under *that* row, not under the deliverable. Either
way D12-2 reaches the right answer; this rule records why, so a later reader
does not "fix" it.

---

## 13. Disclosure and interaction (v2)

Finding 1 is not that v1 chose the wrong affordance. It is that v1 specified
**no** affordance: "tapping the stub still opens the same expanded detail" names
an outcome and leaves every property that decides whether a finger can reach it
unstated. This section states them.

### 13.1 The control

**Rule D13-1**: The disclosure control is exactly **one** `<button>` per row,
and it IS the right column: the outcome mark (when any) and the chevron are its
only children. There is no separate stub, glyph, or hotspot.

**Rule D13-2**: The control MUST be a **sibling** of the row's title `<Link>`,
never a descendant of it, and MUST call `stopPropagation` on its click. v1's
stub already satisfied the first half and still lost its taps, because of D13-3.

**Rule D13-3 (hit region)**: The control's hit box MUST be at least **44 CSS px
wide** and MUST span the **full height of its row**, with the row carrying a
`min-height` of 24 CSS px when a control is present. That meets WCAG 2.2
§2.5.8 (24 × 24 minimum) at the rail's 10–12px text density without changing the
rhythm of rows that have no control. The measured v1 stub was about 24 × 15 —
under the minimum on one axis and roughly a fifth of the area a thumb aims at —
sitting beside a `flex-1` link that filled the rest of the row. Width comes from
padding on the button, not from a wider column: the mark and chevron together
are 3–5 characters at 10px.

**Rule D13-4 (no overlapping targets)**: No other interactive element's box may
intersect the control's. The title `<Link>` stays `flex-1` and the control stays
`shrink-0` with its own horizontal padding, so the boundary between them is a
real gap rather than a shared pixel column. The PR-number `<a>` inside the right
column (`CondensedTimeline.tsx:991–1001`) is a third target in the same region:
it keeps its own `stopPropagation`, and it MUST NOT be nested inside the
disclosure button — a link inside a button is not a valid target and taps
resolve unpredictably.

### 13.2 State and indication

**Rule D13-5**: Collapsed renders `⌃`; expanded renders `⌄`. The button carries
`aria-expanded` reflecting that state and `aria-controls` naming the panel's id.
The chevron is the ONLY indication of collapsed-vs-expanded; the mark does not
change on expand.

**Rule D13-6 (expansion is inert to layout)**: Expanding a row MUST NOT change
row order, the set or position of any tick row, lane assignment, any `▣N` count,
or any other row's mark. This is structural, not a discipline: every one of
those values is computed in `buildRail` on the server from each node's `ts` and the
`ChainUnit[]`, and expansion is client state that never re-enters that function.

**Rule D13-7 (reflow)**: The panel renders **inside** the expanded node's own
element (`data-rail-node`), after the row's first line and before its Lane-2
block, so the rail's gutter stroke runs unbroken past it —
`RailGutter`'s trailing segment is already `flex-1`
(`CondensedTimeline.tsx:1055`) and stretches to the node's new height. A row that
grows by ~6 lines therefore pushes everything below it down as one block; the
day tick that was below it stays below it, and the `now` tick likewise (§11.11).

**Rule D13-8 (no accordion)**: Any number of rows may be expanded at once.
Collapsing one MUST NOT collapse another. The rail is a list, not a wizard, and
comparing two rows' attempt histories is a real reason to open both.

**Rule D13-9 (one toggle, not two)**: The panel is `AttemptStrip` rendered with
its internal summary `<button>` suppressed (a new boolean prop, proposed name
hideToggle). `AttemptStrip` keeps its own `defaultExpanded` seam for fixtures.
Two nested toggles — the row's and the strip's — is precisely the ambiguity that
made v1's stub untappable in practice.

**Rule D13-10 (the chain badge is a separate control; amended in v3)**: On a
terminal chain the `▣N`/`▼N` badge and the right-column control are two
independent buttons with independent state: the badge discloses the ordinal
sub-rows, the right column discloses the attempt panel. Neither implies the
other. Both obey D13-3's hit region. v3 amends two things: the badge is no longer
a bare glyph but the whole title region (§13.4), and while the chain is expanded
the chain row's right-column control folds away (Rule D13-17).

**Rule D13-11 (the panel is testable)**: The panel carries
`data-testid="rail-attempt-disclosure"` and the control carries
`data-testid="rail-attempt-toggle"`. `data-testid="rail-retry-stub"`
(`CondensedTimeline.tsx:1112`) is removed along with the stub, and MUST NOT
appear in the rendered tree.

### 13.3 Navigation — what a tap does (v3)

§13.1–§13.2 specify one control's hit box. This subsection specifies which
element owns a tap in the first place, which is the question Finding 4 exposes:
v2's control works because it stops the tap reaching an ancestor, and that was a
property of one button rather than a rule.

**Rule D13-12 (the one rule)**: A tap on the mobile rail changes `location` ONLY
when it lands on a row that stands for **exactly one task**, and only on that
row's own title. Every other element on the rail — chain badge, fork glyph,
attempt control, tick, gutter, panel text — is an in-place control or inert
chrome. There is no third category.

**Rule D13-13 (`data-task-id` names exactly one task)**: The rail's task-sheet
peek is not a link; it is the delegated handler in `TaskPanelWrapper`
(`TaskPanelWrapper.tsx:37–52`), which resolves `closest('[data-task-id]')` from
the click target, calls `preventDefault()`, and opens that task. Therefore
`data-task-id` MUST be carried by the smallest element that contains exactly one
task's title, exactly as the desktop row already does
(`CondensedTimeline.tsx:323–327`).

Specifically: `RailNodeRow`'s root element — the one carrying `data-rail-node`
— MUST NOT carry `data-task-id` (it does today,
`CondensedTimeline.tsx:1185`, which is the whole of Finding 4). The attribute
moves onto each row inside the unit that stands for exactly one task: a
standalone node's line, each ordinal sub-row, each Lane-2 sibling. A chain row
with `count > 1` carries none, because there is no single task it could name
(Rule D1-7).

**Rule D13-14 (every rail control stops propagation)**: Every `<button>` on the
rail MUST call `stopPropagation` in its `onClick`. This is not defensive
styling — without it the delegated handler above runs on the bubbled React click
and opens a sheet behind the control, which is precisely how the badge came to
toggle expansion invisibly. The §13 attempt control already complies
(`CondensedTimeline.tsx:1007`); the chain badge (line 1196) and the fork glyph
(line 1265) do not, and MUST.

**Rule D13-15 (the rejection, stated mechanically)**: A click dispatched anywhere
inside a rail disclosure control's box MUST leave `location.pathname` unchanged
AND MUST NOT add or change the `task` search parameter — the sheet's own address
(`TaskPanelWrapper.tsx:21–26`). "Does not navigate" is checked against both,
because the sheet does not change the path.

**Rule D13-16 (the navigators)**: Ordinal sub-rows and Lane-2 sibling rows keep
their title `<Link href="/app/tasks/{id}">` and gain that task's own
`data-task-id`, plus the same `data-task-actionable` predicate the desktop row
uses (`CondensedTimeline.tsx:325–327`) — so a completed task with no PR falls
through to the link and opens its full page instead of an empty drawer. That
predicate is reused, not re-derived: a rail row and a desktop row are answering
the identical question.

### 13.4 The chain disclosure control (v3)

**Rule D13-17 (the control is the badge AND the title; and what the right column
does while it is open)**: On a row with
`count > 1` the badge and the title text are the children of ONE `<button>`,
a sibling of the right column and never its ancestor or descendant. It carries
`aria-expanded`, `aria-controls` naming the ordinal sub-row group's id, and
`data-testid="rail-chain-toggle"`; the group carries that id and
`data-testid="rail-chain-members"`. Everything else about it — `stopPropagation`,
the ≥44px hit box, no intersecting targets, no accordion, expansion inert to
layout — is §13.1/§13.2's contract unchanged, and is not restated here.

While the chain is expanded, the chain row's right column renders its rolled-up
outcome mark (Rule D7-5) as static text with **no chevron and no button**, and
its own attempt panel is not rendered. The members are on screen and each owns
its own history control; a second aggregate control re-printing exactly those
panels is duplicate chrome on a 360px row, which is the thing §6.4 spends its
entire argument avoiding. This is a deliberate carve-out from Rule D13-8's
no-accordion rule, scoped to one unit: collapsing the chain again restores the
chain row's control, and no *other* row is ever affected.

**Why the title is part of the control and not a link to the head.** The row
stands for N tasks and already mixes two of them — the title is the head's, the
PR is the terminal member's (Rule D1-5). A link on it would have to pick one, and
the shipped implementation's pick is the defect this amendment exists to remove.
The width budget settles the rest: at 360px the title is the row's only large
target, so making the small badge the sole disclosure while the title navigates
puts most of the tappable area on the behaviour Rule D13-12 forbids, and D13-4
forbids resolving that by overlapping the two. Folding the title into the button
makes the disclosure the row's dominant target — the honest answer, since a
collapsed chain's one question is "what is in it?" The head is not lost: it is
ordinal member 1, one tap away, and that tap goes to the head specifically rather
than to whichever task the row happened to be built from.

**Rule D13-18 (expansion state has exactly one writer)**: A chain row's
expansion is component-local `useState` inside `RailNodeRow`
(`CondensedTimeline.tsx:1154`). The chain toggle's own `onClick` is its ONLY
writer. A `useEffect`, a `usePathname`/`useSearchParams` subscription, a
task-sheet open or close path, and the re-render triggered by the `router.replace`
that `TaskPanelWrapper` performs MUST NOT write it. `expandedChainIds` and
`disclosedTaskIds` (`CondensedTimeline.tsx:1131–1138`) seed the INITIAL value
through the `useState` initializer and are a fixture seam only; they are not
writers, and they MUST NOT be promoted to a controlled prop, because that would
route expansion through a re-render the sheet can trigger.

The consequence the reader cares about: opening a task sheet from an ordinal
sub-row and closing it again leaves the chain expanded, with the same sub-rows
and the same open attempt panels. Expansion must never be something you discover
after dismissing something else.

**Rule D13-19 (collapsing hides, it does not clear)**: Collapsing a chain hides
its ordinal sub-rows and any attempt panels open inside them. Their open state is
retained, so re-expanding restores exactly what was showing. Nothing in the unit
resets another control's state — the two disclosures are independent in both
directions (Rule D13-10).

---

## 14. Migration notes

### 14.1 What v2 supersedes

| v1 rule / AC | Status in v2 | Where |
|---|---|---|
| Rule D1-1, D1-3, D1-4 | survive unchanged | §1 |
| Rule D1-2 | survives, amended — retry leaves Lane 2 for the right column | §1.2 |
| Rule D2-1, D2-3 | survive unchanged | §2 |
| Rule D2-2 | survives, amended — lane budget is siblings only | §2.2 |
| Rule D3-1 … D3-4 | survive unchanged | §3.1, §3.2 |
| **Rule D3-5, D3-6** | **superseded** — no retry stub, no retry edge class | §3.3 |
| Rule D4-*, D5-*, D8-*, D10-* | survive unchanged | §4, §5, §8, §10 |
| Rule D6-1, D6-2 | survive unchanged | §6 |
| Rule D6-3 | survives, amended — now actually binding | §6 |
| Rule D7-1, D7-2, D7-3 | survive unchanged | §7 |
| §3.4 greyscale table | amended — two classes, not three | §3.4 |
| §11.3 reference layout | **superseded** — MUST NOT be built | §11.3 |
| **AC-3** | **superseded** by AC-21 (which rejects the stub outright) | below |
| AC-1, AC-2, AC-4 … AC-10 | survive unchanged | below |

Nothing in §4 (ticks), §5 (goal root), §9 (desktop) or §10.1 (CSS branching) is
touched by v2. The one production behaviour v2 removes that v1 shipped is the
Lane-2 retry stub and everything that fed it.

### 14.2 What v3 supersedes

v3 removes no rule outright. It settles questions v1 and v2 left to the
implementation, so the entries below are amendments and restatements rather than
deletions.

| v1 / v2 rule or AC | Status in v3 | Where |
|---|---|---|
| Rule D1-1 … D1-4 | survive unchanged | §1 |
| §1.3 "Collapsed label" prose | **promoted to Rule D1-5** — the PR is the terminal member's, the title is the head's; ends the open follow-up rather than leaving it a separate item | §1.3 |
| §1.3 badge glyph (unstated) | **new Rule D1-6** — `▣N` collapsed, `▼N` expanded | §1.3 |
| §1.3 "expand on tap" (affordance unstated) | **new Rule D1-7 + §13.4** — the badge and the title are one `<button>`; the chain row has no task link | §1.3, §13.4 |
| Rule D2-*, D3-*, D4-*, D5-*, D6-*, D7-*, D8-*, D10-*, D12-* | survive unchanged | §2–§12 |
| Rule D13-1 … D13-9 | survive unchanged — v3 cites this contract, it does not restate it | §13.1, §13.2 |
| **Rule D13-10** | **amended** — the badge is the whole title region, and the chain row's right-column control folds away while the chain is open | §13.4 |
| Rule D13-11 | survives; v3 adds `rail-chain-toggle` / `rail-chain-members` alongside it | §13.4 |
| **AC-1** | **restated as AC-36** — "tapping it expands" named no control; AC-36 names the control, the glyph change, the `aria-controls` target, and the no-cross-talk requirement. AC-1's structural half (three tasks render as one row) survives and is unchanged. | below |
| AC-2 | survives unchanged; AC-43 adds the glyph assertion at N=2 | below |
| **§11.1(b)** | **redrawn** — `▼3`, and the chain row's attempt chevron removed | §11.1 |
| **§11.12(b)** | **redrawn** — same two changes; the rolled-up `!` stays | §11.12 |
| §11.1(a), §11.12(a) | survive; legends amended to name the new control boundaries | §11.1, §11.12 |
| §11.5 goal-root label text | **noted as v1 mock text**, not a contract — the shipped root prints `goal {passed} / {total}` | §11.18 |
| AC-3 … AC-32 | survive unchanged | below |

The one production behaviour v3 removes that v2 shipped: the `data-task-id`
attribute on `RailNodeRow`'s wrapper, and with it the delegated task-sheet peek
that fired for every tap anywhere inside a chain unit.

### 14.3 v3.1 — where the v2 brief's enumerated edge cases live

The v2 brief listed thirteen edge cases, "non-exhaustive — find the rest". This
table is the mechanical check that every one has a rule, a drawing when the
drawing changes, and a criterion. "Drawing unchanged" means the case renders
with an existing layout's exact glyphs and no new one is owed.

| # | Edge case (as briefed) | Rule | Layout | AC |
|---|---|---|---|---|
| 1 | >1 reviewer round (`retry #2 of 3`) | D6-5 state 3; D2-4 (the lane-cap/fork interaction no longer exists — retries left Lane 2) | §11.8 — drawing unchanged; the ledger gains one dot per round (`●●○`) | AC-14, AC-32 |
| 2 | Attempts exhausted, `#3 of 3` with changes still requested | D6-5 state 1, D6-6, D7-4 | §11.9b | AC-16 |
| 3 | CI retry + reviewer retry on one parent | D12-2, D12-3 | §11.10 | AC-17 |
| 4 | Conflict retry (`conflictRetryPrNumber`) | D12-2 (§12.2 sites 6, 7) | §11.10 — drawing unchanged; the mark tiers are mechanism-blind, only the panel's summary word differs | AC-30 |
| 5 | Retry whose parent is collapsed inside a terminal chain | D7-5 — the chain row AND the ordinal sub-row | §11.12 | AC-20 |
| 6 | Retry on a chain head vs an interior member | D7-5 ("holds identically") | §11.12, §11.15 | AC-20, AC-41 |
| 7 | Retry with no PR number | D6-13 | §11.13c | AC-23 |
| 8 | Retry `queued` but never claimed | D6-11 — `◌` only for the budget wall; every other dormancy reason is not derivable and renders `○` | §11.8 legend | AC-31 |
| 9 | Superseded reviewer cycle (same `reviewerRetryPrNumber`, new `reviewerRetryHeadSha`) | D12-2 — the lineage, never latest-only | — (the panel lists both rows; no rail glyph changes) | AC-32 |
| 10 | Zero-attempt rows | D6-4 | §11.13a, §11.13b | AC-11, AC-22 |
| 11 | Expanded row across a day tick | D13-6, D13-7 | §11.11, §11.17 | AC-19, AC-45 |
| 12 | Expanded row + `now` tick | D13-6, D13-7 | §11.11 legend, §11.18 | AC-19, AC-46 |
| 13 | Goal root when a criteria evaluator is attempt-bearing | **D5-5, D5-6, D5-7 (v3.1)** | **§11.21** | **AC-48, AC-49, AC-50** |

Found while closing the list, and answered by the same rules:

| # | Edge case | Rule | Layout | AC |
|---|---|---|---|---|
| 14 | An attempt whose parent is not a rendered node (the parent is `bookkeeping`, or is itself an attempt) | D5-5 for the evaluator case; in general `partitionBookkeeping` keeps such rows in the footer because `renderedTaskIds` does not contain the parent (`attempt-strip.ts:277`), and no rail node exists for the strip to attach to | §11.21b | AC-50 |
| 15 | A companion (reviewer pass, drift diagnosis, continuation) as the ONLY child | D12-1, D12-2, D12-4 | §11.13a — drawing unchanged | AC-27, AC-28 |
| 16 | The stalled-worker reclaim of a real attempt | D12-6 — a stated undercount, not a renderer guess | — | none: a write-site fix, out of scope |

No v1, v2 or v3 rule, layout or criterion is amended by v3.1. Rows 13 and 14
are additive.

---

## Invariants

- The mobile rail and desktop Timeline render from the identical
  `groupChainUnits()` / `ChainUnit[]` value — no mobile-only re-derivation of
  chain structure.
- A rail node's fill is derived from `deriveStage()` and nothing else (Rule
  D7-1); attempt history never changes it (Rule D7-4).
- A rail edge's class is hard or soft, never retry, and never blends two
  classes' visual treatments (§3.4, Rule D3-5).
- No day-bucketing function (`deriveBandKey`, `deriveDayBands`) is reachable
  from the mobile render branch (Rule D4-1/D4-2).
- The goal root never renders when `goalCriteria` is absent (Rule D5-4).
- Retry lineage never renders as ordinal chain membership (Rule D1-2).
- For every attempt strip the rail reads,
  `total === kindCounts.ci + kindCounts.reviewer + kindCounts.conflict` —
  the count and its breakdown can never disagree (Rule D12-3).
- A row whose outcome is a clean merge renders no outcome mark, whatever its
  attempt history (Rule D6-5 state 5) — the rail spends ink only on exceptions.
- A row with `attempts.total === 0` renders no mark, no chevron, and no
  disclosure control (Rule D6-4, no empty chrome).
- Expansion state never changes row order, tick position, lane assignment, or
  any `▣N` count (Rule D13-6).
- Every interactive control on the rail has a hit box of at least 44 CSS px
  wide by the full height of its row, and no two controls' boxes intersect
  (Rule D13-3/D13-4).
- A tap on the rail changes `location` only from a row that stands for exactly
  one task, and only on that row's own title (Rule D13-12).
- No element carrying `data-task-id` contains a row that stands for a different
  task; a row with `count > 1` carries none (Rule D13-13).
- Every `<button>` on the rail stops its click propagating, so the delegated
  task-sheet handler can never fire behind a control (Rule D13-14).
- A tap inside any rail disclosure control leaves `location.pathname` unchanged
  and the `task` search parameter untouched (Rule D13-15).
- A chain row's expansion state is written only by its own toggle, and survives
  opening and closing a task sheet (Rule D13-18).
- `count > 1` and a non-empty Lane 2 never hold on the same node — a fan-out
  unit's `members` is its head alone (§11.20).
- A criteria evaluator task never renders as a rail node, and the goal root
  reads `GoalCriteriaState` verdicts only — never an evaluator task's status or
  attempt history (Rule D5-5..D5-7).
- An attempt strip whose parent is not a rendered `work` node attaches to no
  rail node and produces no mark, chevron or panel on the rail (Rule D5-5,
  D5-6).

---

## Acceptance criteria

**AC-1 (restated in v3 as AC-36)**: GIVEN a mission where
SPEC(#2270)→BUILD(#2287)→REVIEW(#2295) are all `completed` and merged, WHEN the
Timeline renders at a viewport < 768px, THEN these three tasks render as ONE
collapsed rail row (`▣3 {head title}`) rather than three separate rows, and
activating the chain toggle expands to three ordinal sub-rows labelled `1 SPEC`,
`2 BUILD`, `3 REVIEW`. ("Tapping it" named no control; AC-36 names the control
and what activating it must and must not do.)

**AC-2**: GIVEN the same chain but with only 2 tasks (SPEC→BUILD, no REVIEW),
WHEN rendered on mobile, THEN it STILL collapses by default (Rule D1-4) —
collapse posture does not depend on a length threshold in the `done` section.

**AC-3 (SUPERSEDED by AC-21)**: v1 required a task with retry lineage to render
a dashed-red Lane-2 stub terminating in `✗`. v2 forbids that stub outright; the
surviving half of the criterion — that a retry is never an additional ordinal
member of a chain count — is re-stated as AC-20. Do not implement AC-3.

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

### v2 acceptance criteria

**AC-11**: GIVEN a task that merged with no attempt history
(`attempts.total === 0`), WHEN its rail row renders, THEN the right column
contains the PR number and its lifecycle word and NOTHING else — no mark, no
chevron, no dots (Rule D6-4, §11.6).

**AC-12**: GIVEN a task that merged after exactly one reviewer retry which
completed, whose latest `reviewerNote` is `reviewer_approved`, WHEN its rail row
renders, THEN the right column contains a `⌃` chevron and NO outcome mark — the
row is visually identical to AC-11's except for the chevron (Rule D6-5 state 5,
§11.6).

**AC-13**: GIVEN a task whose PR merged and whose latest `reviewerNote` is
`reviewer_request_changes` with `status === 'open'`, WHEN its rail row renders,
THEN the right column contains `!` in `text-status-warning`, positioned between
the PR lifecycle word and the chevron (Rule D6-7, D6-12, §11.7).

**AC-14**: GIVEN a task with two attempts of which the newer has
`status === 'running'`, WHEN its rail row renders, THEN the right column
contains `●○` in `text-text-muted` and contains neither `✗` nor `!`
(Rule D6-5 state 3, §11.8).

**AC-15**: GIVEN a task whose newest attempt has `status === 'failed'` and whose
iteration is below its maximum, WHEN its rail row renders, THEN the right column
contains `✗` in `text-status-error` (Rule D6-5 state 2, §11.9a).

**AC-16**: GIVEN a task whose newest attempt carries `iteration === 3` and
`maxIterations === 3` and whose PR is open and not merged, WHEN its rail row
renders, THEN the right column contains `3/3` in `text-status-error`, the node
glyph is the amber `waiting on you` ring, and the node glyph is NOT
`text-status-error` (Rule D6-5 state 1, D6-6, D7-4, §11.9b).

**AC-17**: GIVEN a task with one `ci` attempt and one `reviewer` attempt, WHEN
its disclosure panel is expanded, THEN the panel's summary line reads
`2 attempts · CI ×1 · reviewer ×1`, the panel lists exactly two attempt rows,
and the reviewer **pass** task that produced the verdict appears in neither
(Rule D12-1, D12-2, §11.10).

**AC-18 (rejection)**: GIVEN a task that merged after a reviewer retry which
completed and pushed to the PR, WHEN its rail row renders, THEN `✗` appears
nowhere in the row — not in the gutter, not in the right column, not in Lane 2
(Rule D3-5, D6-5 state 5).

**AC-19**: GIVEN a rail whose rows span two calendar days, WHEN a row above the
day tick is expanded, THEN the tick row's position in the rendered sequence is
unchanged, its label is unchanged, and the expanded panel renders above it
(Rule D13-6, D13-7, §11.11). The same holds for the `now` tick.

**AC-20**: GIVEN a collapsed terminal chain of 3 tasks in which the second
member has one reviewer retry whose feedback did not land, WHEN the chain row
renders, THEN its badge reads `▣3` (not `▣4`) and its right column carries the
rolled-up `!`; WHEN the chain is expanded, THEN the `!` appears on the second
member's sub-row AND remains on the chain row (Rule D1-2, D7-5, §11.12).

**AC-21 (rejection)**: GIVEN any mission and any viewport below 768px, WHEN the
rail renders, THEN the rendered tree contains no element with
`data-testid="rail-retry-stub"`, no `✗` inside a rail gutter, and no rail
segment styled with the retry edge stroke (Rule D3-5, D3-6, D13-11).

**AC-22 (rejection)**: GIVEN a task with `status === 'failed'` and
`attempts.total === 0`, WHEN its rail row renders, THEN the node glyph is the
filled `FAILED` circle and the right column contains no outcome mark and no
chevron (§11.13b, no empty chrome).

**AC-23**: GIVEN a task with attempt history whose latest worker has no
`prNumber`, WHEN its rail row renders, THEN the right column still renders its
outcome mark and chevron (Rule D6-13, §11.13c).

**AC-24**: GIVEN any rail row that renders a disclosure control, WHEN the
control's box is measured, THEN its width is at least 44 CSS px, its height is
at least 24 CSS px and equals the row's height, and it intersects no other
interactive element's box (Rule D13-3, D13-4).

**AC-25**: GIVEN a rail row whose disclosure is collapsed, WHEN the control is
activated, THEN the control's `aria-expanded` becomes `true`, its chevron
becomes `⌄`, an element with `data-testid="rail-attempt-disclosure"` appears
within the same `data-rail-node` element, and no other row's expansion state
changes (Rule D13-5, D13-8).

**AC-26 (rejection)**: GIVEN an expanded disclosure panel, WHEN its tree is
inspected, THEN it contains exactly one control with `aria-expanded` — the
row's — and `AttemptStrip`'s own summary button is absent (Rule D13-9).

**AC-27**: GIVEN a task whose only `taskClass = 'attempt'` child is its reviewer
pass (no retry counter column set), WHEN its rail row renders, THEN
`attempts.total` is 0, so the row renders no mark and no chevron, and the
reviewer verdict reaches the reader only through the existing verdict chip
(Rule D12-1, D12-2).

**AC-28 (rejection)**: GIVEN a task whose only attempt child is a schema-drift
diagnose task (`context.driftDiagnosis === true`, `ciRetryPrNumber` set), WHEN
its rail row renders, THEN the row reports no attempts and the summary line
`1 attempt · CI ×1` appears nowhere (Rule D12-4).

**AC-29**: GIVEN any attempt strip the rail reads, WHEN its counts are summed,
THEN `total === kindCounts.ci + kindCounts.reviewer + kindCounts.conflict`, and
`ATTEMPT_KINDS` does not contain an `other` member (Rule D12-3).

**AC-30**: GIVEN a task with one `conflict` attempt (a row carrying
`conflictRetryPrNumber`), WHEN its disclosure panel is expanded, THEN the
summary line names `conflict ×1` — the mechanism v1 left unrepresented
(Rule D12-2).

**AC-31**: GIVEN a task with a pending attempt on a mission whose status is
`budget_exhausted`, WHEN its rail row renders, THEN the ledger's trailing dot is
the dashed `◌` rather than the hollow `○` (Rule D6-11).

**AC-32**: GIVEN a task with a superseded reviewer cycle — two attempt rows
sharing `reviewerRetryPrNumber` with different `reviewerRetryHeadSha` values —
WHEN its disclosure panel is expanded, THEN the panel lists BOTH rows and the
total counts both; the rail MUST NOT collapse the lineage to the latest cycle
(Rule D12-2; the dots are a ledger, and dropping older cycles would reintroduce
Finding 2's undercount from the other direction).

### v3 acceptance criteria

**AC-33**: GIVEN a collapsed terminal chain SPEC(#2270)→BUILD(#2287)→REVIEW(#2295),
WHEN its rail row renders, THEN its right column contains `#2295` and the string
`#2270` appears nowhere in the row, while the title text is the head's
(Rule D1-5, §11.14).

**AC-34 (rejection)**: GIVEN a rail row with `count > 1`, WHEN its first line's
subtree is inspected, THEN it contains no `<a>` whose `href` starts with
`/app/tasks/`, and it carries no `data-task-id` attribute (Rule D1-7, D13-13).

**AC-35 (rejection)**: GIVEN a collapsed chain row, WHEN a click is dispatched
anywhere inside the chain toggle's bounding box, THEN `location.pathname` is
unchanged, the `task` search parameter is unchanged, and no task sheet mounts
(Rule D13-14, D13-15).

**AC-36**: GIVEN a collapsed chain row of 3 tasks, WHEN its chain toggle is
activated, THEN the toggle's `aria-expanded` becomes `true`, its badge text
changes from `▣3` to `▼3`, an element with `data-testid="rail-chain-members"`
whose `id` equals the toggle's `aria-controls` appears containing three ordinal
sub-rows, and no other chain row's `aria-expanded` changes
(Rule D1-6, D13-17, §11.15).

**AC-37**: GIVEN an expanded chain of 3, WHEN ordinal sub-row 2 is activated,
THEN the task that opens is member 2's id — not the head's (Rule D13-13, D13-16).

**AC-38 (rejection)**: GIVEN any rail node, WHEN the rendered tree is inspected,
THEN the element carrying `data-rail-node` carries no `data-task-id`, and no
element carrying `data-task-id` contains a descendant row belonging to a
different task (Rule D13-13).

**AC-39**: GIVEN an expanded chain, WHEN a task sheet is opened from one of its
ordinal sub-rows and then closed, THEN the chain toggle's `aria-expanded` is
still `true` and the same ordinal sub-rows are still rendered (Rule D13-18).

**AC-40 (rejection)**: GIVEN `CondensedTimeline.tsx`, WHEN every writer of a
chain row's expansion state is enumerated, THEN the chain toggle's own `onClick`
is the only one — no `useEffect`, no `usePathname`/`useSearchParams`
subscription, and no task-sheet open or close path calls its setter; and
`expandedChainIds` is read only by a `useState` initializer (Rule D13-18).

**AC-41**: GIVEN an expanded chain whose member 2 has attempt history and an `!`
outcome, WHEN the unit renders, THEN member 2's right column contains `!` and a
control with `data-testid="rail-attempt-toggle"`, AND the chain row's right
column contains the rolled-up `!` and no element with `aria-expanded` other than
the chain toggle itself (Rule D7-5, D13-17, §11.15).

**AC-42**: GIVEN an expanded chain of 3 whose member 2's attempt panel is also
open, WHEN the unit renders, THEN exactly two elements inside the unit carry
`aria-expanded="true"` — the chain toggle and member 2's attempt toggle — and
member 2's `data-testid="rail-attempt-disclosure"` panel renders after member 2's
row and before member 3's row (Rule D13-10, §11.16).

**AC-43**: GIVEN a terminal chain of exactly 2 tasks, WHEN it renders, THEN it
renders collapsed with a `▣2` badge and a chain toggle, exactly as a 3-task chain
does (Rule D1-4, D1-6, §11.19).

**AC-44 (rejection)**: GIVEN a `ChainUnit` whose `shape` is `fan-out`, WHEN its
rail node renders, THEN its `count` is 1, no `▣N`/`▼N` badge renders, and no
element with `data-testid="rail-chain-toggle"` exists on that node — so the badge
never competes with the fork arm for Lane-2 width (§11.20).

**AC-45**: GIVEN a terminal chain whose members' bucketing timestamps fall on two
different calendar days, WHEN the chain is expanded, THEN no tick row renders
between any two of its ordinal sub-rows, and the tick above the unit has the same
position and label it had while the chain was collapsed
(Rule D4-4, D13-6, §11.17).

**AC-46**: GIVEN a mission with `goalCriteria` set whose last rail node is a
terminal chain, WHEN that chain is expanded, THEN the `now` tick and the goal
root render after the unit's last ordinal sub-row in document order, the node's
gutter renders its trailing rail segment, and neither the tick's label nor the
root's pass count changes (Rule D13-6, §11.18).

**AC-47 (rejection)**: GIVEN a fan-out node with hidden siblings, WHEN its
`├╮ +N` fork button is clicked, THEN `location.pathname` and the `task` search
parameter are unchanged and no task sheet mounts (Rule D13-14, §11.20).

### v3.1 acceptance criteria

**AC-48 (rejection)**: GIVEN a mission with `goalCriteria` set whose `command`
criterion has a verification task with `taskClass === 'bookkeeping'` and
`status === 'running'`, WHEN the Timeline renders on mobile, THEN no element
carrying `data-rail-node` corresponds to that task's id, the element with
`data-testid="rail-goal-root"` is the last rail element before the bookkeeping
footer, and the evaluator's title appears only inside the footer
(Rule D5-5, §11.21a).

**AC-49**: GIVEN a mission with 3 criteria whose stored
`goalCriteriaState.criteria` verdicts are `pass`, `PENDING`, `fail`, WHEN the
goal root renders, THEN it reads `1 / 3`, its glyph is the hollow square, and
the text `?` appears nowhere in it; AND GIVEN the same mission after the pending
verifier lands `UNVERIFIED`, WHEN the root re-renders, THEN it still reads
`1 / 3` (Rule D5-7).

**AC-50 (rejection)**: GIVEN a verification task with `status === 'failed'` and
a stalled-worker reclaim child with `taskClass === 'attempt'`, `parentTaskId`
pointing at it, and no retry column set, WHEN the Timeline renders on mobile,
THEN `✗` appears nowhere in the rendered rail, no element with
`data-testid="rail-attempt-toggle"` exists for either task, and the goal root's
count equals the count before the evaluator ran (Rule D5-6, D12-6, §11.21b).

---

## Code surface

- `apps/web/src/lib/condensed-timeline.ts` — `identifyChains`, new
  `isTerminalLinearInterior` pass (§1), `groupChainUnits`, `ChainUnit` (all
  reused; new terminal-chain logic is additive); `buildRail`, `RailNode`,
  `RailOptions` — **v2 removes `RailNode.retries`, `RailOptions.retryLinks` and
  the `room = laneCap - 1` reservation (line 587), and adds the outcome
  derivation (Rule D6-5)**
- `apps/web/src/app/app/(protected)/missions/[id]/CondensedTimeline.tsx` —
  `TimelineView`, `ChainBlock`, `ChainList`, new mobile render branch gated by
  `md:hidden` / `hidden md:block` (§10.1); `WaveBandedDone`, `deriveBandKey`
  unreachable from that branch only (§4); **v2 rewrites `RailRightColumn`
  (line 952) into the disclosure control and deletes the retry-stub block**;
  **v3 rewrites `RailNodeRow` (line 1127) — `data-task-id` leaves its wrapper
  (line 1185, Rule D13-13), the `▣N` badge (lines 1194–1203) becomes the
  badge-plus-title toggle (Rule D13-17), and the badge and fork-glyph
  (line 1265) clicks gain `stopPropagation` (Rule D13-14)** — and gives
  `RailTaskLine` (line 1070) a PR source distinct from its title task
  (Rule D1-5)
- `apps/web/src/app/app/(protected)/missions/[id]/TaskPanelWrapper.tsx` —
  `TaskPanelWrapper`, its delegated `[data-task-id]` click handler
  (lines 37–52) and the `task` search parameter the sheet addresses itself with
  (lines 21–34). **Unchanged by v3** — the rail conforms to it; the peek is a
  page-wide contract and narrowing it for one surface would break the desktop
  rows and `HeartbeatTimeline` that already rely on it.
- `apps/web/src/lib/attempt-strip.ts` — `buildAttemptStrips`, `attemptKind`,
  `ATTEMPT_KINDS`, `summarise`, `AttemptRow` — **v2's attempt filter (§12) and
  the iteration/maximum fields (Rule D6-9) both land here**. `attemptKind`
  replaces v1's kindOf (written in plain text per `SPEC-FORMAT.md` rule 7: it no
  longer exists), which classified a `TaskOriginMechanism` string and therefore
  had an `other` bucket to fall into; the v2 discriminator reads the retry
  columns off the row and returns null for a companion (Rule D12-2).
- `apps/web/src/lib/task-origin.ts` — `deriveTaskOrigin`, `retryKind`,
  `iterationClause` — read unchanged; `retryKind`'s column precedence is the
  model Rule D12-2 restates
- `packages/core/mission-helpers.ts` — `attachAttempts`, `isAttempt` —
  **unchanged by v2** (Rule D12-5): the narrowing is applied to its output, not
  to it
- `apps/web/src/app/app/(protected)/missions/[id]/page.tsx` — the mission
  detail query and `toTimelineTask` (line 654): `reviewerNoteMap` (line 284),
  `reviewerRetryMap` (line 512) and `attemptStrips` (line 533) are the three
  inputs Rules D6-5/D6-7 read; the `retryLinks` map (line 721) is removed with
  Rule D3-6
- `apps/web/src/components/SegmentStrip.tsx` — `SegmentStrip`, `SegmentGlyph`,
  `RailNodeGlyph` — new `shape` prop and glyph states (§10.2)
- `apps/web/src/components/DependencyRail.tsx` — `DependencyRail`,
  `RailEdgeKind`, `EDGE_STROKE` — line-render mode alongside the existing chip
  mode (§3, §10.2); **v2 removes the `'retry'` member and its stroke**
- `apps/web/src/components/StageChip.tsx` — `StageChip` (fill source only, no
  new prop — reused per Rule D7-1)
- `apps/web/src/lib/stage.ts` — `deriveStage` (sole stage-to-fill path)
- `apps/web/src/lib/structure-layout.ts` — `isStrandedTask` (Rule D7-2 requires
  exporting this existing function; no logic change)
- `packages/core/path-overlap.ts` — `isAdvisoryManifest`,
  `shouldSerializeByManifest` (Rule D3-2/D3-3, reused unchanged)
- `apps/web/src/app/app/(protected)/missions/[id]/AttemptStrip.tsx` —
  `AttemptStrip`, retained as the disclosure panel (Rule D13-9) and unchanged on
  desktop; **v2 adds one boolean prop that suppresses its internal summary
  button so the rail row owns the only toggle**
- `packages/shared/src/types.ts` — `GoalCriterion`, `GoalCriteriaState`,
  `CriterionVerdict` (§5, read-only)
- `apps/web/src/lib/mission-criteria-verify.ts` — `dispatchCommandCriterionTask`,
  `handleCriteriaVerificationOutcome`, `CriteriaVerificationContext` — the
  `command` evaluator's creation site and verdict writer (Rules D5-5..D5-7,
  read-only)
- `apps/web/src/lib/mission-criteria-prose.ts` — `dispatchProseEvalTask`;
  `apps/web/src/lib/mission-criteria-worker-eval.ts` — `dispatchWorkerEvalTask`
  — the other two evaluator creation sites, both `taskClass: 'bookkeeping'`
  (Rule D5-5, read-only)
- `apps/web/src/lib/attempt-strip.ts` — `partitionBookkeeping` (Rule D5-5: a
  child of an unrendered parent stays in the footer)
- `apps/web/src/app/app/(protected)/missions/[id]/CondensedTimeline.tsx` —
  `MobileRail` (line 1315), `RailGoalRoot` (line 1293), `BookkeepingFooter`
  (line 573) — **read unchanged by v3.1**; the root-then-footer order at lines
  1366–1367 is the behaviour Rule D5-5 binds

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
- **The two orchestrator defects this amendment renders around, not fixes.**
  Both are backend and filed separately; they are named here only because Rule
  D6-7's `unlanded` state exists to make their consequence visible on a phone
  rather than to correct it. (1) The `outputRequirement: 'none'` arm of the
  worker completion path misses its `worker.mergedAt` check. (2) A merge can
  proceed while a reviewer verdict is still non-terminal — which is the write-side
  cause of every `unlanded` row the rail will now mark. If (2) is fixed, the
  `unlanded` state stops firing, which is the correct outcome: the mark is a
  symptom display, and a symptom display going quiet is success, not dead code.
- **Carrying retry provenance through a stalled-worker reclaim** (Rule D12-6).
  The undercount is real and is stated rather than worked around; the fix is a
  write-site change at `stale-workers.ts:910–929`, not a renderer heuristic.
- The desktop `AttemptStrip` summary line — unchanged. v2 removes attempt prose
  from the **rail**, not from the desktop task row, where a wider viewport makes
  `2 attempts · CI ×1 · reviewer ×1` affordable at all times (§9).
- **The task sheet itself** — `TaskPanel` and the `TaskPanelWrapper` delegation
  model are read as given by v3. The amendment changes which element the rail
  offers to that handler, never what the handler does or what the sheet renders.
- **Any change to `groupChainUnits()` or `ChainUnit` derivation** — v3 is a
  question of which element owns a tap. `identifyChains`, `buildRail` and every
  value on `RailNode` are unchanged, and `buildRail` stays pure: chain expansion
  is component state that never re-enters it (Rule D13-6, D13-18).
- **The desktop delegated peek** — `CondensedTimeline.tsx:323–327` is the
  precedent v3 conforms the rail to, not a target for change.
