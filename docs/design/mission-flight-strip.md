---
status: partially
# Reconciled 2026-09-23 (AC-1 pass). All four assertions below pass, and each
# passes for the reason it names: computeMissionFlightStrip, FlightStrip.tsx,
# FlightDetailSheet.tsx, the flight_strip_cache migration + backfill script,
# and missions/page.tsx's cursor-based pagination have all genuinely shipped
# — as has essentially all of Implementation Breakdown items 2, 3a, 3b, 3c.
# AC-1 itself is now also satisfied: the pre-spec `computeMissionSkyline` /
# `SkylineBlock` / `MissionSkylineData` model is deleted (its one live
# consumer, the detail page's completed-mission stats row, now reads
# `computeMissionFlightStrip`'s own `agentTimeMin`/`axisSpanMin`/
# `parallelFactor`, §6). Status stays `partially`, not `implemented`, because
# one real gap survives that AC-1 never covered: Rule L-4's swap of
# computeMissionFlightStrip's lane source from `deriveWorkLane` to a
# `deriveWorkKind`-based Rule L-1 adapter hasn't happened. See
# "Implementation Status" below.
assertions:
  - id: "compute-mission-flight-strip"
    type: "symbol"
    name: "computeMissionFlightStrip"
    path: "packages/core/mission-helpers.ts"
  - id: "flight-strip-reachable-from-detail-page"
    type: "symbol_reachable"
    symbol: "computeMissionFlightStrip"
    entry: "apps/web/src/app/app/(protected)/missions/[id]/page.tsx"
  - id: "flight-strip-cache-migration"
    type: "migration"
    number: "172"
    contains: "flight_strip_cache"
  - id: "list-card-pagination-rule-p4"
    type: "symbol_reachable"
    symbol: "cursor"
    entry: "apps/web/src/app/app/(protected)/missions/page.tsx"
    as: "read"
---

# Mission Flight Strip: Chart Encoding, Detail Alignment, Performance

**Status:** Partially — see "Implementation Status" below.
**Related:** `packages/core/mission-helpers.ts` (`computeMissionFlightStrip`, `deriveWorkLane`), `apps/web/src/components/FlightStrip.tsx`, `apps/web/src/components/FlightDetailSheet.tsx`, `apps/web/src/lib/task-presentation.ts` (`deriveWorkKind`), `apps/web/src/lib/missions-query.ts`, `apps/web/src/lib/flight-strip-nav.ts`, `apps/web/src/app/app/(protected)/missions/page.tsx`, `apps/web/src/app/app/(protected)/missions/[id]/page.tsx`, `apps/web/src/app/app/(protected)/missions/[id]/MissionSettings.tsx`, `apps/web/src/lib/artifact-prominence.ts`, `docs/specs/mission-legibility.md`, mission-card-density spec (key `mission-card-density-spec` — not yet committed to `docs/design/`)

---

## Implementation Status (reconciled 2026-09-23)

If you were dispatched here to reconcile this doc again: check `git log -- docs/design/mission-flight-strip.md` first — the table below may already be current. It was as of task `b71ed5d3`'s re-verification (2026-09-23, zero drift from the reconciliation above): every symbol, line reference, and test cited in this doc still matches the code exactly. This doc's `compute-mission-flight-strip` / `flight-strip-reachable-from-detail-page` / `flight-strip-cache-migration` ledger rows will keep re-opening after every checker run regardless — they test narrow code facts (a symbol export, a route, a migration) that pass independently of Rule L-4, so they can never carry this doc's status to a terminal value on their own, and a `code_ahead` row whose fix doesn't reach terminal status releases its claim for redispatch. That's expected per spec-conformance.md's claim-release rule, not a doc bug. Only Rule L-4 actually landing (Implementation Breakdown item 1) moves the status to `implemented` and lets those rows close for good.

