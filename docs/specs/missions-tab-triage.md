---
title: Missions Tab — Initiative Triage Surface
status: superseded
owner: builder
last_verified: 2026-08-13
summary: The initiative triage surface MUST rank initiatives by pending-action counts with 14-day effort sparklines and a task-weighted progress percentage computed over all of an initiative's tasks, uncapped.
domain: surfaces
surfaces: [apps/web/src/app/api/initiatives/effort/route.ts, packages/core/mission-helpers.ts, apps/web/src/app/app/(protected)/missions/page.tsx, apps/web/src/components/SparklineBar.tsx]
related: [surface-ia-home-missions-initiatives, mission-task-lifecycle]
keywords: [effortday, initiativetriagerow, sparklinebar, awaitingverification, __unassigned__, computeinitiativeprogress]
superseded_by: surface-ia-home-missions-initiatives
---

# Missions Tab — Initiative Triage Surface

> **Superseded by [Surface IA — Home, Missions, Initiatives](./surface-ia-home-missions-initiatives.md).**
> The triage surface shipped in v0.166.0 but on the wrong host: this spec places
> it on the Missions tab, whose subject is mission state. The successor moves it
> to `/app/initiatives`, corrects the sparkline mount size (this spec's `84×24`
> shipped as `48×16`), replaces §3's standalone endpoint contract with one shared
> loader, and carries §1's progress canon forward as §6.3. Kept for the progress
> mismatch analysis below, which explains why the two shipped percentages
> disagreed.

**Capability statement**: The Missions tab MUST present each active initiative as
a triage row that surfaces pending-action counts, 14-day activity sparklines, and a
correct task-weighted progress percentage — so a user can prioritise which
initiative needs attention without visiting each one.

---

## 1. Progress Mismatch Investigation

### Two diverging code paths (current state)

There are currently two places on the Missions page that show an initiative's
progress percentage. They produce **different numbers** because they use different
data scopes.

#### Path A — `InitiativesStrip` (the compact strip above the grid)

File: `apps/web/src/app/app/(protected)/missions/page.tsx`, lines 88–118

```
teamInitiatives query:
  initiatives → missions → tasks (NO per-task limit, NO workers)
  task columns: id, status, kind, title, mode, creationSource, category

computeMissionProgress(tasks)     ← task-weighted, all tasks
computeInitiativeProgress(children) ← rolls up across ALL missions in initiative
```

Scope: all missions in the initiative, all tasks per mission, **no workspace
filter**, max 12 initiatives.

#### Path B — `InitiativeGroupSection` inside `MissionGrid`

File: `apps/web/src/app/app/(protected)/missions/page.tsx`, lines 319–343

```
allMissions query:
  missions (limit 50, workspace-filtered) → tasks (limit 20 per mission, with workers)

computeMissionProgress(tasks)     ← task-weighted, ≤20 tasks per mission
computeInitiativeProgress(children) ← only missions visible in the 50-row page
```

Scope: missions that survive the workspace filter AND fit in the 50-row cap, tasks
truncated at 20 per mission.

### Why the numbers diverge

| Cause | Effect |
|---|---|
| `allMissions` task limit of 20 | Missions with >20 deliverable tasks show inflated % (denominator too small) |
| `allMissions` row limit of 50 | Initiatives whose missions span >50 total missions lose some child missions entirely |
| Workspace filter on `allMissions` | When a workspace is selected, cross-workspace initiative missions are excluded; progress shrinks |
| `teamInitiatives` has no workers | Segments are always `empty` state — segment strip cannot be rendered correctly |

### Correct computation going forward

**Path A is closer to correct** for the progress number: it sees all missions and
all tasks (no truncation). But it lacks `workers` data, so it cannot render
per-task segment states.

**The canonical computation MUST use:**
1. All missions that belong to the initiative (no workspace filter, no row cap).
2. All deliverable tasks per mission (no per-mission task limit).
3. Task-weighted progress: `round((Σ completedTasks) / (Σ totalTasks) × 100)`.
   Falls back to mission-weighted when `Σ totalTasks === 0`.
