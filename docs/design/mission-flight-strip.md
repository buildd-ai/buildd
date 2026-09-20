# Mission flight strip

**Status:** Proposed
**Related:** `packages/core/mission-helpers.ts` (`computeMissionSkyline`, `workerBlockState`), `apps/web/src/components/MissionSkylineChart.tsx`, `apps/web/src/app/app/(protected)/missions/page.tsx`, `apps/web/src/app/app/(protected)/missions/[id]/page.tsx`, `packages/core/__tests__/mission-helpers.test.ts`, `docs/design/derived-metric-availability.md`

## Problem

The mission card chart reports the wrong thing, and reports it only when nobody
needs it.

1. **A failed worker renders as a success.** `workerBlockState` in
   `packages/core/mission-helpers.ts` returns `failed` for
   `status === 'error'`. The runner does not write that value — a terminal
   worker is `completed` or `failed`. So every failed worker falls through to
   `mergedAt ? 'merged' : prUrl ? 'awaiting' : 'merged'` and is painted with
   the success colour. Mission failure is a routine outcome, so this is not an
   edge case: the chart's green is unreadable, because it means either "shipped"
   or "died".

   `packages/core/__tests__/mission-helpers.test.ts` has a case named
   `state: failed when status=error`. The test asserts the bug, which is why
   the bug survived review.

2. **The chart is absent on active missions.** `missions/page.tsx` computes the
   skyline only when `obj.status === 'completed'`. A mission being worked right
   now — the one a reader opens the page to understand — gets no chart at all.

3. **Bar width carries no information.** The x-axis is wall clock quantized to
   `SKYLINE_SLOT_MS` (15 minutes), with a one-slot floor. Real worker spans are
   routinely far shorter than one slot, so a large share of bars render at
   exactly the floor width regardless of how long the work took. Two bars of
   visibly equal length can differ by an order of magnitude.

4. **Most of the axis is idle.** Mission wall clock is dominated by waiting —
   for review, for a runner, for a budget window. Agent time is a small
   fraction of it. The chart spends most of its pixels drawing nothing, and the
   little that is drawn is compressed into the remainder.

Figures behind (3) and (4) are measured against production and recorded in a
private recon artifact on the mission. They stay there: this repo is public.

## Current state

`computeMissionSkyline(tasks, opts)` → `MissionSkylineData`:

- x = wall clock, quantized to 15-minute slots, one-slot floor
- y = greedy concurrency lane packing, capped at 4 with a `foldedLanes` overflow count
- state = `merged | awaiting | failed`, from `mergedAt` / `prUrl` / `status`
- derived: `activeSpanMin`, `agentTimeMin`, `parallelFactor`, `peakConcurrency`, `reviewTailMin`

Rendered by `MissionSkylineChart` as absolutely-positioned divs. Two call
sites: the list card (completed missions only) and the mission detail page.

## Proposal

Replace the model. Both axes change meaning, so this is not a restyle:

| | now | proposed |
|---|---|---|
| **x** | wall clock, 15-min slots | agent time, idle elided, gaps collapsed to a labelled break glyph |
| **y** | concurrency lane index | kind of work — three lanes (think / build / check) plus a steering rail |
| **fill** | PR/merge state | concurrency, as a three-step ramp; a distinct fill for real failure |
| **scope** | completed missions | every mission, with a now-line and hollow queued bars when active |
| **phases** | — | dividers labelled P1/P2/P3 on the axis |

**Crux: the lane assignment.** The whole redesign turns on being able to say
which of think / build / check a task belongs to. If that mapping is wrong, the
chart is worse than the one it replaces — a mislabelled lane is a confident lie,
where a concurrency lane index was merely uninformative. Everything else here
(elided idle, honest failure colour, now-line) is an improvement that stands on
its own and would be worth shipping even if the lanes were abandoned.

### Design claim vs. what the code and data actually support

The design boards specify five encodings. Three read off existing columns; two
do not exist yet and must be derived. Stating this explicitly is the point of
this section — a spec that assumes all five are reads would specify a chart
that cannot be built.

| Encoding | Source | Verdict |
|---|---|---|
| x = agent time, idle elided | `workers.startedAt` / `completedAt` | **Read.** Already collected; `agentTimeMin` is computed today. |
| fill = concurrency (1 / 2 / 3+) | sweep-line over spans | **Read.** `peakConcurrency` already does the sweep; overlap is common enough in practice for three steps to earn their keep. |
| now-line + queued bars | `tasks.status`, `now` | **Read**, once the completed-only gate is removed. |
| failure fill | `workers.exitCause` | **Read, but not as written.** See below. |
| y = think / build / check | `tasks.kind` | **Not available.** See below. |
| steering rail | `mission_notes`, `workers.instructionHistory`, bookkeeping workers | **Derivable**, but the boards mis-size it. See below. |
| phase dividers P1/P2/P3 | — | **No source at all.** See below. |

**The lane has no single source.** `tasks.kind` is unset on the majority of
mission work tasks, and — decisively — none of its populated values means
"check". Checking work is recorded elsewhere: a retry is `taskClass = 'attempt'`,
a review pass is `roleSlug = 'reviewer'`, a verification or surface-audit task
is identifiable only by title shape. So the lane must come from one exported
helper with a written precedence order:

```
1. taskClass === 'attempt'                          → check
2. roleSlug   reviewer | spec-validator             → check
              researcher | organizer | architect    → think
              builder                               → build
3. kind       coordination | research | analysis
              | design                              → think
              engineering | writing                 → build
4. title      [surface audit] | verify… | review…   → check
5. otherwise                                        → null
```