| Item | Status |
|---|---|
| 1 — Core model | **Partially.** `computeMissionFlightStrip` ships with Rules X-1–X-5, C-1–C-3, S-1–S-3, and A-1/A-2 all implemented and covered by `packages/core/__tests__/mission-flight-strip.test.ts` — including the per-`exitCause` classification test (AC-4/AC-5) and the literal 14-vs-15-minute elision test (AC-8). Rule P-1's `flight_strip_cache` migration (`0172_eminent_riptide.sql`) and Rule P-5's backfill script (`packages/core/scripts/backfill-flight-strip-cache.ts`) have also shipped. §6's `agentTimeMin`/`axisSpanMin`/`parallelFactor` are now exposed directly on `MissionFlightStripData`, computed from raw ms spans with Rule L-3 planning-tick spans excluded, and covered by `packages/core/__tests__/mission-flight-strip.test.ts`. AC-1 is satisfied: `computeMissionSkyline`, `SkylineBlock`, and `MissionSkylineData` are deleted from `mission-helpers.ts`, and the detail page's completed-mission stats row (`missions/[id]/page.tsx`) reads the flight strip's own metrics instead. **Not done:** Rule L-4 items (a)–(c) below — `computeMissionFlightStrip` still sources every bar's lane from `deriveWorkLane`, not a Rule L-1 table over `deriveWorkKind`, and `deriveWorkLane` has not been deleted. |
| 2 — SVG component | **Done.** `apps/web/src/components/FlightStrip.tsx` renders `MissionFlightStripData` (lanes, concurrency fill, failure fill, breaks, phase dividers, now-line, queued/dashed bars, fold summary), pure rendering with no data fetching. |
| 3a — List card wiring | **Done.** `missions/page.tsx` and `apps/web/src/lib/missions-query.ts` add the `roleSlug`/`exitCause` columns, the `mission_notes authorType='user'` steering aggregate, Rule P-2's cache-read branch for completed missions, and Rule P-4's `completedCursor` keyset pagination. |
| 3b — Detail page navigator | **Done.** `missions/[id]/page.tsx` pins `MissionFlightStripNav` under the title, groups the task list via `groupTasksByPhase` (`@/lib/flight-strip-nav`), selects the Records row via `selectMissionRecords`, summarizes the orchestrator row via `countOrchestratorPlans` + `schedule.totalChecks`, and relocates `MissionSettings` behind the overflow menu. |
| 3c — Flight detail sheet | **Done.** `apps/web/src/components/FlightDetailSheet.tsx` renders the expanded four-lane view over the same `MissionFlightStripData`. |

**One outstanding item:** finish Rule L-4 — add the Rule L-1 kind→lane adapter over `deriveWorkKind`, re-point `computeMissionFlightStrip` at it, and delete `deriveWorkLane`. Status stays `partially` until that lands.

---

## Problem

`computeMissionSkyline` (`packages/core/mission-helpers.ts`) plots mission
worker spans on a wall-clock x-axis, and `MissionSkylineChart` renders the
result as unlabelled colored rectangles. Three concrete failures:

1. **The chart doesn't exist where it's most wanted.** Both call sites —
   `apps/web/src/app/app/(protected)/missions/page.tsx:279-280` (list card) and
   `apps/web/src/app/app/(protected)/missions/[id]/page.tsx:1231` (detail) —
   gate the call on `status === 'completed'`. An active mission renders no
   chart at all.
2. **Wall-clock idle dominates the axis.** A mission that ran for many hours
   of wall-clock time but a small fraction of that in actual agent work
   renders almost entirely as empty space, and multi-minute task spans are
   frequently indistinguishable at the fixed 15-minute quantum
   (`SKYLINE_SLOT_MS`) — most bars collapse to the same 1-slot minimum width
   regardless of how long the task actually took.
3. **It silently misreported failure.** `workerBlockState` used to paint a
   block green (`merged`) unless `w.status === 'error'` — but the real worker
   status value for a failed run is `'failed'`, not `'error'`; `'error'` is
   not a value this codebase writes in ordinary operation. That specific
   string check has since been corrected independently of this design
   (`workerBlockState` now checks `status === 'failed'` —
   `packages/core/mission-helpers.ts:1222`, with
   `packages/core/__tests__/mission-helpers.test.ts:921-933` covering both the
   fixed case and the `'error'` non-case). The deeper problem this design
   actually fixes is coarser than a status-string typo: neither the old
   function nor a naive `status === 'failed'` check can tell a genuine
   failure (`exitCause: 'code_failure'`) from an interrupted-but-not-wrong
   exit (`exitCause: 'budget_limited'`, `'condition_unmet'`, ...) — Rule C-2
   below is what actually distinguishes them, and it ships only in the new
   model (`computeMissionFlightStrip`), covered by
   `packages/core/__tests__/mission-flight-strip.test.ts`'s per-`exitCause`
   classification test.

The design boards for this mission (three `.dc.html` boards copied into
mission artifacts `design:flight-strip/missions-list`,
`design:flight-strip/mission-detail`, `design:flight-strip/flight-detail-sheet`)
propose a different chart: a "flight strip" plotting kind-of-work lanes against
an idle-elided agent-time axis, with a separate rail for who or what steered
the mission. This spec settles the parts of that encoding the boards leave
ambiguous, and aligns the mission detail page around the strip as its
navigator.

---

## Proposal