4. Workers data (at least `status`, `prUrl`, `mergedAt`) to derive segment states.

`computeInitiativeProgress` and `computeMissionProgress` in
`packages/core/mission-helpers.ts` implement the correct algorithm — the bug is
in the query scope passed to them, not in the helpers themselves.

**Migration path**: add workers to the `teamInitiatives` query and remove the task
`limit: 20` from `allMissions` for initiative-scoped missions (or query initiative
progress separately, un-capped).

---

## 2. Data Shapes

### `EffortDay`

One calendar day's token activity for a single initiative (or the unassigned bucket).

```ts
interface EffortDay {
  date: string;     // ISO date "YYYY-MM-DD" in UTC
  tokens: number;   // inputTokens + outputTokens summed across all workers
  merged: number;   // count of tasks completed with a merged PR on this date
  failed: number;   // count of tasks that reached status="failed" on this date
  open: number;     // count of tasks created or moved to pending on this date
}
```

The `tokens` field is the primary signal. `merged`/`failed`/`open` are segment
counts for SparklineBar coloring — they do NOT represent distinct tasks (a task
can appear in multiple buckets if it spans midnight).

### `InitiativeTriageItem`

The full record passed to a triage row component.

```ts
interface InitiativeTriageItem {
  id: string;                   // initiative UUID; "__unassigned__" for the pseudo-row
  title: string;
  progress: number;             // 0–100, task-weighted (canonical, see §1)
  effortDays: EffortDay[];      // 14 entries, oldest first, one per calendar day
  awaitingVerification: number; // tasks with status="completed", prUrl set, mergedAt null
  blocked: number;              // tasks with status="pending" blocked on an unmerged-PR dep
  held: number;                 // missions where isHeld=true (task claims blocked)
  shippedThisWeek: number;      // tasks completed with mergedAt within last 7 days
}
```

`effortDays` MUST always have exactly 14 entries (back-filling zeros for days with
no activity). The oldest entry is `effortDays[0]`; today is `effortDays[13]`.

---

## 3. API Contract — `GET /api/initiatives/effort`

### Purpose

Returns per-initiative daily token totals for the last 14 calendar days. Used
exclusively by the triage surface. Kept separate from the main initiatives list
to avoid adding heavy aggregation to the already-loaded page query.

### Authentication

Same as all protected routes: session cookie or Bearer API key. Scoped to the
caller's active team (resolved from `buildd-team` cookie).

### Request

```
GET /api/initiatives/effort
  ?workspace=<workspaceId>   optional — scope to one workspace
```

No pagination. The endpoint returns all active/paused initiatives for the team
(capped at 50 — same as the missions list).

### Response

```jsonc
{
  "items": [
    {
      "id": "uuid-or-__unassigned__",
      "title": "string",
      "progress": 42,
      "effortDays": [
        { "date": "2026-07-31", "tokens": 0, "merged": 0, "failed": 0, "open": 0 },
        // … 14 entries total
      ],
      "awaitingVerification": 3,
      "blocked": 1,
      "held": 0,
      "shippedThisWeek": 5
    }
    // … one entry per active/paused initiative + one "__unassigned__" entry if applicable
  ]
}
```

### Unassigned bucket

Missions with no `initiativeId` (or an `initiativeId` not matching any active
initiative) MUST be collected into a single pseudo-initiative entry:

```json
{ "id": "__unassigned__", "title": "Other", "progress": …, "effortDays": […], … }
```

The unassigned row follows the same sorting rules as real initiatives. It is
omitted entirely when there are no unassigned missions.

### Computation rules for the endpoint

1. **Token aggregation**: join `workers` on `tasks` on `missions` on `initiatives`.
   Group by `initiative_id` and `date_trunc('day', workers.started_at AT TIME ZONE 'UTC')`.
   Sum `workers.input_tokens + workers.output_tokens`.
