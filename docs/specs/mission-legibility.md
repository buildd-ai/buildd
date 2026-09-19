---
title: Mission Legibility
status: active
owner: builder
last_verified: 2026-09-16
summary: A mission's phases and each task's work-kind MUST be stored facts written once at their source, read by every surface through one derivation helper, and never inferred from a task's title.
domain: surfaces
surfaces: [apps/web/src/lib/task-presentation.ts, apps/web/src/lib/approve-plan.ts, apps/web/src/lib/condensed-timeline.ts, apps/web/src/app/app/(protected)/missions/[id]/CondensedTimeline.tsx]
related: [timeline-mobile-rail, mission-structure-view, timeline-dependency-geometry, mission-task-lifecycle]
keywords: [phase, work kind, role slug, glyph, reviewer role, unassigned, swimlane, phase header, approve_plan, usage stats]
verified_by: [apps/web/src/lib/approve-plan.test.ts, apps/web/src/lib/task-presentation.test.ts, apps/web/src/components/TaskCard.test.tsx, apps/web/src/lib/condensed-timeline-rail.test.ts, "apps/web/src/app/app/(protected)/missions/[id]/CondensedTimeline.rail.test.tsx", "apps/web/src/app/app/(protected)/missions/[id]/StructureView.test.tsx"]
supersedes: []
# Structural conformance only; passing does not certify every prose invariant.
assertions:
  - id: "work-kind-derivation"
    type: "symbol"
    name: "deriveWorkKind"
    path: "apps/web/src/lib/task-presentation.ts"
  - id: "rail-phase-type"
    type: "symbol"
    name: "RailPhase"
    path: "apps/web/src/lib/condensed-timeline.ts"
  - id: "rail-badge-reads-work-kind"
    type: "symbol_reachable"
    symbol: "deriveWorkKind"
    entry: "apps/web/src/components/TaskCard.tsx"
  - id: "structure-glyph-reads-work-kind"
    type: "symbol_reachable"
    symbol: "deriveWorkKind"
    entry: "apps/web/src/app/app/(protected)/missions/[id]/StructureView.tsx"
  - id: "rail-phase-render-tests"
    type: "test_file"
    path: "apps/web/src/app/app/(protected)/missions/[id]/CondensedTimeline.rail.test.tsx"
  - id: "structure-glyph-render-tests"
    type: "test_file"
    path: "apps/web/src/app/app/(protected)/missions/[id]/StructureView.test.tsx"
  - id: "rail-phase-model-tests"
    type: "test_file"
    path: "apps/web/src/lib/condensed-timeline-rail.test.ts"
---

# Mission Legibility

**Capability statement**: A mission MUST be readable as a sequence of named
phases, and every task MUST be readable as a shape of work, from stored facts
alone — a phase written once by `approvePlan` from the plan's own structure, a
work-kind written at most once by whichever of filer, worker or PR-open gets
there first — and every surface that draws either MUST read it through a single
shared derivation that never sees a task's title.

> **Promoted to `active`** by the §4 build PR (this one), which lands the
> rail-model and render tests named in §5.3 into `verified_by`. §1–§3 landed
> earlier in PR #2454; §4's rendering — phase header rows, the work-kind glyph
> column on the rail and the Structure canvas, and `TaskTypeBadge`'s rewrite —
> is what this PR adds.

---

## 0. Decision summary

| # | Topic | Decision | §|
|---|-------|----------|---|
| 1 | Phase storage | Two nullable scalar columns on `tasks`, **not** a `mission_phases` table | §1.2 |
| 2 | Phase naming | `missionPhaseIndex` / `missionPhaseLabel` — `phase` is already taken by `deriveTaskPhase` and means something else | §1.1 |
| 3 | What constitutes a phase | An explicit, agent-emitted `phase` label on a `PlanStep`, carried forward in plan order. `dependsOn` layers are **rejected** as a phase source | §1.3 |
| 4 | Plan with no phase labels | Nothing stored; renderer draws no headers | §1.3 |
| 5 | Tasks added after approval | Attempts inherit the parent's phase. Everything else gets NULL — never "the live phase" | §1.4 |
| 6 | Phase rollup | `SegmentStrip` with the chain-strip fill semantics from `docs/design/task-presentation.md`; no new bar | §1.5 |
| 7 | Glyph derivation | One exported helper, `deriveWorkKind`, in `apps/web/src/lib/task-presentation.ts`; three mount points | §2.1 |
| 8 | Fallback chain | `kind` → `roleSlug` → derived task type → none. Strict precedence, exactly one glyph | §2.2 |
| 9 | Role: replaces or annotates? | **Neither.** Role is a fallback tier that resolves *into* the seven-kind vocabulary. No role overlay, no eighth glyph | §2.3 |
| 10 | Glyph vocabulary | Seven glyphs, no circles and no squares — those are spent on the rail's node and phase/goal vocabulary | §2.4 |
| 11 | `create_task` and `kind` | Reworded description; **no** hard 400. A required field in `planningOutputSchema` instead, plus an advisory gate event | §2.5 |
| 12 | Worker self-classification | `kind` on `update_progress`, written only when `tasks.kind IS NULL`; prompted only when absent | §2.6 |
| 13 | `create_pr` as late signal | A **write**, guarded by `kind IS NULL`, not a render-time derivation | §2.7 |
| 14 | Why reviewer runs look roleless | They are not roleless at the creation site. `aggregateByTask` folds attempt workers into the parent bucket | §3.1 |
| 15 | Review trigger | Already exists (`agent-review` tier, PR-open). No second trigger is designed | §3.3 |
| 16 | Phase header geometry | 34px row, square node, `{index} · {label}`, `SegmentStrip` rollup on the right | §4.2 |
| 17 | Day ticks under phases | Suppressed. Only the `now` tick survives | §4.3 |
| 18 | Structure canvas | Glyph column: yes. Phase swimlanes: **explicitly nothing**, with a named precondition | §4.7 |

### 0.1 The observed baseline

`get_usage_stats groupBy=role window=30d` on the `buildd` workspace, read
2026-09-16, grouped by role:

| Role | Share of tasks |
|---|---|
| `(unassigned)` | large majority |
| Builder | most of the remainder |
| Organizer | small minority |
| spec-validator | small minority |
| Researcher | negligible |
| architect | negligible |
| Ops | negligible |

There is **no `reviewer` row at all**, across a window in which nearly every
merged PR took at least one reviewer round. §3 explains why, and the
explanation is not the one the field observation assumed. (Exact counts from
this read are recorded in the team knowledge base, not this public repo — see
`no-prod-data` policy in `CLAUDE.md`.)

---

## 1. Phase as a stored fact

### 1.1 Naming — `phase` is already taken

`deriveTaskPhase` (`apps/web/src/lib/task-presentation.ts:117`) returns a
task's **lifecycle** phase — `running`, `waiting_input`, `blocked`,
`plan_review`, `completed` — and is described in its own doc comment as the
"single source of truth" that "UI surfaces must not fork". It is consumed by
`TaskPanel.tsx:134` and by the task detail page at
`apps/web/src/app/app/(protected)/tasks/[id]/page.tsx:537`.

A mission phase is an unrelated concept: a named stretch of a plan. Shipping a
`task.phase` column beside a `deriveTaskPhase()` helper would put two different
meanings of the same word one import apart.

**Rule P1-1**: The stored fields are named `missionPhaseIndex` and
`missionPhaseLabel`. No symbol introduced by this spec is called `phase`
unqualified — the row-emission pass lives inside `buildRail` (§4.1) rather than
in a second helper whose name would collide — and `deriveTaskPhase` is not
touched.

A second collision to respect: `RailRow` (`condensed-timeline.ts:491`) is a
discriminated union whose tag is literally `kind`, and `tasks.kind` is the
work-kind column. The phase header row added in §4.2 is tagged
`kind: 'phase'` — that is the row discriminator, not a work-kind, and no rail
row type ever carries a work-kind field (§4.4).