**The crux:** today's chart has no notion of "this data point is a steering
event, not work" — every worker span, including the orchestrator's own
planning cycles, is plotted as if it were equally substantive. Once that
distinction is drawn correctly (§3), the axis, the derived metrics, and the
lane assignment all fall out of it cleanly. Get the distinction wrong — e.g.
by inferring "ran a model" from a heuristic instead of the platform's existing
dispatch guarantee — and the steering rail silently reintroduces the exact
noise problem (`recon artifact recon:flight-strip-feasibility` finding: an
orchestrator's own housekeeping cycles can outnumber the mission's actual work
tasks) it exists to remove.

This is a **rewrite of the model**, not a restyle of the component — both the
x-axis semantics and the y-axis semantics change. `computeMissionSkyline`,
`SkylineBlock`, `MissionSkylineData`, and `MissionSkylineChart.tsx` are
retired, not extended.

### 1. Lanes (Y)

**Source of truth: `deriveWorkKind`, unmodified.** `docs/specs/mission-legibility.md`
already specifies and ships the single derivation every surface must use for a
task's shape of work — `apps/web/src/lib/task-presentation.ts:254`, strict
precedence `tasks.kind` → `tasks.roleSlug` (mapped through `ROLE_TO_WORK_KIND`)
→ derived task type (`review`/`review-retry` only) → `null`. This spec adds no
second derivation and reads no title or description; it adds exactly one new
mapping downstream of that helper's result.

**Rule L-1 (kind → lane):** a new table, colocated with `deriveWorkKind` in
`task-presentation.ts` (same "one derivation module" doctrine
`mission-legibility.md` §2.1 states):

| Work kind | Lane | Why |
|---|---|---|
| `engineering` | BUILD | changes code or config — the only kind that does |
| `analysis` | CHECK | delivers a judgment — review, verification |
| `observation` | CHECK | watches and records an outcome — verification-shaped |
| `research` | THINK | reads and reports, no change yet |
| `design` | THINK | proposes a shape, no change yet |
| `writing` | THINK | produces prose/docs, not runnable output |
| `coordination` | THINK | routes and plans, no change yet |
| *(`deriveWorkKind` returns `null`)* | UNCLASSIFIED | see Rule L-2 |

**Rule L-2 (degrade, never mislabel):** a task whose kind cannot be resolved
does not get silently dropped and does not get silently folded into BUILD. It
renders as a distinct band spanning all three lane tracks at reduced height,
with a flat fill (`#6f6a60`) that shares no color with any lane's concurrency
tiers — visibly "present but unclassified," never asserting a lane membership
the data doesn't support. Its agent time still counts toward the mission's
total (§6); a task with no resolvable kind still did real work.