2. **`merged` count**: `count(*)` where `workers.merged_at::date = day` and
   `workers.merged_at IS NOT NULL`.
3. **`failed` count**: `count(*)` where `tasks.updated_at::date = day` and
   `tasks.status = 'failed'`.
4. **`open` count**: `count(*)` where `tasks.created_at::date = day` and
   `tasks.status NOT IN ('completed','cancelled','failed')` at that timestamp.
   (Approximation: use `created_at` for open count; no point-in-time replay.)
5. **`awaitingVerification`**: across all missions in the initiative,
   `count(workers)` where `workers.pr_url IS NOT NULL AND workers.merged_at IS NULL`
   and the associated task's status is `completed`.
6. **`blocked`**: across all missions, `count(tasks)` where `tasks.status = 'pending'`
   and at least one entry in `tasks.depends_on` resolves to a task with a worker
   whose `pr_url IS NOT NULL AND merged_at IS NULL AND pr_lifecycle_status != 'closed'`.
7. **`held`**: count of missions in the initiative where `missions.is_held = true`.
8. **`shippedThisWeek`**: `count(workers)` where `workers.merged_at >= now() - interval '7 days'`.
9. **`progress`**: task-weighted per §1 (canonical), using all tasks (no limit).

### Error responses

| Status | Condition |
|---|---|
| 401 | No valid session or API key |
| 403 | Caller's team does not match the requested workspace's team |

---

## 4. `SparklineBar` Component

### Props

```ts
interface SparklineBarProps {
  days: EffortDay[];    // exactly 14 entries
  width?: number;       // total px width; default 84 (14 bars × 6px)
  height?: number;      // max bar height px; default 24
}
```

### Rendering rules

- One bar per `EffortDay`. Bars are rendered left→right, oldest→newest.
- Bar height is proportional to `tokens` normalized **within this initiative only**
  (not globally). The tallest day in the 14-day window gets full height; all other
  days scale relative to it.
- When all 14 days have `tokens === 0`, render 14 bars at 1px (minimum visible height).
- Bar fill is segmented bottom→top:
  1. **open** segment: accent colour (activity in progress)
  2. **failed** segment: error colour
  3. **merged** segment: success colour
- Segment heights are proportional to the counts within each bar's total `tokens`
  budget. When a day has tokens but zero segment counts (all three are 0), fill
  the entire bar with the accent colour (activity but no status signal).
- No tooltip on mobile. On desktop, `title` attribute: `"YYYY-MM-DD: N tokens"`.
- The component is purely presentational — it takes `days` and renders. It does
  not fetch data.

---

## 5. `InitiativeTriageRow` Anatomy

### Layout

```
[ Title (flex-1, truncated)        ] [ sparkline, right-aligned ] [ XX% ]
[ Subline — only when signal exists ]
```

### Subline rules

The subline is rendered **only** when at least one of these conditions is true:

| Condition | Subline copy |
|---|---|
| `awaitingVerification > 0` | `N awaiting merge` |
| `blocked > 0` | `N blocked` |
| `held > 0` | `N held` |
| `shippedThisWeek > 0` (fallback — only if all above are 0) | `N shipped this week` |

When none of these conditions hold (all-quiet row), **no subline is rendered**. An
empty subline element MUST NOT appear in the DOM.

Multiple conditions: render all that are true, separated by `·`. Example:
`2 awaiting merge · 1 blocked`.

### Subline label ordering

Always: awaiting verification → blocked → held → shipped (left to right).

---

## 6. Zone Sorting

The triage surface divides rows into two zones with a visual divider between them.

### Zone 1 — "Needs you"

Rows where the user has a pending action. Condition:

```
awaitingVerification > 0 OR blocked > 0 OR held > 0
```

Sorted within the zone by descending `awaitingVerification + blocked + held`
(highest action count first), then by descending `progress`.