### 1.2 Row, not table — decided against `mission_phases`

**Rule P1-2**: A phase is stored as two nullable scalar columns on `tasks`:

```
missionPhaseIndex  integer   -- 1-based, NULL when the task has no phase
missionPhaseLabel  text      -- human label, NULL when the task has no phase
index tasks_mission_phase_idx on (mission_id, mission_phase_index)
```

Both columns are NULL or both are set; a half-set row is rejected at write time
(AC-4).

**Justified against the requirement that the Structure canvas and the rail read
it identically:**

1. **Both readers already hold the task array and nothing else.** `buildRail`
   (`condensed-timeline.ts:550`) is a pure function over `RailGroups<T>`, and
   `computeStructureLayout` (`apps/web/src/lib/structure-layout.ts`) is a pure
   function over `StructureTask[]` + `ChainUnit[]`. Neither takes a database
   handle. A `mission_phases` table forces a second fetch and a join into both
   call sites, and forces `buildRail` to accept a phase map as a new parameter
   whose staleness is now a thing that can differ between the two surfaces.
   With the fact on the row, "read it identically" is literal: the same field
   on the same object both functions already receive.
2. **A phase has no identity of its own.** Nothing references a phase; nothing
   outlives its tasks; deleting the last member deletes the phase. A table
   would add cascade rules and an orphan state for a value object.
3. **The obvious objection — label duplication across N rows — has no write
   path that can desynchronize them.** `missionPhaseLabel` is written exactly
   once per task, by `approvePlan`, and never updated. Re-planning creates new
   tasks; it does not rewrite old ones. A divergent label within one index is
   therefore a bug, and §4 makes it a detectable one (AC-5).
4. **Precedent.** `kind` and `complexity` are scalar columns on `tasks`
   (`packages/core/db/schema.ts:1030-1031`), not a `routing` JSON blob, for the
   same reasons: indexable, orderable in SQL, no shape validation.

Scalar columns are also preferred over the brief's proposed
`phase: { index, label }` JSON for the same reason `kind` is: a JSON column
cannot back `tasks_mission_phase_idx`, and every reader would need a shape
guard for a two-field object.

### 1.3 Population — what in a plan constitutes a phase

A plan is `PlanStep[]` (`packages/shared/src/planning.ts:31`), constrained by
`planningOutputSchema`. It has **no prose and no headings** — the planning
agent emits structured steps, and `approvePlan`
(`apps/web/src/lib/approve-plan.ts:98`) materializes them. So "explicit
headings" has to be created before it can be read.

**Rule P1-3**: `PlanStep` gains an optional `phase?: string` field, and
`planningOutputSchema` gains a matching property with this description:

> `phase`: The named stretch of the mission this step belongs to, e.g.
> "Storage", "Population", "Rendering". Steps that share a phase share a
> heading on every mission surface. Repeat the exact same string on every step
> in a phase, and change it only where a genuinely new stretch of work begins —
> a plan where every step has its own phase has no phases. Leave it off
> entirely when the plan is a single stretch of work.

**Rule P1-4**: `approvePlan` assigns phases in plan-array order, before the
first insert pass:

- The first step carrying a non-blank `phase` opens phase index 1.
- A step whose `phase` differs from the currently open phase opens the next
  index.
- A step with no `phase` **inherits the currently open phase** (index and
  label). This is what makes `phase` behave like a heading: it governs
  everything under it until the next one.
- A step before the first labelled step gets NULL/NULL.
- If **no** step in the plan carries a `phase`, nothing is written: every child
  task gets NULL/NULL and the mission has no phases (AC-1).

**Rule P1-5**: `dependsOn` layers are **rejected** as a phase source. Three
reasons, each independently sufficient:

1. **A layer is already drawn.** Topological layering IS the rail's vertical
   order and the canvas's rank. A header per layer re-encodes geometry the
   reader can already see, and a linear SPEC→BUILD→REVIEW plan would get three
   headers over three rows.
2. **A layer has no name.** `2 · Layer 2` is not legible, and this spec will
   not invent label text from a graph.
3. **A layer is not stable.** `POST /api/tasks` adds `dependsOn` edges after
   approval whenever a new task's concrete `pathManifest` overlaps an existing
   one (`apps/web/src/app/api/tasks/route.ts:679`). One such edge renumbers
   every downstream layer, so the same mission would silently renumber its own
   phases as unrelated tasks are filed. A stored fact must not be re-derivable
   into a different answer tomorrow.

**Rule P1-6**: No phase is ever inferred from a task's title, description, or
any other prose, at any time, by any code path. This is the same doctrine
`apps/web/src/lib/task-origin.ts:17` already states for task classification
("No title parsing").

### 1.4 Tasks created after approval

**Rule P1-7**: A task with `taskClass = 'attempt'` and a `parentTaskId`
inherits `missionPhaseIndex` / `missionPhaseLabel` from its parent, copied at
insert time. This covers reviewer tasks (`reviewer.ts:499-507`), CI retries and
conflict retries — every attempt creation site. It is not a preference: the
rail collapses attempts under the parent row they belong to
(`timeline-mobile-rail.md` §12), so an attempt with a different phase than its
parent would have to render inside a band it is not a member of.

**Rule P1-8**: Every other post-approval task — a human quick-add, a
`[friction]` report, an auto-appended `[surface audit]` task, a heartbeat
child — gets NULL/NULL.

**This rejects the brief's proposal that such a task "joins the live phase".**
The live phase is a function of the wall clock and of which unrelated tasks
happen to be unfinished at the moment of filing. The same friction report filed
ten minutes later would land in a different phase, and the record would say the
platform had planned it there. A stored fact must not depend on when it was
written relative to work it has nothing to do with.

What the reader wanted from that proposal is still delivered, without the lie:
§4.4 renders an unphased node **in its ordinary rail position**, which — for a
task filed during phase 3 — is inside phase 3's stretch of the rail. The
placement is positional and honest; the row simply claims no membership, and is
excluded from every rollup.

**Rule P1-9**: `approvePlan` invoked on a planning task that itself carries a
phase, for a plan with no `phase` labels of its own, copies the planning task's
phase onto every child. A re-plan inside a phase stays inside it.

### 1.5 Rollup — `SegmentStrip`, not a new bar

**Rule P1-10**: A phase's rollup is a `SegmentStrip`
(`apps/web/src/components/SegmentStrip.tsx:71`) over its member tasks, one
segment per member, ordered exactly as the rail orders them. Segment states are
the chain-strip semantics `docs/design/task-presentation.md` already defines
and `deriveChainPosition` already computes:

| Member state | Segment |
|---|---|
| `completed` AND `latestWorker.mergedAt` non-null | `filled` |
| `completed`, PR open (`mergedAt` null) | `half` |
| `cancelled` | `skipped` |
| anything else | `empty` |

The `half` state is the whole point, for the reason that document gives: the
claim gate requires completed AND merged, so a completed-with-open-PR member
looks finished and silently blocks everything downstream. A phase that reads
"3/3 done" while one PR is unmerged would reintroduce exactly the failure the
strip exists to catch.

**Rule P1-11**: The printed count beside the strip is `{filled} / {total}` —
filled only. A `half` member counts toward `total` and not toward the
numerator. No new bar component, no new fill vocabulary, no fractional glyph.

**Rule P1-12**: A phase is **complete** when every member is `filled` or
`skipped`. A phase is **live** when it is the lowest `missionPhaseIndex` with
at least one member that is not `completed`, `failed` or `cancelled`. At most
one phase is live; when every phase is complete, none is.

---

## 2. Work-kind and role as the glyph source

### 2.1 One helper, three mounts