`null` means **unlabelled**, and the model must report whether lane data is
trustworthy at all. When no task on a mission resolves, the strip renders as a
single uncaptioned track. It must never default to BUILD and it must never
caption three lanes the data cannot support — that is the crux failing quietly,
which is the one outcome worse than not shipping.

**Failure colour keys off cause, not status.** `workers.exitCause` already
separates real failure (`code_failure`, `infra_failure`) from causes the schema
comments explicitly describe as non-failures: `budget_limited` (session cap;
the task auto-resumes), `condition_unmet` (a loop exit predicate), `never_started`
(an over-claim bookkeeping row), `silent_start`, `reassigned`. Painting every
`status = 'failed'` red would replace today's green lie with a red one. Only
real failure gets the failure fill. `missions/page.tsx` does not currently
select `exitCause`.

**The steering rail is both emptier and busier than the boards show.** Human
interventions are rare — most missions have none, so a permanently reserved
rail row is a blank row on the typical card. Orchestrator cycles that ran a
model are the opposite: they routinely outnumber a mission's work tasks, so an
uncapped rail out-marks the strip it sits above. The board card carrying six
human touches is a tail case, not the shape to design around. Therefore: the
rail collapses to zero height when it has no events, and orchestrator marks
cluster past a fixed cap. Deterministic heartbeat ticks are never drawn — they
are simply not fed in.

**Phase dividers have no stored source.** There is no phase column on `missions`
or `tasks` and nothing derives one. Derive phases from the elided idle gaps
already being computed for the x-axis: the boards themselves label a single
boundary with both facts at once (`"7h idle · P2"`), which is good evidence the
two were always the same boundary. Alternatives considered and rejected:
orchestrator cycle boundaries (too many, and they mark when the planner woke up,
not when the work changed character) and `dependsOn` topological waves (absent
whenever a mission's tasks declare no overlapping path manifests, which is
common).

### Safety properties

Everything automatic here is bounded, and every bound is a named constant, not
a literal:

- idle elision threshold — a gap shorter than it is drawn to scale, not collapsed
- orchestrator mark cap — marks beyond it cluster into one glyph with a count
- lane count — fixed at three, plus the rail; no dynamic lane growth
- bar fold cap — a mission with more bars than the plot area can hold renders
  the cap and a folded count, the way `foldedLanes` works today

### Defaults are no-ops

The new model lands alongside `computeMissionSkyline`, which keeps its exports
and its tests. Nothing changes on screen until a call site switches over, and
the call sites switch one at a time. The last switch deletes the old model and
`MissionSkylineChart`.

## Implementation sketch

Load-bearing piece first.

1. **Fix the failure bug, with a regression test that fails before the fix.**
   Independent of everything below and worth landing on its own: a worker with
   `status: 'failed'` must not resolve to a success state, and the test that
   asserts `status === 'error'` must be corrected rather than extended.
2. **`deriveWorkLane(task)` in `packages/core/mission-helpers.ts`** — the crux,
   with a test per rung of the precedence chain and a test for the
   all-unlabelled mission.
3. **`computeMissionFlightStrip`** — agent-time axis with gap elision, phase
   split from the gaps, per-bar concurrency bucket, failure classed by
   `exitCause`, queued bars and a `now` position, fold cap. Emits a normalized
   0..1 domain; the component owns pixels. Steering events arrive on the options
   bag — core does not query.
4. **`MissionFlightStrip`** — SVG, not positioned divs: the boards specify a
   `viewBox` and the marks are paths. Collapsible rail, collapsible lane
   captions, generated `aria-label`, ≥44px touch targets on anything tappable.
   Dev fixtures for each state, including the no-lane-data case the boards
   don't show.
5. **List card** — remove the completed-only gate; add `roleSlug` and
   `exitCause` to the query; add the steering-rail read. Cost that read before
   assuming it is free; if it is material, fetch the rail only on the detail
   page and let cards render rail-less, which the model already reports.
6. **Detail page** — strip pinned under the title as the page navigator.
7. **Stored strip for completed missions** — a completed mission's strip never
   changes, so compute it once at completion and store it; compute live only for
   active missions. Needs a migration and a backfill, and belongs after the
   model has stopped moving.

Density rules from the accepted mission-card density spec continue to govern and
win wherever they and the boards disagree: no `Medium` tag, no `NEW` tag,
two-line titles, a tappable Verified pill, and the workspace release row in the
list header once rather than on every card.

## Open questions

- **Phase derivation.** Leaning to idle-gap boundaries, for the reason above.
  The alternative worth a second look is a hybrid: gap boundaries, but suppressed
  when no task's lane changes across the gap — a long wait inside one build phase
  is arguably not a phase change. Not proposing it yet because it adds a rule
  readers must learn to read the axis.
- **Whether `writing` belongs in build or think.** Mapped to build above on the
  grounds that a doc is a deliverable, but a spec-writing task is thinking by any
  ordinary reading. It may want its own treatment rather than a lane.
- **Whether the three-step concurrency ramp survives colour-blind review.** The
  ramp is three tints of one hue, which is the right encoding for an ordered
  quantity but leans entirely on luminance. Worth checking against the failure
  fill before the hexes are fixed.
- **Backfilling `tasks.kind`.** Out of scope here, but the crux gets easier every
  time a task is filed with a kind. Whether to backfill historic rows from the
  same precedence chain, or leave old missions rendering as single-track, is a
  separate call.

## Non-goals

- No change to how `kind` is assigned at task creation, and no backfill of
  historic `kind` values.
- No new phase column or phase concept in the schema — phases stay derived.
- Not a general charting component. This is one chart with one reading.
- No change to mission health derivation or to the progress metric.
- The stored-strip migration is sketched, not specified; it needs its own pass
  once the model is settled.