### Zone 2 — "Recent"

Rows with no pending action but activity in the last 14 days. Condition:

```
awaitingVerification === 0 AND blocked === 0 AND held === 0
AND effortDays.some(d => d.tokens > 0)
```

Sorted within the zone by descending `shippedThisWeek`, then by descending total
14-day `tokens`.

### Collapsed tail

Rows with zero pending actions AND zero tokens in the 14-day window. These are
collapsed by default and hidden behind a disclosure ("Show N dormant" button).
They MUST NOT appear in Zone 1 or Zone 2.

### Visual divider

A single `<hr>` (or equivalent visual separator) is rendered between Zone 1 and
Zone 2. No divider is rendered when Zone 1 is empty.

---

## 7. Unassigned Pseudo-Initiative

Missions with no `initiativeId` get a real triage row with:
- `id: "__unassigned__"`
- `title: "Other"`
- Same `EffortDay`, pending-action, and progress computation as any real initiative.
- Sorted by the same zone rules.

The unassigned row MUST be present if and only if there are missions with no
`initiativeId` and they have either pending actions or recent activity. It is
omitted — not merely collapsed — when no unassigned missions exist at all.

---

## 8. Dismiss Affordance

The dismiss gesture is a soft hide for dormant rows. It does NOT delete the
initiative or its data.

### Trigger

Swipe-to-dismiss on rows in the collapsed tail (Zone 3 / dormant). Active rows
(Zone 1 / Zone 2) MUST NOT be dismissible.

### Reveal

After dismissal, the row is immediately hidden from the triage list. A transient
confirmation replaces the row briefly:

> "Moved to Initiatives — tap to find it"

Tapping the confirmation navigates to `/app/initiatives/[id]`.

### Persistence

Dismissed row IDs are stored client-side (localStorage key
`triage-dismissed-<teamId>` as a JSON array of initiative IDs). Server state is
NOT mutated — a full page refresh clears the dismissal. This is intentional: the
affordance is a noise-reduction shortcut, not a permanent archive action.

### Undo

The confirmation banner persists for 4 seconds. During that window it acts as an
undo: tapping "tap to find it" restores the row to the list rather than navigating
away. After 4 seconds the banner fades and the row stays hidden until the next
page load.

---

## 9. Acceptance Criteria

### Progress computation (canonical)

- **AC-1**: GIVEN an initiative with two missions (A: 3/5 tasks done, B: 1/4 tasks done),
  WHEN progress is computed, THEN the result is `round((3+1)/(5+4)*100) = 44%`.
- **AC-2**: GIVEN an initiative whose missions all have `totalTasks === 0` and two of
  three missions have `status = 'completed'`, WHEN progress is computed, THEN the
  result is `round(2/3*100) = 67%` (mission-weighted fallback).
- **AC-3**: GIVEN a mission with 25 deliverable tasks, WHEN its progress is computed
  for the initiative rollup, THEN all 25 tasks are counted (task cap of 20 does NOT
  apply to initiative-level rollup queries).
- **AC-4**: GIVEN a workspace filter is active on the Missions page, WHEN initiative
  progress is displayed, THEN it reflects ALL of the initiative's missions across
  ALL workspaces (not just the filtered workspace).

### Effort API

- **AC-5**: `GET /api/initiatives/effort` returns 401 when called without auth.
- **AC-6**: GIVEN a team with 3 active initiatives, WHEN the endpoint is called,
  THEN `items` contains 3 entries (plus an unassigned entry if applicable).
- **AC-7**: GIVEN an initiative with no worker activity in the last 14 days, WHEN
  the endpoint responds, THEN `effortDays` contains exactly 14 entries all with
  `tokens: 0`.
- **AC-8**: GIVEN missions with no `initiativeId`, WHEN the endpoint responds,
  THEN a single `__unassigned__` entry aggregates their effort.