**Rule K2-1**: The fallback chain is implemented exactly once, by a new
exported function `deriveWorkKind` in `apps/web/src/lib/task-presentation.ts` —
the module `docs/design/task-presentation.md` designates as the one derivation
module, and where `deriveTaskPhase`, `deriveChainPosition` and
`deriveTimestampLabel` already live.

```ts
deriveWorkKind(input: {
  kind: TaskKind | null            // tasks.kind
  roleSlug: string | null          // tasks.role_slug
  taskType: TaskType | null        // deriveTaskType()'s output, already computed
}): { glyph: string; label: string; source: 'kind' | 'role' | 'type' } | null
```

**Rule K2-2**: The input object has **no `title` field and no `description`
field.** This is the enforcement mechanism for §1.6's no-prose rule, and it is
mechanically checkable: the function cannot parse a title it is not given
(AC-9).

`deriveTaskType` (`packages/core/mission-helpers.ts:30`) does read a title, but
only to match bracketed prefixes the platform itself writes via `reviewerTitle`
— structured markers, not prose. Its output is passed **in**; the chain never
calls it with a raw title of its own.

**Rule K2-3**: Every surface that draws a work-kind calls `deriveWorkKind` and
nothing else. The complete list of mounts:

| Surface | File | Where |
|---|---|---|
| Mobile rail node | `apps/web/src/app/app/(protected)/missions/[id]/CondensedTimeline.tsx` | glyph column, §4.4 |
| Structure canvas node | `apps/web/src/app/app/(protected)/missions/[id]/StructureView.tsx` | `StructureNodeView`, §4.7 |
| Activity row | `apps/web/src/components/TaskCard.tsx` | `TaskTypeBadge`, mounted from `apps/web/src/app/app/(protected)/tasks/TaskGrid.tsx` |

**Rule K2-4**: `TaskTypeBadge` (`TaskCard.tsx:171`) is rewritten as a thin
renderer over `deriveWorkKind`'s return value, and the old three-entry glyph
table it read (retry/review/review-retry) is retired — its distinct glyphs are
not preserved; `review`/`review-retry` resolve through tier 3 to the analysis
glyph and `retry` resolves to nothing (§2.2, Rule K2-6). It stays a local function in
`TaskCard.tsx`; no component file is created or moved, per the zero-new-files
constraint `timeline-mobile-rail.md` §10 inherits from
`mission-structure-view.md`. The rail and the canvas render the returned glyph
inline; they do not import from `TaskCard.tsx`.

### 2.2 The chain, written once

**Rule K2-5**: Strict precedence, first non-null wins, no blending:

1. **`tasks.kind`** — one of the seven values in `TASK_KINDS`
   (`apps/web/src/app/api/tasks/route.ts:51`), mirrored on the column
   (`packages/core/db/schema.ts:1030`). → `source: 'kind'`.
2. **`tasks.roleSlug`**, mapped through the table in §2.3. An unrecognized slug
   maps to nothing and falls through — it does **not** guess. → `source: 'role'`.
3. **derived task type**: `review` and `review-retry` → the analysis glyph.
   `retry` → nothing, and falls through to (4). → `source: 'type'`.
4. **none** — returns `null`. The surface renders no glyph and reserves no
   space for one (§4.5).

**Rule K2-6**: Tier 3 deliberately drops `retry`. `TaskType` is a lineage
vocabulary, not a work vocabulary: `retry` says "this is a second attempt at
whatever its parent was", which is information the rail already encodes as an
outcome mark and an attempt disclosure (`timeline-mobile-rail.md` §6.4, §12).
Spending the glyph column on it would repeat one fact and hide another.

### 2.3 Role does not overlay — it resolves into the same vocabulary

**Decision: role neither replaces nor annotates the kind glyph. It is a
fallback tier that maps into the seven-kind vocabulary, and there is no
role-specific glyph anywhere.**

Justification:

1. **The column holds one character.** §4.4 allots 18px between the rail node
   and the title. IBM Plex Mono at 14px advances ~8.4px per character, so an
   18px column holds one glyph with padding and two glyphs with none — at which
   point the pair collides with the node to its left and the `▣N` badge to its
   right.
2. **Role only adds information where kind is absent.** Walk the seeded roles
   (`apps/web/src/lib/default-roles.ts:42`): `builder` implies engineering,
   `organizer` implies coordination, `researcher` implies research, `writer`
   implies writing, `analyst` implies analysis — in every one of those an
   overlay would print the same fact twice. The two roles that *do* say
   something the seven kinds cannot (`reviewer`, `spec-validator`) are exactly
   the roles whose tasks carry no `kind` today, so a fallback tier already
   delivers their information without spending the pixel. §3.2 then writes
   `kind` on reviewer tasks so they resolve at tier 1 anyway.
3. **An eighth glyph is a second vocabulary.** A reader who has learned seven
   shapes should not also have to learn which rows carry a role mark and what
   its absence means. The rail already identifies a reviewer row by its title
   (`[reviewer #1] …`) and by §6.4's outcome mark.
4. **One glyph per row is mechanically checkable.** AC-8 asserts exactly one
   glyph node per rail row; "annotate" has no equally crisp assertion.

**Rule K2-7**: The role→kind map, restricted to the seeded default roles:

| `roleSlug` | Resolves to |
|---|---|
| `organizer` | coordination |
| `builder` | engineering |
| `researcher` | research |
| `writer` | writing |
| `analyst` | analysis |
| `reviewer` | analysis |
| `spec-validator` | analysis |
| anything else | nothing — falls through to tier 3 |

**Rule K2-8**: The map is a literal table in `task-presentation.ts`, not a
lookup against `workspaceSkills`. A workspace-defined role is not guessed at:
it falls through. Reading the skills table here would put a database query
inside a pure presentation helper that three surfaces call per row.

### 2.4 The glyph vocabulary

**Rule K2-9**: Seven glyphs, one per kind. **No circles and no squares** — the
rail has already spent both: circles are task nodes in every fill state
(`timeline-mobile-rail.md` §7), and squares are non-task rail elements (the
goal root, and now the phase header, §4.2). A work-kind glyph that reused
either shape would be read as a node.

| Kind | Glyph | Family | Mnemonic |
|---|---|---|---|
| engineering | `◆` | diamond, filled | makes a thing you can run |
| research | `◇` | diamond, hollow | looks at a thing without changing it |
| analysis | `▲` | triangle, filled | delivers a judgment |
| design | `△` | triangle, hollow | proposes a shape |
| writing | `≡` | bars | lines of text |
| observation | `⋯` | dots | samples over time |
| coordination | `⇅` | arrows | moves work between others |

The system is teachable in one line: **filled produces an artifact, hollow
produces a proposal; diamonds make, triangles judge, bars write, dots watch,
arrows route.**

**Rule K2-10 (greyscale)**: The glyph carries no colour of its own — it
inherits the row's text colour. Every distinction above is silhouette, so the
vocabulary is identical in greyscale. No pair shares a silhouette at 14px:
filled/hollow differ in mass, and the four families differ in outline.

**Rule K2-11 (font coverage)**: These seven codepoints MUST render from the
app's configured mono stack without falling back to a glyph of a different
advance width, verified at 14px (AC-10). The rail already ships `⬡`, `◉`, `◌`,
`▣`, `▢`, `✗` and `⌃`/`⌄` through the same stack, so the mechanism is
established; this rule makes the check explicit rather than assuming it.

### 2.5 Population source (a) — `create_task`

**Rule K2-12**: The `kind` clause in the `create_task` tool description
(`packages/core/mcp-tools.ts:383`) is replaced. Current text:

```
kind? (coordination|engineering|research|writing|design|analysis|observation — shape of the work)
```

Replacement, verbatim:

```
kind (state it on every task — coordination|engineering|research|writing|design|analysis|observation): the SHAPE of the work, not its subject. engineering changes code or config; research reads and reports without changing anything; writing produces prose or docs; design produces a visual or interaction artifact; analysis derives a judgment from data; observation watches something and records what it saw; coordination plans, routes or reconciles other tasks. It picks the model tier at claim time AND it is the only thing any surface draws this task's glyph from — a task filed without it is unlabelled on every screen for the rest of its life, and nothing infers it later from the title.
```

The `?` is dropped from the parameter marker. The field stays optional in the
schema; the description stops presenting it as an afterthought.

**Rule K2-13**: `kind` does **NOT** become a hard 400 for mission tasks.

Justified against the `pathManifest` precedent the brief invokes. That gate
(`apps/web/src/app/api/tasks/route.ts:957-980`) fires only when
`outputRequirement === 'pr_required'` is set **explicitly**, and its own
in-code comment records why it was narrowed to that: firing it on the default
`auto` "made the manifest demand fire for the common case of
investigation/friction/bookkeeping-shaped mission tasks", which is documented
as having produced a friction report. A `kind` gate has no equivalent narrow
trigger — `kind` is meaningful on every task — so it would fire on all of them,
including the `[friction]` filing an agent makes *while already failing*, which
is the caller least able to absorb a rejection and retry.

**Rule K2-14**: Instead, two levers that cost nothing on the failure path:

1. **Required in the plan schema.** `kind` joins `ref`, `title` and
   `description` in `planningOutputSchema`'s `required` array
   (`packages/shared/src/planning.ts:149`). This is where the volume is —
   plan-generated mission tasks — and the SDK enforces it at generation time,
   so it cannot produce a runtime rejection at all. The vocabulary is already
   a closed enum in that schema, and `POST /api/tasks` already 400s an
   out-of-vocabulary value (`route.ts:436`), so the two ends agree.
2. **An advisory gate event.** A mission task created with no `kind` fires
   `fireGateEvent` with `outcome: 'warned'` under a new slug `KIND_ABSENT` in
   `GATE_SLUGS` (`packages/core/gate-events.ts:44`). Nothing is rejected. The
   value is measurement: `get_failure_analytics family="gate"` then reports how
   often the field is skipped and by which caller origin, which is the evidence
   a future decision to harden it would need. `PROSE_GATE` is the precedent for
   an advisory-only gate slug.

### 2.6 Population source (b) — worker self-classification

**Rule K2-15**: `update_progress` gains an optional `kind` parameter, same
closed vocabulary. Not `complete_task`: a kind learned at completion is too
late for the claim-time model router (`packages/core/model-router.ts` reads
`kind` × `complexity`), too late for anyone watching the rail while the task
runs, and arrives after the row has already rendered unlabelled for its whole
life. `update_progress` is the first call most workers make.

**Rule K2-16**: The write is a single atomic guarded update — in Drizzle terms,
an `UPDATE tasks SET kind = $1 WHERE id = $2 AND kind IS NULL`, following the
optimistic-lock pattern this codebase uses in place of interactive
transactions. It never overwrites a non-null value, and a worker that reports a
kind for an already-classified task gets a no-op, not an error (AC-13).

**Rule K2-17**: The prompt asks for it **only when `tasks.kind IS NULL`.**
`buildPromptWithComposition` (`apps/runner/src/prompt-builder.ts:287`) already
receives the task as `BuilddTask`, which carries `kind`
(`apps/runner/src/types.ts:487`), so the condition is local and costs no
query. Text emitted only in that branch:

> This task has no recorded work-kind. On your first `update_progress`, set
> `kind` to the shape of the work you are actually doing — one of
> coordination, engineering, research, writing, design, analysis, observation.

**Rule K2-18**: The value is read at the next render of any surface in §2.1.
It is **not** re-read by the model router: the model was chosen at claim, and
re-routing a running worker is not a thing this spec introduces.

### 2.7 Population source (c) — `create_pr` as a late signal

**Rule K2-19**: `POST /api/github/pr` — the route backing the `create_pr` MCP
action (`packages/core/mcp-tools.ts:1730`) — writes `kind = 'engineering'`
when the originating task's `kind IS NULL`, using the same guarded update as
Rule K2-16, at the same point in the handler that stamps the worker's PR
fields.

**Decided as a write, not a render-time derivation.** The alternative — a
fourth input to `deriveWorkKind` meaning "this task has a PR" — was rejected
because:

1. It makes the database and the screen disagree. Every non-UI consumer
   (`get_usage_stats`, exports, a future `groupBy=kind`, the router on a
   retry of this task) would still see NULL, and the next surface built would
   have to re-derive the same rule or silently omit it.
2. The chain in §2.2 is specified as the single written-once derivation. A
   fourth tier that is not a stored field is a second rule wearing the first
   rule's name.
3. "This task opened a PR, so it changed code" is a **fact learned late**, not
   a presentation concern. Late-learned facts belong in the column.

The clobber risk that motivates a derivation is removed by the guard, and the
three sources compose into one invariant:

**Rule K2-20 (monotone write)**: `tasks.kind` is written **at most once**, by
whichever of filer → worker → PR-open reaches it first with a non-null value,
and is never overwritten by any of them afterwards. There is no code path that
changes a non-null `kind` except an explicit human `update_task`.

---

## 3. Reviewer as a role; builder implies review

### 3.1 Reviewer runs are not roleless — the aggregation folds them

The field observation says reviewer runs "appear roleless". They are not.

**`createReviewerTask` sets a role.** At
`apps/web/src/lib/reviewer.ts:499` the insert reads `roleSlug: reviewerRole`,
where `reviewerRole` is the slug named by `agentReview.reviewerRole` in the
workspace merge policy (`apps/web/src/lib/merge-policy.ts:14`), conventionally
`reviewer`. And `reviewer` is already a **seeded default role** —
`apps/web/src/lib/default-roles.ts:401`, alongside `writer`, `analyst` and
`spec-validator`, seeded by `seedDefaultRoles`. (The project CLAUDE.md's
"Default roles: Organizer, Builder, Researcher" is stale on this point.)

**The invisibility is in the rollup.** `aggregateByTask`
(`apps/web/src/lib/usage-stats.ts:396`) buckets worker rows by

```
const key = row.parentTaskId ?? row.taskId ?? `worker:${row.workerId}`;
```

and the bucket's `roleSlug` is taken from whichever row created the bucket. A
reviewer task carries `parentTaskId = originalTaskId` and
`taskClass: 'attempt'` (`reviewer.ts:506-507`), so every reviewer worker is
folded into its **parent's** bucket — charged, correctly, to the task whose
completion it was part of, but also *labelled* with the parent's role. The
parent is a builder task or an unassigned one. A `reviewer` group is therefore
never formed, which is exactly what §0.1 observes.

