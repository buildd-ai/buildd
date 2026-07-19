# Unified Task Presentation

**Status:** Proposed
**Related:** `apps/web/src/lib/task-timestamps.ts` (PR #1163), Knowledge Layer Elevation mission, `docs/design/mission-state-progress.md`

---

## Problem

Three interfaces render a live task, and each holds a different third of the truth.

| Surface | Shows | Missing |
|---|---|---|
| Home — Right Now | runner id, heartbeat age | mission, position, progress, PR state |
| Activity — Active tab | title, workspace, timestamp | everything (and the timestamp is wrong — see the `idle` filter bug) |
| Mission timeline | dependency state, PR/blocked status | liveness, elapsed, turns |

No surface shows all three of *identity*, *position*, and *health*. A user answering "is this task actually progressing, and what is it holding up?" must visit two pages and correlate by eye.

Secondary defect: **Home leads with the runner id.** `coder-workspace-f1fc4699` is a debugging affordance. It occupies the most prominent slot in the card while the mission the task belongs to is absent entirely. The information hierarchy is inverted.

---

## Design

One derivation module. One component, three densities. Three mounts.

### Derivation — extend `lib/task-timestamps.ts` → `lib/task-presentation.ts`

Existing exports stay (`deriveDisplayStatus`, `deriveTimestampLabel`, `isStaleWorker`). Add:

```ts
deriveChainPosition({ task, deps, dependents }): {
  index: number          // 1-based position in the dependency chain
  total: number
  blockedBy: BlockRef[]  // upstream not yet satisfying the claim gate
  unblocks: number       // count of downstream tasks waiting on this one
  segments: Segment[]    // per-task strip state, see below
}

deriveIntensity({ turns, startedAt, workerUpdatedAt, now }): {
  tier: 'fresh' | 'working' | 'slow' | 'stalled'
  sparkline: number[]    // turns per 5-min bucket
}
```

`LIVE_WORKER_STATUSES` is defined here once and imported everywhere. No call site re-lists worker statuses inline.

### The chain strip

Renders dependency position as a compact glyph run: `▪▪▫▫ 2/4`

| Segment | Meaning |
|---|---|
| filled | completed **and** PR merged — gate satisfied |
| half | completed, PR still open — **gate NOT satisfied** |
| current | this task, outlined |
| empty | pending / not yet claimable |

**The half state is the point of this feature.** The claim gate requires `status = completed` AND `mergedAt IS NOT NULL` (memories 0ebbf0db, 69399b8f). A task that is completed with an open PR looks finished but silently blocks everything downstream — the Trackable Objects mission failed four times on this exact state, and the `/start` route shipped a 422 pre-check (PR #1241) to catch it at action time. The strip catches it at *glance* time.

Accompanying text, when non-trivial:
- `← blocked on #1254 (open)`
- `→ unblocks 2`

### Intensity, not heatmap

A heatmap encodes 2D density; a single task has no grid, so a heat glyph would be decoration. Depth and duration are separate axes and get separate encodings:

- **Depth** → the chain strip above.
- **Duration** → elapsed label colored by tier, using the established two-tier stale thresholds (liveness ~5min, progress ~60min). `isStaleWorker` already implements the first tier at 10min; extend rather than replace.
- **Intensity** → turn sparkline, turns per 5-min bucket, ~40px inline. Flat line on a long-running task is the "spinning, not working" signal. Absent turn data ⇒ omit the element entirely, no placeholder.

### Component — `components/TaskCard.tsx`

One component, three densities:

| Density | Mount | Tiers rendered |
|---|---|---|
| `full` | Home — Right Now | all |
| `row` | Activity list | 1–4, sparkline optional |
| `inline` | Mission timeline | 1, 2, 4 (position already primary here) |

### Information hierarchy

Strict order. Runner id moves last on every surface.

1. **Identity** — title, mission, workspace
2. **Position** — chain strip, blocked-by, unblocks
3. **Health** — display status pill, elapsed (tier-colored), turns + sparkline, attempt `N/M`, stale flag
4. **Provenance** — runner/coder workspace id, PR link

Read as: *what is it → where in the plan → is it healthy → where is it running.*

---

## Constraints carried from prior work

- **Do not bump `updatedAt` on `worker:progress` events.** PR #311 fixed constant re-sorting caused by this; a ticking elapsed field must not reintroduce it. Derive elapsed client-side from `startedAt`.
- **Use the Link-overlay pattern for clickable rows** (memory bb3879df): outer `relative group`, absolutely-positioned `Link` covering the row, content layer `pointer-events-none`, external links restored with `pointer-events-auto relative z-10`. Never nest `<a>` inside `<a>` — causes SSR hydration mismatch.
- **`task.status` never becomes `'running'`** (memory 05b6358f). Liveness comes from worker status only. The live set includes `idle` — a worker between turns is live, not queued.
- **Truncate last-message server-side.** Do not ship full agent output to a list view.

---

## Open questions

**Chain strip on non-mission tasks.** Standalone tasks have no chain; the strip should be omitted, not rendered as `1/1`. Unclear whether `dependsOn` without a mission should still render a strip — leaning yes, since the gate applies regardless of mission membership.

**Sparkline data source.** Turn count is not currently a first-class field; it must be derived from worker progress events or `commitCount`. If bucketing progress events proves expensive at list scale, degrade to a single turn count integer and drop the sparkline from `row` density.

---

## Acceptance

- Home, Activity, and Mission timeline render the same component; a change to task presentation requires editing one file.
- A task completed with an unmerged PR is visually distinct from one whose PR has merged, on every surface.
- Runner id appears last in the hierarchy on every surface.
- List does not re-sort on progress events.
- No surface re-lists live worker statuses inline.