**Rule L-3 (orchestrator/heartbeat tasks never occupy a lane):** a task
created by a mission's schedule tick — `creationSource IN ('schedule',
'orchestrator')` AND `mode = 'planning'` — is excluded from lane assignment
entirely, regardless of what `deriveWorkKind` would return for it (some of
these are literally `kind = 'coordination'` tasks). It is represented
exclusively on the steering rail (§3) as an orchestrator mark. This is the
one deliberate exception to "read `deriveWorkKind` and nothing else" for lane
purposes, and it exists because these tasks are not mission work in the sense
the strip measures — they are the mechanism deciding what mission work to
create next. A human-filed coordination task (creation source `dashboard`,
`api`, or `mcp`) still plots normally in THINK.

**Rule L-4 (reconciling with the already-shipped `deriveWorkLane`):** before
this spec revision landed, a sibling task shipped `deriveWorkLane(task)` in
`packages/core/mission-helpers.ts` — its own five-rung precedence chain
(`taskClass === 'attempt'` → `roleSlug` → `kind` → title-shape matching →
`null`) answering the same "what lane is this task" question `deriveWorkKind`
already answers, in direct conflict with this rule's "adds no second
derivation and reads no title or description." `deriveWorkLane` is not sitting
idle: the shipped `computeMissionFlightStrip` reads it directly for every
bar's lane, and the shipped SVG renderer (`FlightStrip.tsx`) and the mission
detail page / flight-detail-sheet wiring render off `computeMissionFlightStrip`'s
output, so all three already depend on `deriveWorkLane`'s classification
today. **`deriveWorkLane` is superseded by Rule L-1** — `deriveWorkKind`
remains the one precedence chain every surface reads, per
`mission-legibility.md` §2.1 — but its removal is no longer the isolated
deletion implementation-breakdown item 1 originally described. `deriveWorkKind`
returns a glyph-shaped `WorkKindResult | null`, not a lane string, and has no
visibility into `taskClass` or task titles, so Rule L-1's table cannot be a
drop-in swap: it needs its own adapter over `deriveWorkKind`'s result, and
`computeMissionFlightStrip` plus its two downstream renderers need to be
re-pointed at that adapter's output before `deriveWorkLane` can come out.
Item 1, below, is updated accordingly.

### 2. Axis (X)

**Rule X-1 (built from raw spans, not slots):** the axis is built from the
same primitive `computeMissionSkyline` already uses — each worker's
`[startedAt, endMs)` wall-clock span, where `endMs` falls back
`completedAt → updatedAt → now` exactly as `workerEndMs` does today — with
orchestrator/heartbeat spans excluded per Rule L-3. Concurrency and lane
packing (§4) are computed on these raw millisecond spans, using the same
sweep-line and greedy-packing approach `computeMissionSkyline` already
implements; only the rendered x-coordinates are remapped onto the compressed
axis afterward. Computing overlap on the compressed axis instead of raw time
would be wrong: two bars that render adjacently after elision are not
necessarily concurrent in wall-clock time.

**Rule X-2 (elision threshold = 15 minutes):** a gap between the end of one
span and the start of the next is elided from the axis — contributes zero
pixels — when it is **≥ 15 minutes** (reusing the existing `SKYLINE_SLOT_MS`
value, so the platform keeps one "quantum of meaningful time" constant rather
than introducing a second one). An elided gap renders the design's break glyph
(two short diagonal strokes) labelled with its real duration (e.g. `7h
idle`). A gap **< 15 minutes** is merged silently — no glyph, no pixels —
since at that scale it is scheduling noise, not a story worth telling on a
390px card.

**Rule X-3 (phase dividers come from the stored fact, not a derivation):**
`docs/specs/mission-legibility.md` §1 already ships `tasks.missionPhaseIndex` /
`tasks.missionPhaseLabel`, written once by `approvePlan` from the plan's own
`phase` field, with an explicit rule (P1-6) that no phase is ever inferred
from a title or from `dependsOn` layering. This spec **uses that column
directly** as the phase-divider source, which supersedes the recon artifact's
proposed fallback derivation from elided-gap boundaries — that fallback was
proposed before checking whether a stored phase fact existed; it does, and a
stored fact beats a heuristic. A dashed vertical divider is drawn at the
compressed-axis boundary between the last bar of `missionPhaseIndex = N` and
the first bar of `N + 1`. A mission where every task has `missionPhaseIndex
IS NULL` renders **zero** dividers and zero `P1`/`P2`/… labels — this is the
majority case today and must not regress to drawing a false phase boundary.
A phase boundary and an idle-gap break glyph are independent and may or may
not coincide; when they do, the label combines both (`7h idle · P2`, per the
missions-list board), matching the board's own combined string exactly.

**Rule X-4 (unphased tasks render positionally, not excluded):** a task with
`missionPhaseIndex IS NULL` inside an otherwise-phased mission renders in its
ordinary chronological position on the rail — it is simply excluded from any
phase's membership count. This mirrors `mission-legibility.md` Rule P1-8's
treatment of the identical case on the mobile rail; the flight strip must not
invent a second rule for the same fact.

**Rule X-5 (fold on segment count, not pixel width):** SVG renders sub-pixel
widths fine, so the binding constraint on a very long mission (tens of tasks
in one lane) is legibility, not overflow. When a single lane would render
more than **12** distinct bar segments, the chronologically last segments
beyond the 12th collapse into one hatched summary block (reusing the
repeating-linear-gradient seam technique `MissionSkylineChart` already applies
to multi-slot blocks) sized to their combined agent time, with a trailing
`+N` count label. 12 is a starting cap, not derived from a load-bearing
constraint — revisit if real mission shapes show it clipping the common case.

### 3. Steering rail

Two glyphs only, per the boards: an `#e0873a` filled diamond (a human
intervention) and a hollow square with `#9a9488` stroke (an orchestrator cycle
that ran a model). **Deterministic heartbeat ticks are never drawn — and this
is not a filter this spec has to invent, because the platform already
guarantees it structurally:**

**Rule S-1 (human diamond):** one per `mission_notes` row with `authorType =
'user'` (`packages/core/db/schema.ts:1843`), positioned at that row's
`createdAt` on the compressed axis. A note landing inside an elided gap snaps
to the near edge of that gap's break glyph rather than floating in dead
space that no longer exists on the rendered axis.

**Rule S-2 (orchestrator hollow square):** one per task row where
`creationSource IN ('schedule', 'orchestrator')` AND `mode = 'planning'` AND
the task has at least one worker with `startedAt` set — positioned at that
worker's `startedAt`. The `startedAt` requirement is the proof the cycle
actually reached an LLM, not just that a schedule tick fired.