This is deliberate behaviour for cost ("tokens per task must be the cost of
getting the task done, retries included" — `usage-stats.ts:39-42`) and an
accident for role.

### 3.2 What changes

**Rule R3-1**: `createReviewerTask` additionally sets `kind: 'analysis'` on the
reviewer task. Tier 1 of §2.2 then resolves for every reviewer row without
falling through to role or type, and the reviewer's usage becomes groupable by
work-kind independently of the role fix below.

**Rule R3-2**: Role attribution is separated from cost attribution. The
per-task cost rollup in `aggregateByTask` is **unchanged** — an attempt's
tokens still land in the parent's bucket. The role histogram instead groups
each **worker row by its own task's `roleSlug`**, so one parent bucket can
contribute to two role groups: its own, and `reviewer` for the review pass it
contains. Cost per task and work per role are different questions and stop
sharing one grouping key.

**Rule R3-3**: Neither change invents a role. `createReviewerTask` keeps
reading the slug from the merge policy; nothing writes `roleSlug` by inference
from `kind`, from a title, or from anything else. §3.4 explains why that
restraint matters.

### 3.3 Builder-produces-PR implies review — the hook already exists

**Rule R3-4**: The programmatic review pass for a builder task that opens a PR
is the **existing `agent-review` merge-policy tier**, fired on PR open at
`apps/web/src/app/api/github/pr/route.ts:103`, which calls
`createReviewerTask` after `findLiveReviewerTaskForHead` dedupes against an
in-flight review for the same head SHA. `resolveEffectivePolicyForPR`
(`apps/web/src/lib/workspace-policy.ts`) decides whether it fires.

**No second trigger is designed by this spec, and none is needed.** The
behaviour the brief asks for is already shipped; what was missing was never the
trigger but the *legibility* of its output, which is Rules R3-1 and R3-2. Any
new trigger would race the existing one through the same dedupe.

### 3.4 What this does to `(unassigned)`, and what stays there legitimately

Against the §0.1 baseline (a large majority of tasks unassigned):

Rule R3-2 reclassifies every worker whose own task carries a `roleSlug` into
that role's group. Reviewer workers are the largest identifiable set — every
merged PR in an `agent-review` workspace has at least one — and they currently
contribute to a builder-or-unassigned parent bucket instead of a `reviewer`
one. **This spec does not state a post-change number**, because the residual
depends on how many unassigned buckets are unassigned-parent-only versus
unassigned-parent-with-a-roled-attempt, which is not derivable from the
grouped output above. The build task that implements R3-2 MUST re-run
`get_usage_stats groupBy=role window=30d` and record the new split (AC-17).

What remains unassigned, legitimately:

| Class | Why it has no role |
|---|---|
| Heartbeat and bookkeeping tasks (`taskClass = 'bookkeeping'`) | Platform mechanics, not work anyone is assigned |
| Organizer echo / orchestrator-created coordination rows | Created by the system on the mission's behalf |
| Human quick-adds and `[friction]` reports | Filed by a person or an agent mid-failure, with no role in mind |
| `approvePlan` children whose `PlanStep.roleSlug` was absent | `approve-plan.ts:254` writes `step.roleSlug \|\| null` — the planner simply did not name one |

**Rule R3-5**: The last row is the largest lever and this spec deliberately
does **not** pull it. Making `roleSlug` required in `planningOutputSchema`, or
deriving it from `kind`, would write a slug the workspace may not have
registered — and the claim query filters `or(isNull(tasks.roleSlug),
inArray(tasks.roleSlug, availableSkills))`
(`apps/web/src/app/api/workers/claim/route.ts:488-490`). A guessed slug no
runner advertises makes the task permanently unclaimable. Trading an unlabelled
task for a stranded one is not an improvement. The glyph chain (§2.2) is
specified so that `kind` — which has no claim-time side effect — carries the
legibility instead.

---

## 4. Rendering rules for the mobile rail

Everything in this section is scoped, like `timeline-mobile-rail.md`, to the
render path below the `md` breakpoint (768px). Desktop Timeline is unchanged
except for the glyph column (§4.6).

### 4.1 The phase header row type

**Rule R4-1**: `buildRail` emits a fourth row type into `RailRow<T>`:

```ts
type RailPhase = {
  kind: 'phase';
  id: string;
  index: number;
  label: string;
  segments: Array<{ taskId: string; state: SegmentState }>;  // §1.5
  filled: number;
  total: number;
  state: 'complete' | 'live' | 'upcoming';                    // Rule P1-12
};
```

`buildRail` stays pure (`condensed-timeline.ts:550`): phases enter as data on
the task objects, not as component state, and the header rows are computed in
the same pass that inserts ticks.

**Rule R4-2**: A phase header is emitted immediately **before the first node
whose `missionPhaseIndex` opens that phase**, walking the ordered node list.
Each index emits exactly one header, in ascending index order. A node with
`missionPhaseIndex = NULL` never emits a header and never suppresses one
(§4.4).

### 4.2 Geometry

**Rule R4-3**: 34px row height. Columns at a 360px viewport:

```
12px rail gutter │ 16px square node │ 6px │ label (flex, truncate)
  │ 8px │ SegmentStrip maxWidth={72} height={4} │ 6px │ "{filled}/{total}" │ 12px pad
```

which leaves ~198px for the label — enough for `{index} · {label}` at IBM Plex
Mono 12px before truncation.

**Rule R4-4**: The node is a square, rendered by the existing
`RailNodeGlyph` with `shape="square"`
(`apps/web/src/components/SegmentStrip.tsx`) and the existing `RailGlyphState`
values — no new glyph state:

| Phase `state` | `RailGlyphState` |
|---|---|
| `complete` | `solid` |
| `live` | `dashed` |
| `upcoming` | `empty` |

**Rule R4-5**: The label is exactly `{index} · {label}` — the index is always
printed, including for a single-phase mission, so the header never reads as a
bare section title.

**Rule R4-6**: `SegmentShape`'s doc comment currently reads "the single square
is the mission's goal root". The square vocabulary now means **"not a task"**
and has two members: the phase header and the goal root. They are never
ambiguous — the goal root is always the last row on the rail and always
carries `Goal:` text; a phase header is never last and never does. This amends
`timeline-mobile-rail.md` Rule D5-1's "one deliberate break" prose (§5.1).

**Rule R4-7**: The phase header row is **inert**. It is not a link, not a
button, has no `aria-expanded`, and carries no disclosure. It does not collapse
its phase. This holds v3's rule — a tap leaves the page only from a row
standing for exactly one task — without adding a control to argue about, and
keeps AC-8's "exactly one glyph node per row" true of header rows too.

### 4.3 Ticks under phases

**Rule R4-8**: When the rendered row sequence contains **at least one phase
header**, day ticks are suppressed entirely and only the `now` tick renders.

Justified: a phase header and a day tick are both full-width separator rows. A
four-phase mission spanning six days would emit ten separators over a dozen
nodes, and the reader would be asked to hold two independent segmentations of
the same list. Phases are the mission's own unit of progress and are stable;
calendar days are incidental to it. When there are no phases, `timeline-mobile-rail.md`
Rule D4-3/D4-4 applies unchanged and day ticks render exactly as today.

**Rule R4-9**: The `now` tick always survives, because it encodes something no
phase header does: the boundary between what has run and what has not
(Rule D4-5 — nodes above are filled, below are hollow).

**Rule R4-10**: When the `now` boundary and a phase-header boundary fall at the
same position, the order is **`now` tick first, then the phase header**. The
phase header belongs to the work below it; `now` separates past from future and
must not be pushed inside a phase it does not belong to. This is the only case
in which two separator rows render adjacently, and no third separator can join
them (day ticks are suppressed whenever a header exists, Rule R4-8).

### 4.4 The kind glyph column

**Rule R4-11**: On a node row the glyph occupies 18px between the rail node and
the title, filled from `deriveWorkKind` and nothing else.

**Rule R4-12**: The glyph is **outside** every interactive control — it is a
sibling of the title link and of the `▣N` disclosure button, never a
descendant, and it is `aria-hidden` with the row's accessible name carried by
the button or link text. This preserves v3's rule that the badge-plus-title
button is the disclosure and the only thing a tap can resolve to; a glyph
inside the button would widen the hit box with a target that means nothing.

**Rule R4-13**: On a collapsed chain row, the glyph is the **chain head's**,
because the title on that row is the head's title (`timeline-mobile-rail.md`
§1.3) and a glyph disagreeing with the title beside it would be a lie about the
same row. Note the resulting asymmetry with v3's Rule D1-5, where the *right*
column names the **terminal** PR: left is identity, right is outcome. Stated
here explicitly so a reader does not read it as an inconsistency.

**Rule R4-14**: Glyph and `▣N` badge coexist, in this order:

```
{node}  {glyph}  [ ▣N  {title} ]  {right column}
             └── inert ──┘ └─ one button (v3 §13.3) ─┘
```