- **AC-9**: GIVEN a worker with `input_tokens=1000, output_tokens=500` that ran on
  2026-08-10, WHEN the endpoint is called, THEN the `date: "2026-08-10"` entry
  in the matching initiative's `effortDays` has `tokens: 1500`.

### SparklineBar

- **AC-10**: GIVEN 14 `EffortDay` entries where the max `tokens` is 2000,
  WHEN rendered, THEN the tallest bar reaches the full `height` and all other
  bars are proportionally shorter.
- **AC-11**: GIVEN all 14 days with `tokens: 0`, WHEN rendered, THEN all 14 bars
  appear at minimum height (≥1px) rather than zero height.

### Zone sorting

- **AC-12**: GIVEN initiative A with `awaitingVerification: 2, blocked: 0` and
  initiative B with `awaitingVerification: 0, blocked: 0, shippedThisWeek: 3`,
  WHEN the triage list renders, THEN A appears in Zone 1 and B appears in Zone 2
  with a divider between them.
- **AC-13**: GIVEN an initiative with all zero pending actions and all zero tokens
  in `effortDays`, WHEN the triage list renders, THEN it does NOT appear in Zone 1
  or Zone 2, and a "Show N dormant" affordance becomes visible.

### Subline

- **AC-14**: GIVEN `awaitingVerification: 0, blocked: 0, held: 0, shippedThisWeek: 0`,
  WHEN an `InitiativeTriageRow` renders, THEN no subline element appears in the DOM.
- **AC-15**: GIVEN `awaitingVerification: 2, blocked: 1, held: 0`, WHEN an
  `InitiativeTriageRow` renders, THEN the subline reads `"2 awaiting merge · 1 blocked"`.

### Dismiss

- **AC-16**: GIVEN a dormant (Zone 3) initiative row, WHEN the user swipes to dismiss,
  THEN the row is hidden and a confirmation banner appears.
- **AC-17**: GIVEN the same dismissed initiative row, WHEN the user refreshes the page,
  THEN the row reappears (dismissal is NOT persisted to the server).

---

## 10. Code Surface

**Data shapes** (to be created):
- `apps/web/src/app/app/(protected)/missions/triage-types.ts` — `EffortDay`, `InitiativeTriageItem`

**API route** (to be created):
- `apps/web/src/app/api/initiatives/effort/route.ts` — `GET /api/initiatives/effort`

**Components** (to be created):
- `apps/web/src/components/SparklineBar.tsx` — `SparklineBar`
- `apps/web/src/app/app/(protected)/missions/InitiativeTriageRow.tsx` — `InitiativeTriageRow`
- `apps/web/src/app/app/(protected)/missions/InitiativeTriage.tsx` — list + zone divider + dismiss state

**Existing helpers** (unchanged):
- `packages/core/mission-helpers.ts` — `computeMissionProgress`, `computeInitiativeProgress` (correct algorithm; fix is in query scope, not here)
- `apps/web/src/app/app/(protected)/missions/page.tsx` — server component that feeds the triage list

**Bug to fix in the same PR**:
- `apps/web/src/app/app/(protected)/missions/page.tsx` lines 88–118: add `workers` columns to the `teamInitiatives` task subquery (for correct segment state in the strip).
- `apps/web/src/app/app/(protected)/missions/page.tsx` lines 145–165: remove `limit: 20` from the tasks subquery when computing initiative group progress, OR move initiative progress computation to the new effort endpoint (preferred — decouples the page load from the heavy join).

---

## Out of Scope

- Real-time updates (WebSocket / Pusher) for the triage row counts — polling on
  page focus is sufficient.
- Per-task drill-down from the sparkline — the bar links to the initiative detail page only.
- Archiving or deleting initiatives from the triage surface.
- Effort breakdown by workspace or role within an initiative row.
- Historical data beyond the 14-day window.
- Mobile swipe gesture implementation details (CSS/animation spec lives in the design doc).