**Rule S-3 (why no separate "is this a heartbeat tick" flag is needed):** the
heartbeat prepass in `apps/web/src/app/api/cron/schedules/route.ts:584-688`
(backed by `classifyMissionWait` in `apps/web/src/lib/heartbeat-prepass.ts`)
already decides, before any model is invoked, whether a tick is
`skip_complete` / `skip_waiting` / `skip_blocked` / `skip_no_change`. Every
one of those branches writes only to `taskSchedules.lastDeferralReason` and
returns — **no task row is ever created.** So "no planning-task row for this
tick" already and exactly means "no model ran"; Rule S-2's query needs no
additional exclusion logic, because the absence of a row is the platform's own
signal. This is the direct fix for the crux stated above: today's
`MissionSkylineChart` has no equivalent of Rule S-2 at all, so a mission whose
orchestrator ticks frequently but rarely needs to act would (if its cycles
were naively counted as work) read as far busier than it is.

### 4. Concurrency and failure

**Rule C-1 (three-tier fill, unchanged tokens):** for each rendered bar,
compute the peak number of *other* bars (in different lanes, including
UNCLASSIFIED) whose raw wall-clock span overlaps it at any instant, using the
same ms-based sweep-line `computeMissionSkyline` already implements. Map to:

| Overlap | Fill |
|---|---|
| alone (1) | `#4f8a6b` |
| with 1 other (2) | `#8fd9b0` |
| with 2+ others (3+) | `#c4f2d8` |

**Rule C-2 (failure is a cause, not a status):** a bar renders the failure
token `#d2584b` when `worker.status === 'failed'` **AND**
`worker.exitCause IN ('code_failure', 'infra_failure')`
(`packages/core/db/schema.ts:1478`). This replaces `workerBlockState`'s
`w.status === 'error'` check — the concrete bug in §Problem — with the field
that actually distinguishes a real failure from a non-failure exit. Every
other terminal `exitCause` (`budget_limited`, `condition_unmet`, `reassigned`,
`sandbox_mount_gap`, `needs_input`) keeps its ordinary concurrency-tier fill:
none of those mean the work was wrong, only that it was interrupted. The
legend label is simply "Failed" — this spec does not condition the color on
whether a retry was later filed, since the color describes what happened to
this span, and a retry (if any) is a separate, later bar.

**Rule C-3 (no-op spans are not spans):** a worker whose `exitCause` is
`never_started` or `silent_start` contributes no bar at all — no real elapsed
work occurred, so there is nothing to plot, and including a zero-content bar
would misstate agent time (§6).

### 5. Active missions

**Rule A-1 (now-line):** for a mission with `status` not yet terminal, a
solid `#f0a05a` line (width 1.5) is drawn immediately after the rightmost real
point on the compressed axis — i.e. at the end of the last non-idle span.
There is no "current time projected forward" — the line marks where real
elapsed agent time stops, which is also where §2's elision logic would
otherwise start eliding an open-ended gap.

**Rule A-2 (queued bars):** every task in `pending`/`assigned` status with no
worker `startedAt` yet renders as a dashed hollow rect (`stroke #6f6a60`,
`stroke-width 1`, `stroke-dasharray "3 2"`) in its derived lane (Rule L-1/L-2),
positioned after the now-line in queue order. Its width is an estimate, not a
measurement — since no duration exists yet — set to the mission's own mean
completed-bar agent time so far, or to the 15-minute elision threshold (Rule
X-2) when the mission has no completed bars yet. The dashed/hollow rendering
is the signal that this width is not real time.

### 6. Derived metrics

Excluding orchestrator/heartbeat spans (Rule L-3) from the model changes three
numbers that used to be computed over every worker span indiscriminately:

- **`agentTimeMin`**: sum of the durations of rendered work-lane bars only —
  BUILD + THINK + CHECK + UNCLASSIFIED. Orchestrator/heartbeat cycle time is
  excluded, matching the intent that this number answers "how much mission
  work happened," not "how much total compute ran."