A collapsed engineering chain therefore reads `◆ ▣3 {title}` — the shape of the
work, then how many tasks it took.

**Rule R4-15**: Expanded ordinal sub-rows each carry **their own** glyph, from
their own task. A chain whose members differ in kind shows that difference the
moment it is opened; that is the information the collapsed row necessarily
compresses.

### 4.5 Degraded renderings

**Rule R4-16 (no phases)**: A mission where no task has a
`missionPhaseIndex` renders **no phase headers**, and the rail is otherwise
byte-for-byte what `timeline-mobile-rail.md` v3 produces, except for the glyph
column. Day ticks render normally (Rule R4-8's condition is false). This is the
majority case today and it MUST have an assertion, not an assumption (AC-1).

**Rule R4-17 (phases, but a task with none)**: The node renders in its ordinary
rail position. It emits no header, is excluded from every phase's `segments`,
`filled` and `total`, and its position is not adjusted to sit near or away from
any phase. A task filed during phase 3 therefore *appears* within phase 3's
stretch, because that is where in time it happened — the rail states position,
which is true, and never claims membership, which would not be.

**Rule R4-18 (no kind, no role, no type)**: `deriveWorkKind` returns `null`, no
glyph node is rendered, and no placeholder, dot, or spacer character is drawn.

**Rule R4-19 (column reservation)**: The 18px column is reserved **per rail,
not per row**: if at least one node in the rendered sequence has a glyph, every
node row reserves 18px and titles stay aligned; if no node has one, the column
is zero-width and no title is indented. A mission with no kinds at all — the
current corpus — is not given a permanent empty gutter.

### 4.6 Desktop

**Rule R4-20**: Desktop Timeline gains the glyph column via
`TaskTypeBadge`'s rewrite (Rule K2-4) and **nothing else**. No phase headers,
no rail. `timeline-mobile-rail.md` §9's justification carries over unchanged:
desktop already has the Structure tab for shape questions, and a second
full-DAG renderer on the same viewport reopens the ambiguity that spec argues
against.

### 4.7 Structure canvas — glyphs yes, swimlanes no

**Rule R4-21**: `StructureNodeView`
(`apps/web/src/app/app/(protected)/missions/[id]/StructureView.tsx:123`) renders
the §2.4 glyph from `deriveWorkKind`, the same helper and the same vocabulary as
the rail. `StructureTask` (`apps/web/src/lib/structure-layout.ts:18`) gains the
three input fields the helper needs.

**Rule R4-22**: The canvas renders **no phase swimlanes, no phase bands, and no
phase labels.** Explicitly nothing, not "later".

Justified: `computeStructureLayout` assigns x by Sugiyama dependency rank. A
swimlane requires its members to be rank-contiguous, and phases are **not
guaranteed** to be — two phases share a rank whenever a later-phase task has no
edge into an earlier one, which is precisely what `approvePlan` produces when
the planner labels phases but declares no edge between them (`phase` and
`dependsOn` are independent fields on `PlanStep`, and nothing cross-validates
them). Drawing a band over a non-contiguous set either misstates the layout or
forces a re-rank, and a re-rank breaks `mission-structure-view.md` §2.2's
stability invariant — the reason that spec's layout is hand-rolled in the first
place.

**Named precondition for revisiting**: a phase band becomes drawable once
`computeStructureLayout` gains a rank-constraint pass that can require
same-phase nodes to occupy contiguous ranks without violating §2.2. That pass
is out of scope here and is not designed by this spec.

### 4.8 Reference layouts (360px)

Glyph key, extending `timeline-mobile-rail.md` §11: `●` done, `◉` running,
`○` queued, `◯` waiting-on-you, `▣N` collapsed chain badge, `▢` goal root,
`┄┄` now tick, `─` day tick; phase header nodes `◼` complete, `◻` live
(dashed in a real render), `□` upcoming; rollup segments `▪` filled, `▫` empty,
`▪̶` half. Kind glyphs per §2.4. ASCII cannot encode dash or colour; the legend
under each figure names what a real render carries.

#### 4.8.1 Four-phase mission, phase 3 live

```
360px ─────────────────────────────────────────────
 ◼  1 · Storage                       ▪▪      2/2
 ● ◆ Add missionPhase columns      #2461 merged
 ● ◇ Audit plan shapes             #2459 merged
 ◼  2 · Population                   ▪▪▪      3/3
 ▣3 ◆ Stamp phases in approve_plan  #2470 merged
 ◻  3 · Rendering                    ▪▫▫      1/3
 ● ◆ Phase header row               #2474 merged
 ┄┄ now · Wed 16
 ◉ ◆ Glyph column on the rail          running 8m
 ○ ▲ Verify greyscale at 14px              queued
 □  4 · Rollout                      ▫▫       0/2
 ○ ≡ Update the spec index                 queued
 ○ ⇅ Announce in the mission feed          queued
 ▢  Goal: all PRs merged · specs green     2 / 3
```

Legend: phase 3's node is **dashed** (live, Rule R4-4); phases 1–2 are solid,
phase 4 is an empty outline. No day ticks appear anywhere — suppressed by Rule
R4-8 — and the `now` tick sits **above** the rows it precedes, inside phase 3,
because phase 3 opened before now and is not re-opened by it. The rollup strips
are `SegmentStrip` at `maxWidth={72} height={4}`; `1/3` counts filled only
(Rule P1-11).

#### 4.8.2 Mission with no phases (Rule R4-16 — the majority case)

```
360px ─────────────────────────────────────────────
 ◯ ⇅ Approve plan: ledger slice 3               plan
 ┄┄ now · Sun 13
 ◉ ◆ BUILD: slice 3 dedupe index        running 12m
 ├╮
 │ ○ ▲ REVIEW: slice 3 dedupe index          queued
 ├╯
 ─  Sat 12
 ▣3 ◆ Ledger slice 2                  #2295 merged
 ─  Fri 11
 ● ◆ Wire the §4 delta gate            #2289 merged
 ▢  Goal: all PRs merged · tests green        2 / 3
```

Legend: identical to `timeline-mobile-rail.md` §11.4 **except** the 18px glyph
column. Day ticks `─ Sat 12` / `─ Fri 11` survive because no phase header
exists (Rule R4-8's condition is false). The reviewer row draws `▲` from
`kind: 'analysis'` (Rule R3-1).

#### 4.8.3 A phase header immediately above a collapsed chain

```
360px ─────────────────────────────────────────────
 ◼  2 · Population                     ▪▪▪      3/3
 ▣3 ◆ Stamp phases in approve_plan    #2470 merged  ⌄
 ◻  3 · Rendering                      ▪▫▫      1/3
```

Expanded, with members of differing kind (Rule R4-15):

```
360px ─────────────────────────────────────────────
 ◼  2 · Population                     ▪▪▪      3/3
 ▣3 ◆ Stamp phases in approve_plan    #2470 merged  ⌃
 ├─● ◇ 1 SPEC                               #2462
 ├─● ◆ 2 BUILD                               #2468
 ├─● ▲ 3 REVIEW                              #2470
 ◻  3 · Rendering                      ▪▫▫      1/3
```

Legend: the header row is inert (Rule R4-7) — the only control on either
figure is the chain's `▣3 {title}` button, which carries `⌄`/`⌃` per v3 §13.3
and never changes `location`. The collapsed row's `◆` is the **head's** glyph
(Rule R4-13) while its `#2470` is the **terminal** PR (v3 Rule D1-5); the
expanded sub-rows show the head was actually a `◇` spec step.

#### 4.8.4 A roleless reviewer row, before and after §3

**Before** — `kind` NULL, `roleSlug = 'reviewer'` set but unmapped, chain
reaches tier 3 via `deriveTaskType` on the `[reviewer #1]` prefix:

```
360px ─────────────────────────────────────────────
 ● ▲ [reviewer #1] Stamp phases…       #2470 merged
```

**After** §3 — `kind: 'analysis'` written at creation, chain resolves at tier 1:

```
360px ─────────────────────────────────────────────
 ● ▲ [reviewer #1] Stamp phases…       #2470 merged
```

Legend: **the rendering is identical, and that is the point.** The three tiers
agree on this row, so the glyph does not move; what changes is that the value
now comes from a stored column (`source: 'kind'`) instead of a title-prefix
match (`source: 'type'`), so it survives a title rewrite, it groups in
`get_usage_stats`, and it does not depend on `reviewerTitle`'s format. The
visible change from §3 is in the role histogram (Rule R3-2), not on the rail.

---

## 5. Migration note

### 5.1 `timeline-mobile-rail.md` rules this spec amends

| Rule | Effect |
|---|---|
| D4-3 / D4-4 (day ticks) | **Narrowed.** Day ticks render only when the row sequence contains no phase header (Rule R4-8). Unchanged for every mission with no phases. |
| D4-5 (`now` tick) | **Extended.** Rule R4-10 fixes ordering when the `now` boundary coincides with a phase boundary. The tick itself is unchanged. |
| D5-1 (goal root is "the one deliberate break" from circles) | **Prose amended.** Squares now mark *non-task rail elements* and have two members: phase header and goal root, disambiguated by position and label (Rule R4-6). The goal root's own rendering is unchanged. |
| §10.2 (element→implementation table) | **One row added:** phase header → `RailNodeGlyph shape="square"` + `SegmentStrip`, both existing. Still zero new component files. |
| `RailRow<T>` (§4 row vocabulary) | **One variant added:** `kind: 'phase'` (Rule R4-1). `node`/`tick`/`label` unchanged. |

### 5.2 `timeline-mobile-rail.md` acceptance criteria this spec touches

Numbering below follows the v2 file (AC-1…AC-32) merged on the rail mission
branch; v1 on trunk carries AC-1…AC-10 with the same meanings for the ACs named
here.

| AC | Status |
|---|---|
| TMR AC-5 (no `Today`/`Yesterday`/`Friday (2)` header; three tick rows instead) | **Split.** The negative half (no section headers, ever) survives unconditionally. The positive half (three tick rows) holds only for missions with no phases; a phased mission renders zero day ticks. AC-6 below is the phased counterpart. |
| TMR AC-1, AC-2 (chain collapse, `▣N`) | **Survive.** The glyph column is additive and sits outside the disclosure button (Rule R4-12). |
| TMR AC-8 (desktop unchanged) | **Narrowed.** Desktop gains the glyph column (Rule R4-20) and nothing else; every other clause survives verbatim. |
| TMR AC-6, AC-7 (goal root present / absent) | **Survive.** Phase headers never render at the rail's bottom and never substitute for the root. |
| TMR AC-3, AC-4, AC-9, AC-10 and all v2 criteria (AC-11…AC-32) | **Untouched.** |
| v3 (PR #2449, open) AC-33…AC-47 | **Untouched.** This spec adds no control to any rail row and removes none; Rule R4-7 makes the one new row type inert. |

### 5.3 Promotion to `active`

This spec is promoted from `draft` to `active` by the PR that lands tests for
the ACs below into `verified_by`. The expected guards are
`apps/web/src/lib/task-presentation.test.ts` (the §2 chain), a phase test in
`apps/web/src/lib/approve-plan.test.ts` (§1), and rail-model assertions in
`apps/web/src/lib/condensed-timeline.test.ts` (§4).

---

## Invariants

- `tasks.kind` is written at most once and never overwritten by an automated
  path (Rule K2-20).
- `missionPhaseIndex` and `missionPhaseLabel` are written only by
  `approvePlan` and by the attempt-inheritance copy in Rule P1-7, and are never
  updated after insert.
- No code path infers a phase or a work-kind from a task's title or
  description. `deriveWorkKind`'s input type has no title field.
- Exactly one glyph renders per rail row, or none — never two (Rule K2-9,
  Rule R4-12).
- A task with `missionPhaseIndex = NULL` contributes to no phase's rollup on
  any surface (Rule R4-17).
- The rail, the Structure canvas and the Activity row draw work-kind from one
  function; adding an eighth kind requires editing one table (Rule K2-3).
- A phase header row is never interactive and never changes `location`
  (Rule R4-7).
- Phase rollup fill uses the chain-strip vocabulary and no other: `filled`
  requires completed **and** merged (Rule P1-10).

---

## Acceptance criteria

**AC-1 (rejection — the majority case)**: GIVEN a mission in which no task has
a `missionPhaseIndex`, WHEN the Timeline renders below 768px, THEN NO phase
header row is emitted, day ticks render per `timeline-mobile-rail.md` Rule
D4-3, and the rail's row sequence is identical to the same mission's v3
rendering except for the glyph column.

**AC-2**: GIVEN a planning task whose plan has four distinct `phase` strings
across nine steps, WHEN it is approved, THEN the nine child tasks carry
`missionPhaseIndex` values 1–4 assigned in plan-array order, and every step
between two labelled steps carries the preceding label (Rule P1-4).

**AC-3 (rejection)**: GIVEN a plan in which no step carries a `phase`, WHEN it
is approved, THEN every child task has `missionPhaseIndex IS NULL` and
`missionPhaseLabel IS NULL`, and NO phase is derived from the plan's `dependsOn`
layering, its step count, or its titles (Rule P1-5, Rule P1-6).

**AC-4 (rejection)**: GIVEN a write that sets `missionPhaseIndex` without
`missionPhaseLabel`, or the reverse, WHEN it is attempted, THEN it is rejected
— the two columns are always both NULL or both set (Rule P1-2).

**AC-5**: GIVEN two tasks in one mission with the same `missionPhaseIndex` and
different `missionPhaseLabel` values, WHEN the rail builds, THEN exactly one
header is emitted for that index and the divergence is surfaced as a build-time
assertion failure, not silently resolved by picking one (Rule P1-2 note 3).

**AC-6**: GIVEN a mission with four phases spanning six calendar days, WHEN the
Timeline renders below 768px, THEN exactly four phase header rows and exactly
one `now` tick render, and ZERO day tick rows render (Rule R4-8).

**AC-7**: GIVEN a phase of three tasks in which one is completed-and-merged,
one is completed with an open PR, and one is pending, WHEN its header renders,
THEN the `SegmentStrip` shows `filled`, `half`, `empty` in rail order and the
printed count reads `1/3` — NOT `2/3` (Rule P1-10, Rule P1-11).

**AC-8 (rejection)**: GIVEN any rail row of any type, WHEN it renders, THEN at
most one work-kind glyph node is present in that row's subtree, and it is not a
descendant of any `<a>` or `<button>` (Rule K2-9, Rule R4-12).

**AC-9 (rejection — the title trap)**: GIVEN a task titled `BUILD: rewrite the
claim loop` with `kind IS NULL`, `roleSlug IS NULL` and `deriveTaskType`
returning `null`, WHEN it renders on any surface in §2.1, THEN NO glyph renders
— specifically NOT the engineering glyph — and no spacer character is drawn in
its place (Rule K2-2, Rule R4-18).

**AC-10**: GIVEN each of the seven glyphs in §2.4 rendered at 14px in the app's
mono stack, WHEN measured, THEN each occupies the same advance width as the
others and none falls back to a different-width glyph (Rule K2-11).

**AC-11 (rejection)**: GIVEN a task whose `roleSlug` is a workspace-defined
slug not in Rule K2-7's table and whose `kind IS NULL`, WHEN `deriveWorkKind`
runs, THEN tier 2 returns nothing and the chain falls through to tier 3 — it
does NOT guess a kind from the slug's text (Rule K2-8).

**AC-12 (rejection)**: GIVEN a task with `kind = 'research'`, WHEN a PR is
opened for it via `POST /api/github/pr`, THEN `tasks.kind` still reads
`'research'` afterwards — the late `engineering` signal never overwrites a
declared kind (Rule K2-19, Rule K2-20).

**AC-13**: GIVEN a task with `kind IS NULL`, WHEN a worker calls
`update_progress` with `kind: 'analysis'` and then a second worker calls it
with `kind: 'engineering'`, THEN `tasks.kind` reads `'analysis'` and the second
call returns success without an error (Rule K2-16).

**AC-14**: GIVEN a planning agent emitting a plan step with no `kind`, WHEN the
SDK validates against `planningOutputSchema`, THEN the output is rejected at
generation time because `kind` is in the schema's `required` array (Rule
K2-14).

**AC-15 (rejection)**: GIVEN a mission task created through `POST /api/tasks`
with no `kind`, WHEN it is created, THEN the request succeeds with HTTP 200 and
a `KIND_ABSENT` gate event with `outcome: 'warned'` is recorded — the request is
NOT rejected with a 400 (Rule K2-13, Rule K2-14).

**AC-16**: GIVEN a PR opened under a workspace whose merge policy tier is
`agent-review`, WHEN `createReviewerTask` inserts the reviewer task, THEN that
row carries `roleSlug` equal to the policy's `agentReview.reviewerRole` AND
`kind = 'analysis'`, and its `missionPhaseIndex` equals its parent's (Rule
R3-1, Rule P1-7).

**AC-17**: GIVEN a 30-day window containing at least one reviewer run, WHEN
`get_usage_stats groupBy=role` is called after Rule R3-2 lands, THEN a
`reviewer` group is present with a non-zero task count, AND the per-task cost
figures for the parent tasks are unchanged from before the change (Rule R3-2).

**AC-18 (rejection)**: GIVEN any task in the system, WHEN `roleSlug` is
examined after creation, THEN no code path has written it by inference from
`kind`, from a title, or from a role→kind map — only an explicit filer,
`PlanStep.roleSlug`, or the merge policy's reviewer slug (Rule R3-3, Rule
R3-5).

**AC-19 (rejection)**: GIVEN a mission with phases, WHEN the Structure tab
renders on desktop, THEN NO swimlane band, phase background, or phase label
appears on the canvas, and `computeStructureLayout`'s output is identical to
its pre-change output for the same input (Rule R4-22).

**AC-20**: GIVEN a mission with phases in which one task has
`missionPhaseIndex IS NULL`, WHEN the rail renders, THEN that task's node
appears in its ordinary position, no header is emitted for it, and it appears
in no phase's `segments` array (Rule R4-17).

**AC-21**: GIVEN a phase whose boundary coincides with the `now` boundary, WHEN
the rail renders, THEN the `now` tick row precedes the phase header row, and no
day tick renders between or around them (Rule R4-10, Rule R4-8).

**AC-22 (rejection)**: GIVEN a phase header row, WHEN a tap lands anywhere
inside its 360px width, THEN `location` does not change, no sheet opens, and no
`aria-expanded` attribute exists on any element in the row (Rule R4-7).

**AC-23**: GIVEN a collapsed terminal chain whose head has `kind` engineering
and whose third member has `kind` analysis, WHEN the row renders collapsed,
THEN the glyph is `◆` (the head's); WHEN it is expanded, THEN sub-row 3 renders
`▲` (its own) (Rule R4-13, Rule R4-15).

**AC-24**: GIVEN a mission in which no task resolves to a glyph, WHEN the rail
renders, THEN no node row reserves the 18px glyph column and every title begins
at the same offset as in the pre-change rendering (Rule R4-19).

---

## Code surface

- `packages/core/db/schema.ts` — `tasks`: new `missionPhaseIndex` /
  `missionPhaseLabel` columns and `tasks_mission_phase_idx`; existing `kind`,
  `roleSlug`, `category`, `parentTaskId`, `dependsOn`, `taskClass` read
  unchanged
- `packages/shared/src/planning.ts` — `PlanStep` (new `phase?: string`),
  `planningOutputSchema` (new `phase` property; `kind` added to `required`)
- `apps/web/src/lib/approve-plan.ts` — `approvePlan` (phase assignment, Rules
  P1-4/P1-9)
- `apps/web/src/lib/task-presentation.ts` — new `deriveWorkKind`; existing
  `deriveTaskPhase`, `deriveChainPosition`, `SegmentState` unchanged
- `packages/core/mission-helpers.ts` — `deriveTaskType`, `TaskType`,
  `stripTaskTypePrefix` (tier-3 input, unchanged)
- `apps/web/src/lib/condensed-timeline.ts` — `buildRail`, `RailRow`,
  `RailNode`, `RailTick` (new `RailPhase` variant, Rule R4-1)
- `apps/web/src/app/app/(protected)/missions/[id]/CondensedTimeline.tsx` —
  phase header row, glyph column (§4.2, §4.4)
- `apps/web/src/components/SegmentStrip.tsx` — `SegmentStrip`,
  `RailNodeGlyph`, `SegmentShape`, `RailGlyphState` (reused; only the
  `SegmentShape` doc comment changes, Rule R4-6)
- `apps/web/src/components/TaskCard.tsx` — `TaskTypeBadge`
  (rewritten over `deriveWorkKind`, Rule K2-4; the old per-type glyph table it read is removed)
- `apps/web/src/app/app/(protected)/missions/[id]/StructureView.tsx` —
  `StructureNodeView` (glyph only, Rule R4-21)
- `apps/web/src/lib/structure-layout.ts` — `StructureTask` (three new input
  fields); `computeStructureLayout` unchanged (Rule R4-22)
- `apps/web/src/lib/reviewer.ts` — `createReviewerTask` (adds `kind`, inherits
  phase, Rule R3-1/P1-7)
- `apps/web/src/app/api/github/pr/route.ts` — the `agent-review` PR-open hook
  (Rule R3-4) and the guarded `kind` write (Rule K2-19)
- `apps/web/src/lib/usage-stats.ts` — `aggregateByTask`, `UNASSIGNED_ROLE`
  (role histogram split from cost rollup, Rule R3-2)
- `apps/web/src/app/api/tasks/route.ts` — `TASK_KINDS` validation (unchanged),
  new `KIND_ABSENT` advisory gate (Rule K2-14)
- `packages/core/gate-events.ts` — `GATE_SLUGS` (new `KIND_ABSENT`)
- `packages/core/mcp-tools.ts` — `create_task` and `update_progress` tool
  descriptions (Rule K2-12, Rule K2-15)
- `apps/runner/src/prompt-builder.ts` — `buildPromptWithComposition`
  (conditional kind prompt, Rule K2-17)

---

## Out of scope

- The v3 chain-disclosure amendment to `timeline-mobile-rail.md` (PR #2449) —
  this spec adds no control and changes no tap target; Rule R4-7 keeps its one
  new row type inert.
- Planner decomposition strategy — how many steps a plan should have, and where
  a phase boundary *ought* to fall, is the planner's judgment. This spec
  specifies only how a boundary it declares is stored and drawn.
- `deriveStage()` fill semantics — node fill is `timeline-mobile-rail.md`
  Rule D7-1's business and is not touched. Phase header fill (Rule R4-4) is a
  separate, three-valued rollup state and is not a `Stage`.
- Desktop Timeline layout, the Structure canvas layout algorithm, and mobile
  gesture models — all inherited as out of scope from the specs in `related`.
- A `groupBy=kind` mode on `get_usage_stats`. Rules R3-1 and K2-20 make it
  possible; adding it is its own task.
- Backfilling `kind` or phases onto existing rows. Every rule here is
  write-forward, and §4.5's degraded renderings are what the existing corpus
  gets.
- Making `roleSlug` required or inferred anywhere (Rule R3-5).