- **`axisSpanMin`**: the total length of the compressed (idle-elided) timeline
  — the wall-clock span of the *union* of work intervals, not a sum (so
  overlapping concurrent bars don't inflate it). This is the direct
  replacement for the old `activeSpanMin`, which measured raw wall-clock span
  including all the idle this spec now elides.
- **`parallelFactor`**: unchanged formula shape, `agentTimeMin / axisSpanMin`
  — both terms are simply redefined per above. A mission with no concurrency
  still reports ~1.0×; the metric's meaning at a glance doesn't change, only
  what it's computed over.
- **`peakConcurrency`**: unchanged sweep-line peak (Rule C-1), computed over
  the same excluded-orchestrator span set.
- **`HUMAN %`** *(new)*: `humanDiamondCount / (humanDiamondCount +
  orchestratorSquareCount)` — the fraction of steering events on the rail
  that were a person, as opposed to an autonomous cycle. This metric is only
  meaningful once orchestrator ticks are counted correctly (Rule S-2/S-3); it
  did not exist as a shippable number before this spec because "how many
  autonomous cycles happened" had no reliable source. It is exposed as a
  computed field on the flight-strip payload; this spec does not mandate a
  specific card slot for it — the flight-detail sheet's existing stat grid
  (§7) is the natural first home.

### 7. Detail page alignment

The mission detail page (`apps/web/src/app/app/(protected)/missions/[id]/page.tsx`)
reorganizes around the strip as its navigator, per the `design:flight-strip/mission-detail`
board:

- **Strip as navigator.** The strip renders pinned directly under the title
  (`role="img"`, same SVG geometry as the card, wider). Tapping a bar scrolls
  the task list to that task's row and outlines both the bar and the row
  simultaneously — reusing the existing outline/selection visual vocabulary,
  no new state is introduced beyond "which task is focused."
- **Task list grouped by phase.** Groups are keyed by `missionPhaseIndex` /
  `missionPhaseLabel` (Rule X-3); a mission with no stored phases renders one
  ungrouped list, unchanged from today. Each row is tagged with its lane
  (THINK/BUILD/CHECK) label, derived the same way as the bar it corresponds
  to (Rule L-1/L-2) — one source, two renderings.
- **Goal criteria collapse into the Verified pill.** No new disclosure
  mechanism: this reuses the bottom-sheet mechanism the mission-card-density
  spec §2 already specifies for the Verified pill tap. This spec adds nothing
  to that contract; it just removes the separate always-visible goal-criteria
  block from the detail page now that its content has a home.
- **Per-task artifacts on the task row.** Each task row inlines a compact
  link to its own artifacts (via `list_artifacts` scoped to that task), rather
  than a page-level artifact list.
- **Mission-level "Records" row gated by `review: true`.** Whether an artifact
  additionally earns a spot in the page-level "Records" link row is decided
  by the same predicate the platform already uses for "artifacts worth a
  human's attention" — `isReviewArtifact` in
  `apps/web/src/lib/artifact-prominence.ts`, the same rule `list_artifacts
  review: true` applies (`packages/core/mcp-tools.ts:389`). Captures
  (screenshots, diffs, machine markers) never surface at the mission level;
  they stay on their task row only.
- **Orchestrator runs as one row.** The "Orchestrator · N plans, M ticks" link
  summarizes rather than lists: `N` is the count of Rule S-2 hollow-square
  events (planning tasks that ran a model), `M` is the schedule's own
  `taskSchedules.totalChecks` (every tick, including deterministic skips).
  Both numbers come from data the platform already tracks; nothing new is
  computed here beyond counting what Rules S-2/S-3 already define.
- **Archive/Delete move behind the overflow menu.** The existing
  `MissionSettings` component (mounted today at
  `apps/web/src/app/app/(protected)/missions/[id]/page.tsx:1294`, rendered
  inline near the page bottom) is relocated — unmodified in its own logic —
  behind the header's "⋮" button, opened in the same bottom-sheet mechanism as
  the Verified pill. No new archive/delete code path; only where it's
  triggered from changes.

### 8. Performance

**The problem today:** `missions/page.tsx:116` loads **every** mission in the
workspace via one unpaginated `db.query.missions.findMany` (no `limit`, no
cursor), each with its full task/worker tree, on every list render — and for
every `status === 'completed'` mission among them, recomputes
`computeMissionSkyline` from scratch (`missions/page.tsx:279-280`). A
completed mission's data never changes, so this recomputation (and the tree
fetch behind it) is pure waste that grows without bound as the workspace's
mission history grows.

**Rule P-1 (compute once, store on completion):** a new nullable jsonb column,
`missions.flightStripCache`, following the same shape and lifecycle precedent
as `missions.goalCriteriaState` (`packages/core/db/schema.ts:860`) — computed
once by whichever path transitions a mission to `status = 'completed'`, and
never recomputed after. The stored payload is the full render-ready shape:
lanes, bars, rail marks, phase dividers, breaks, and the derived metrics from
§6 — not raw spans, so a list render never re-derives anything.

**Rule P-2 (list reads the cache, never recomputes it):** the list query's
completed-mission branch reads `flightStripCache` directly. It selects no
task/worker columns for a completed mission's flight strip at all — the
per-mission task/worker fan-out that Rule P-1's data replaces is removed
from the list query's `with` clause for completed missions specifically. This
is the actual fix for the O(all-time missions × full task tree) cost named
above.

**Rule P-3 (active missions always compute live):** an active mission's cache
is null by construction (it hasn't completed) and the strip is computed on
every render from live spans, per §1–§6. This is bounded cost: the number of
simultaneously active missions in a workspace is capped by that workspace's
`maxConcurrentTasks`, so this is never an unbounded scan.

**Rule P-4 (the list itself must paginate):** independent of Rule P-1, the
`allMissions` query at `missions/page.tsx:116` currently has no `limit` at
all. This spec requires a `limit`/cursor on the completed-mission portion of
that query — the active/scheduled portion, which is small by Rule P-3's
bound, is unaffected. A workspace's full completed-mission history must never
be a single unbounded fetch.

**Rule P-5 (backfill):** a one-off script computes `flightStripCache` for
every existing `status = 'completed'` mission where the column is currently
`NULL`, using the same computation Rule P-1 defines, and is safe to re-run
(a mission that already has a cache is skipped, not recomputed) so it can be
retried after a partial run without side effects.

---

## Open questions

- **Fold cap (Rule X-5) and queued-bar width estimate (Rule A-2)** are both
  judgment calls made in this spec rather than measured thresholds — flagged
  here rather than left silently arbitrary. Revisit once the new model is
  live and real mission shapes can be observed against them.
- **Where HUMAN % (§6) surfaces** is left to the implementing task. This spec
  defines the metric; it does not mandate a specific placement on the card or
  sheet.
- **Whether the fold summary block (Rule X-5) is itself tappable** (e.g. to
  expand the folded segments) is left to the implementation task; the boards
  don't show this state and this spec does not want to invent bottom-sheet
  content the boards never specified.

## Non-goals

- This spec does not change `mission_notes`, `taskSchedules`, or the
  heartbeat prepass themselves — it only reads fields those systems already
  write (Rules S-1/S-2/S-3).
- This spec does not change the Structure canvas, the mobile timeline rail, or
  any other consumer of `deriveWorkKind` — Rule L-3's orchestrator exclusion
  is scoped to the flight strip's lane assignment only, not to the shared
  glyph vocabulary `mission-legibility.md` governs.
- This spec does not add a role-specific glyph or a fourth lane — Rule L-1's
  table is exhaustive over the seven-kind vocabulary as it exists today; a
  future eighth work-kind would need its own lane-mapping rule, not a
  reopening of this spec's structure.
- No product code changes ship as part of this spec — it is a design contract
  for a follow-up build task (§ Implementation breakdown).

---

## Acceptance criteria

1. `computeMissionSkyline`, `SkylineBlock`, `MissionSkylineData`, and
   `MissionSkylineChart.tsx` are deleted, not deprecated-in-place; no code
   path computes the old wall-clock model after the build lands.
2. A task with `kind = null`, `roleSlug = null` whose derived task type is not
   `review`/`review-retry` renders in the UNCLASSIFIED band (Rule L-2), never
   silently omitted and never defaulted into BUILD.
3. A task with `creationSource = 'schedule'`, `mode = 'planning'` never
   renders as a lane bar, regardless of its `kind` value (Rule L-3) — tested
   directly against a `kind = 'coordination'` fixture, since that's the case
   most likely to be miscoded as "just render it in THINK."
4. A worker with `status = 'failed'`, `exitCause = 'budget_limited'` renders
   its ordinary concurrency-tier fill, not the failure color (Rule C-2) —
   regression coverage for the specific case this spec's Rule C-2 must not
   overcorrect into "paint everything red."
5. A worker with `status = 'failed'`, `exitCause = 'code_failure'` renders
   `#d2584b` (Rule C-2) — covered by the per-`exitCause` classification test
   in `packages/core/__tests__/mission-flight-strip.test.ts`. (Not by
   `packages/core/__tests__/mission-helpers.test.ts:930` as this criterion
   originally described: that line tests the *old* `computeMissionSkyline`
   model, whose `status === 'error'` bug was fixed in place, not replaced —
   see §Problem.)
6. A mission where no task has `missionPhaseIndex` set renders zero phase
   dividers and zero phase labels (Rule X-3).
7. A mission with tasks split across two `missionPhaseIndex` values renders
   exactly one divider between them, positioned at the compressed-axis
   boundary, independent of whether an idle gap also exists there.
8. An idle gap of 14 minutes between two spans renders no break glyph and
   contributes no pixels; a gap of 15 minutes or more renders the break glyph
   labelled with its real duration (Rule X-2) — both boundary cases covered.
9. A `mission_notes` row with `authorType = 'agent'` never renders a human
   diamond (Rule S-1 is scoped to `'user'` only) — `'bot'` is not a valid
   `mission_notes.authorType` value (`packages/core/db/schema.ts:1843` types
   it `'agent' | 'user' | 'system' | 'mcp'`; `'bot'` belongs to the unrelated
   `review_feedback.authorType` at schema.ts:1821), so this criterion is
   tested against `'agent'`, one of the three real non-`'user'` values.
10. A schedule tick that the heartbeat prepass classifies as
    `skip_no_change` (no task row created) contributes zero rail marks (Rule
    S-3) — verified by asserting the query behind Rule S-2 returns no row for
    a fixture where no planning task exists, not by asserting a skip flag
    that doesn't exist.
11. `agentTimeMin` and `parallelFactor` computed over a fixture containing an
    orchestrator/heartbeat span differ from the same fixture with that span
    included in the sum — proving Rule L-3's exclusion actually reaches §6's
    metrics and isn't lane-only.
12. For a `status = 'completed'` mission, the list query performs zero
    task/worker fan-out and reads `flightStripCache` only (Rule P-2) —
    assertable by asserting the query's `with` shape, not just by timing.
13. Calling the backfill script (Rule P-5) twice in succession leaves
    `flightStripCache` unchanged after the second run for every mission the
    first run already populated.
14. The completed-mission portion of the missions list query is paginated
    (Rule P-4); requesting a workspace with more completed missions than one
    page returns a bounded result set plus a cursor, not the full history.
15. On the detail page, an artifact whose type is a capture (e.g.
    `screenshot`, `diff`) never appears in the mission-level "Records" row
    even when it is the only artifact on its task (Rule 7, review gate).

---

## Implementation breakdown

Serialized where a later group genuinely depends on an earlier one's shape;
parallel-safe within a group since the listed groups touch disjoint files.

**1. Core model** *(first, alone — everything else imports its types)* —
**status: partially preempted, see Rule L-4.** `computeMissionFlightStrip`
ships (with Rule C-2's exitCause-based failure classification and its own
regression tests in `mission-flight-strip.test.ts`, satisfying AC-4/AC-5),
and the `flightStripCache` migration (Rule P-1) plus its backfill script
(Rule P-5) have also shipped — see "Implementation Status" above. But
`computeMissionFlightStrip` still reads `deriveWorkLane` instead of this
spec's Rule L-1 table, and the three downstream consumers (the SVG renderer,
the list-card wiring, the detail-page/flight-detail-sheet wiring — items 2,
3a, 3b, 3c, all shipped) all ship against that `deriveWorkLane`-sourced
output. What remains under this item: (a) the Rule L-1 kind→lane table plus
an adapter over `deriveWorkKind`'s result, colocated with `deriveWorkKind` in
`apps/web/src/lib/task-presentation.ts`; (b) re-point `computeMissionFlightStrip`
at that adapter instead of `deriveWorkLane`; (c) delete `deriveWorkLane` and
its dedicated tests once no call site reads it, and re-verify the SVG
renderer and detail-page/flight-detail-sheet wiring against the new lane
source — same field shape, different source, so this is a swap-and-reverify
pass on those two, not a rewrite. Only once (a)-(c) land can
`computeMissionSkyline`/`SkylineBlock`/`MissionSkylineData` be deleted (AC-1)
— the detail page's completed-mission stats row is the one remaining live
caller and needs to move onto the flight strip's own §6 metrics first.

**2. SVG component** *(second, depends on 1)* — **Shipped.** See
"Implementation Status" above.
`apps/web/src/components/FlightStrip.tsx` replaces `MissionSkylineChart.tsx` —
pure rendering over `computeMissionFlightStrip`'s output, no data fetching, so
it can be exercised with fixtures independent of the wiring tasks below.

**3a. List card wiring** *(depends on 1, 2 — parallel-safe with 3b/3c)* —
**Shipped.** See "Implementation Status" above.
`missions/page.tsx`: query changes (added `roleSlug`, `exitCause`, the
`mission_notes` `authorType = 'user'` aggregate — `missionPhaseIndex`/
`missionPhaseLabel` and `taskClass` were already selected), Rule P-2's
cache-read branch, Rule P-4's pagination, the now-line/queued-bar rendering
(Rules A-1/A-2), and Rule P-5's backfill script.

**3b. Detail page navigator** *(depends on 1, 2 — parallel-safe with 3a/3c)* —
**Shipped.** See "Implementation Status" above.
`missions/[id]/page.tsx`: pinned strip as navigator with scroll-and-outline,
phase-grouped task list, Verified-pill collapse of goal criteria, per-task
artifact rows, the review-gated Records row, the Orchestrator summary row,
and the Archive/Delete relocation behind the overflow bottom sheet.

**3c. Flight detail sheet** *(depends on 1, 2 — parallel-safe with 3a/3b)* —
**Shipped.** See "Implementation Status" above.
`apps/web/src/components/FlightDetailSheet.tsx`, reached from a list-card bar
tap: the four-row expanded strip (STEER/THINK/BUILD/CHECK), the stat grid
(agent time, idle elided, build↔check loop count), and the prose summary
line. Natural first home for the HUMAN % metric (§6, Open Questions).
