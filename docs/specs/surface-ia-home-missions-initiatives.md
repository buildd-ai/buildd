---
title: Surface IA — Home, Missions, Initiatives
status: draft
owner: max
last_verified: 2026-08-16
supersedes: [missions-tab-triage]
---

# Surface IA — Home, Missions, Initiatives

**Capability statement**: Each of the three primary surfaces MUST answer exactly
one question — Home: *what needs me right now*; Missions: *what state is every
mission in*; Initiatives: *which arc deserves attention, and everything about one
arc* — and a signal MUST NOT appear on a surface whose question it does not
answer.

**Invariants**

- No initiative-scoped list, card rail, or triage row is rendered on Home or on
  the Missions tab. Cross-initiative comparison exists on `/app/initiatives`
  only.
- No mission-state grouping (`RUNNING NOW`, `NEEDS ATTENTION`, …) is rendered on
  `/app/initiatives` or `/app/initiatives/[id]`.
- Every count shown for an initiative on any surface is produced by a single
  loader (§6). Two surfaces MUST NOT compute the same initiative count from two
  query scopes.
- A surface renders zero chrome for an empty signal: no header, no label, no
  zero-state row. Absence is the empty state.
- Home MUST NOT restate an item that the Waiting-on-You queue already lists
  (§2.3).

---

## 0. Why this spec exists

Three falsifiable observations about the shipped surfaces, as of v0.168.0:

1. **Home's initiative rail is a bookkeeping display, not a daily one.** All
   three cards render the chip `AWAITING` because
   `deriveInitiativeDisplayStatus` returns `awaiting_verification` whenever every
   child mission is terminal and the initiative has not been marked complete. The
   second signal on the card is a rollup percentage that moves at most once a
   day. Neither tells the reader what to do today.
2. **The triage surface is hosted on the wrong tab.** `InitiativeTriage` — 14-day
   sparkline, pending-action subline, zone sorting — renders at the top of
   `/app/missions`, the surface whose subject is mission state. `/app/initiatives`,
   whose subject *is* the initiative, shows none of it.
3. **The effort aggregation already exists twice and disagrees.**
   `apps/web/src/app/api/initiatives/effort/route.ts` is workspace-scoped
   (rejects a request with no `workspaceId`, keys the no-initiative bucket
   `'unassigned'`); the inline query in `apps/web/src/app/app/(protected)/missions/page.tsx`
   is team-scoped and keys it `'__unassigned__'`. `SparklineBar` is mounted at
   `48×16` where the superseded spec specified `84×24`, so 14 bars get 2.5px
   each and a live initiative reads as a dotted baseline.

This spec fixes placement (§1–§5) and collapses the duplicated data path (§6).

---

## 1. Placement matrix

`MUST` = renders when its signal is non-empty. `MUST NOT` = never rendered on
that surface. `—` = not applicable.

| Element | Home | Missions | Initiatives list | Initiative detail |
|---|---|---|---|---|
| Initiative card rail (160px cards) | MUST NOT | MUST NOT | MUST NOT | — |
| One-line initiative pulse (§2) | MUST | MUST NOT | MUST NOT | MUST NOT |
| Arc headline (milestone crossing) | MUST | MUST NOT | MUST NOT | MUST NOT |
| Initiative triage row (sparkline + pending counts + %) | MUST NOT | MUST NOT | MUST | MUST NOT |
| Mission-state groups (`GROUP_ORDER`) | active subset only | MUST | MUST NOT | MUST NOT |
| Workspace grouping header | MUST NOT | conditional (§3.3) | MUST NOT | MUST NOT |
| 14-day effort sparkline | MUST NOT | MUST NOT | MUST (84×24) | MUST (≥168×32) |
| Pending-action counts as links | MUST NOT | MUST NOT | MUST (subline) | MUST (strip) |
| KPI panel, artifacts | MUST NOT | MUST NOT | MUST NOT | MUST |

---

## 2. Home — the initiative pulse line

### 2.1 Replacement

`InitiativeRail` MUST NOT be mounted on Home. In its place Home renders **at most
one line**, between the greeting block and the Waiting-on-You section.

The arc headline mechanism is unchanged: when an initiative crossed a 10%
milestone since this user's last visit, the headline replaces the greeting and the
`initiative_progress_seen` snapshot is refreshed. That behaviour is orthogonal to
the pulse line; both MAY render in the same load.

### 2.2 Clause set and copy

The line is `Initiatives · <clause> · <clause> →`, or, when exactly one
initiative contributes every clause, `<initiative title> · <clause> · … →`.

| Clause | Source | Copy |
|---|---|---|
| held missions | `sum(held)` over initiatives | `N held` |
| PR-blocked pending tasks | `sum(blocked)` over initiatives | `N blocked` |
| initiatives ready to close | count where display status is `awaiting_verification` | `N ready to close` |

Clause order is fixed: held → blocked → ready to close. A clause with a zero
count is omitted entirely. When all three are zero the line is not rendered —
no label, no header, no "nothing to see" text.

Link target: `/app/initiatives` when more than one initiative contributes;
`/app/initiatives/<id>` when exactly one does.

### 2.3 Why these three clauses and not merge/review counts

The mockup for this line read `4 awaiting merge · 1 blocked`. `awaiting merge` is
excluded deliberately: the Waiting-on-You queue directly below the line already
lists each of those PRs as a `MERGE` card, so the count would restate the very
rows it sits above, and the two numbers would drift the moment the queue's
dedup-by-`subjectKey` dropped an item the count still included.

The three chosen clauses are exactly the initiative-level states that the action
queue structurally cannot show: work that is stuck without waiting on the user
(`held`, `blocked`), and an arc whose missions are all finished but which nobody
has closed out (`ready to close`) — which is the real meaning of the `AWAITING`
chip the rail was displaying.

**Invariant**: for every subject key in the Waiting-on-You queue, that subject
contributes to no clause of the pulse line.

### 2.4 Cost

The line is fed by one call to the shared loader (§6), scoped to the active
team. Home's query count MUST increase by at most one relative to v0.168.0, and
the loader MUST NOT be called per initiative.

### 2.5 Acceptance criteria

- **AC-1**: GIVEN a team with 3 initiatives, 0 held missions, 0 PR-blocked
  pending tasks and 0 initiatives in `awaiting_verification`, WHEN Home renders,
  THEN no pulse line element is present in the DOM.
- **AC-2**: GIVEN 2 held missions in initiative A and 1 PR-blocked pending task
  in initiative B, WHEN Home renders, THEN the line reads
  `Initiatives · 2 held · 1 blocked` and links to `/app/initiatives`.
- **AC-3**: GIVEN every non-zero clause comes from initiative A, WHEN Home
  renders, THEN the line is prefixed with A's title and links to
  `/app/initiatives/<A.id>`.
- **AC-4**: GIVEN an initiative whose every child mission is terminal and whose
  DB status is `active`, WHEN Home renders, THEN it contributes `1 ready to
  close`.
- **AC-5**: GIVEN a PR that appears in the Waiting-on-You queue as a `MERGE`
  card, WHEN Home renders, THEN that PR increments no clause of the pulse line.
- **AC-6**: WHEN Home renders, THEN no element sourced from `InitiativeRail` is
  present and `InitiativeRail` is not imported by the Home page module.

---

## 3. Missions — organised by mission, nothing else

### 3.1 Composition

The Missions tab renders, in order and nothing else: the page header (title,
active count, seats chip, workspace filter, `+ New Mission`), the filter tab bar
(`all` / `active` / `scheduled` / `completed`), then mission sections in
`GROUP_ORDER` order using `SECTION_DISPLAY` labels.

`InitiativeTriage` MUST NOT be mounted on this page, and the page module MUST NOT
contain a token-aggregation query.

### 3.2 Initiative representation

An initiative appears on this surface only as a per-card label linking to
`/app/initiatives/<id>` (already implemented on both `FullMissionCard` and
`CompactMissionCard`). The initiative-grouping path in `MissionGrid` —
`initiativeGroups`, `InitiativeGroupData`, `InitiativeGroupSection`,
`groupMissionsByInitiative` — is dead (no caller passes the prop) and MUST be
deleted along with its test file.

### 3.3 Workspace headers

Let `N` = the number of named workspace buckets holding ≥1 mission visible under
the active filter, and `U` = true when the team-level bucket (`workspaceId IS
NULL`) holds ≥1 visible mission.

- `N ≥ 2` → every bucket renders a header; the team-level bucket is labelled
  `Team-level`.
- `N = 1` and `U` → the named bucket's header is suppressed; the team-level
  bucket renders a `Team-level` header.
- `N = 1` and not `U` → no workspace header at all.
- `N = 0` → no workspace header at all.

This kills the lone `BUILDD 47` header on a single-workspace team while keeping
team-level missions distinguishable when they coexist with workspace missions.

### 3.4 Acceptance criteria

- **AC-7**: GIVEN a team with 3 active initiatives, WHEN `/app/missions` renders,
  THEN no sparkline SVG and no initiative triage row are present in the DOM.
- **AC-8**: GIVEN all 47 visible missions belong to one workspace and none is
  team-level, WHEN the grid renders, THEN no workspace header is present.
- **AC-9**: GIVEN 47 missions in workspace `buildd` and 3 team-level missions,
  WHEN the grid renders, THEN exactly one workspace header is present and its
  label is `Team-level`.
- **AC-10**: GIVEN missions in two named workspaces, WHEN the grid renders, THEN
  each named bucket renders its own header.
- **AC-11**: GIVEN a mission with `initiativeId` set, WHEN its card renders, THEN
  the card shows the initiative title linking to `/app/initiatives/<id>` and the
  mission is grouped by `healthToGroup`, not by initiative.
- **AC-12**: WHEN the Missions page module is loaded, THEN it exports no
  reference to `groupMissionsByInitiative` and issues no `SUM(input_tokens +
  output_tokens)` query.

---

## 4. Initiatives list — the triage host

### 4.1 Composition

`/app/initiatives` renders exactly one row per initiative — never a triage row
and a separate card for the same initiative. The row carries:

```
[ Title (truncated) ]              [ sparkline 84×24 ] [ XX% ]
[ subline — only when a signal exists ]
[ N/M missions · N/M tasks ]
```

### 4.2 Subline

Rendered only when at least one condition holds, all true conditions joined by
` · ` in this order: `N awaiting merge` (awaitingVerification) → `N blocked` →
`N held` → `N shipped this week` (only when the first three are all zero). When
none hold, no subline element appears in the DOM.

### 4.3 Zones

Rows are partitioned into three zones, in this order:

- **Needs you** — `awaitingVerification > 0 || blocked > 0 || held > 0`. Sorted
  by descending `awaitingVerification + blocked + held`, then descending
  `progress`.
- **Recent** — no pending action, and `effortDays.some(d => d.tokens > 0)`.
  Sorted by descending `shippedThisWeek`, then descending 14-day token total.
- **Dormant** — no pending action and zero tokens across the window. Collapsed
  behind a `Show N dormant` disclosure; MUST NOT appear in either zone above.

A single visual divider renders between Needs-you and Recent, and only when both
are non-empty.

### 4.4 Dismissal

Dormant rows only. Dismissal writes the initiative id to `localStorage` key
`triage-dismissed-<teamId>`, hides the row, and shows a 4-second banner that acts
as undo. Server state is not mutated; a reload restores the row. A row in the
Needs-you or Recent zone MUST NOT be dismissible by swipe or by button.

### 4.5 Acceptance criteria

- **AC-13**: GIVEN 3 initiatives, WHEN `/app/initiatives` renders, THEN exactly 3
  initiative rows are present and each renders exactly one sparkline.
- **AC-14**: GIVEN initiative A with `awaitingVerification: 2, blocked: 1` and
  initiative B with all-zero pending actions but `shippedThisWeek: 3`, WHEN the
  list renders, THEN A precedes B, a divider separates them, and A's subline
  reads `2 awaiting merge · 1 blocked`.
- **AC-15**: GIVEN an initiative with zero pending actions and zero tokens across
  14 days, WHEN the list renders, THEN it is absent from both zones and a
  `Show 1 dormant` control is present.
- **AC-16**: GIVEN a row in the Needs-you zone, WHEN a swipe-dismiss gesture is
  performed on it, THEN the row remains visible and no `localStorage` write
  occurs.
- **AC-17**: GIVEN a dismissed dormant row, WHEN the page is reloaded after the
  banner expires, THEN the row is hidden; WHEN `localStorage` is cleared and the
  page reloaded, THEN the row reappears.
- **AC-18**: GIVEN a team with zero initiatives, WHEN the page renders, THEN only
  the single new-initiative prompt is present — no zone headers, no divider, no
  dormant control.

---

## 5. Initiative detail — the richest surface

### 5.1 Composition

`/app/initiatives/[id]` renders, in order: breadcrumb; title and lifecycle
status; description; rollup (`progress %`, `n/m missions · n/m tasks`,
`SegmentStrip`); **pending-action strip**; **14-day effort sparkline**; KPI panel
(only when KPIs are set); missions list; artifacts (only when non-empty).

The two new blocks:

- **Pending-action strip** — one chip per non-zero count among
  `awaitingVerification`, `blocked`, `held`, `shippedThisWeek`. Each chip links to
  the surface that resolves it: awaiting merge and shipped → the mission or task
  that owns the PR; blocked and held → the mission. A zero count renders no chip.
- **Effort sparkline** — the same `SparklineBar` primitive at `≥168×32`, with the
  per-day `title` attribute `"YYYY-MM-DD: N tokens"`, plus the window total
  rendered as text (`N tokens · 14d`).

### 5.2 Agreement invariant

For any initiative, the four counts on the detail page are identical to the
counts in that initiative's row on `/app/initiatives`, because both read the same
loader (§6). Progress on both surfaces is the canonical task-weighted rollup
(§6.3).

### 5.3 Acceptance criteria

- **AC-19**: GIVEN an initiative with `awaitingVerification: 2, blocked: 0,
  held: 0, shippedThisWeek: 5`, WHEN the detail page renders, THEN exactly two
  chips are present (`2 awaiting merge`, `5 shipped this week`) and no chip
  represents a zero count.
- **AC-20**: GIVEN the same initiative, WHEN both `/app/initiatives` and the
  detail page are rendered, THEN the progress percentage and all four counts are
  equal on both surfaces.
- **AC-21**: GIVEN an initiative with no worker activity in the window, WHEN the
  detail page renders, THEN the sparkline renders 14 minimum-height bars and the
  total reads `0 tokens · 14d` — never an empty or absent element.
- **AC-22**: GIVEN an initiative id belonging to a team the caller is not a
  member of and whose workspace is not open-access, WHEN the detail page is
  requested, THEN it responds 404.
- **AC-23**: GIVEN an initiative with 25 deliverable tasks in one mission, WHEN
  the detail page renders, THEN all 25 are counted in the rollup denominator (no
  per-mission task cap).

---

## 6. Data contract

### 6.1 Shapes

```ts
interface EffortDay {
  date: string;    // ISO "YYYY-MM-DD", UTC
  tokens: number;  // SUM(input_tokens + output_tokens) across workers
  merged: number;  // workers completed with a PR url
  failed: number;  // workers in status 'error'
  open: number;    // workers in neither terminal state
}

interface InitiativePulse {
  id: string;                   // initiative uuid, or '__unassigned__'
  title: string;
  progress: number;             // 0–100, canonical (§6.3)
  effortDays: EffortDay[];      // exactly 14 entries, oldest first
  awaitingVerification: number; // completed tasks whose PR is open and unclosed
  blocked: number;              // pending tasks blocked on an unmerged PR
  held: number;                 // child missions with isHeld = true
  shippedThisWeek: number;      // missions shipped within 7 days
  readyToClose: boolean;        // display status is awaiting_verification
}
```

`effortDays` MUST always contain exactly 14 entries; days with no activity are
back-filled with zeros. `effortDays[13]` is today. The no-initiative bucket key
is `'__unassigned__'` on every code path — the string `'unassigned'` MUST NOT
appear as a bucket key.

### 6.2 One loader, three callers

A single server-side loader is the only producer of `InitiativePulse`. It is
called by Home (§2), the Initiatives list (§4) and the initiative detail page
(§5). Its aggregation is one grouped query over
`workers → tasks → missions`, scoped by team and optionally narrowed to a set of
initiative ids.

The existing HTTP route `GET /api/initiatives/effort` MUST delegate to the same
loader rather than carry its own copy of the SQL, and its workspace-scoped
behaviour is preserved for external callers (400 without `workspaceId`, 401
unauthenticated, 404 when the workspace is outside the caller's teams). No server
component fetches this route over HTTP; server components call the loader
directly.

Two deliberate changes to that route's response follow from the shared loader:
`days` becomes a dense 14-entry window rather than only the days that had rows,
and the no-initiative bucket is keyed `'__unassigned__'` rather than
`'unassigned'`. Callers no longer back-fill the window themselves, and the two
spellings of the bucket key are gone.

The loader is split in two so that neither half forces a query the caller does
not need: `loadInitiativeEffort` owns the SQL, and `derivePendingCounts` derives
the four counts purely from mission rows the caller already holds. A surface that
renders missions therefore pays nothing extra for its counts.

### 6.3 Canonical progress

Initiative progress is task-weighted across **all** child missions and **all**
their deliverable tasks: `round(Σ completedTasks / Σ totalTasks × 100)`, falling
back to mission-weighted when `Σ totalTasks === 0`. The computation MUST NOT be
narrowed by the active workspace filter, by a mission row cap, or by a
per-mission task cap. `computeInitiativeProgress` and `computeMissionProgress`
already implement this; correctness is a property of the query scope handed to
them.

### 6.4 Sparkline rendering

One bar per `EffortDay`, oldest → newest, height proportional to `tokens`
normalised within that initiative's own window. The window is anchored on today:
the rightmost bar is today even when the initiative's last activity is older.
A renderer MUST NOT align its slots to the latest date present in its input —
doing so drew a six-day-old burst at the right-hand edge and made a silent
initiative read as busy. All-zero windows render 14
minimum-height bars. Each bar is segmented `merged` (success) → `failed` (error)
→ `open` (accent) from the top; a day with tokens but no segment counts fills
accent. Default mount size is `84×24`; the initiative detail page mounts
`≥168×32`. A mount smaller than `84×24` is a spec violation.

### 6.5 Acceptance criteria

- **AC-24**: GIVEN a worker with `input_tokens=1000, output_tokens=500` attributed
  to 2026-08-10, WHEN the loader runs, THEN that initiative's `2026-08-10` entry
  has `tokens: 1500`.
- **AC-25**: GIVEN an initiative with activity on 2 of the last 14 days, WHEN the
  loader runs, THEN `effortDays.length === 14` and the 12 inactive entries have
  `tokens: 0`.
- **AC-26**: GIVEN missions with no `initiativeId`, WHEN the loader runs, THEN
  their effort is aggregated under the key `'__unassigned__'`.
- **AC-27**: WHEN `GET /api/initiatives/effort` is called without credentials,
  THEN it responds 401; WHEN called with credentials but no `workspaceId`, THEN
  it responds 400; WHEN called with a `workspaceId` outside the caller's teams,
  THEN it responds 404.
- **AC-28**: GIVEN a workspace filter is active on any surface, WHEN initiative
  progress is displayed, THEN it reflects all of the initiative's missions across
  all workspaces.
- **AC-29**: GIVEN an initiative rendered on two surfaces in the same request
  cycle, WHEN both render, THEN both display the same `progress`,
  `awaitingVerification`, `blocked` and `held` values.

---

## 7. Migration

Ordered so that no intermediate commit leaves a surface without its signal:

1. Extract the loader (§6.2); point the inline Missions query and the effort
   route at it. No visible change.
2. Add the triage rows to `/app/initiatives` at `84×24`. Triage now exists on
   both tabs for one commit.
3. Remove `InitiativeTriage` from `/app/missions`; apply the workspace-header
   rule (§3.3); delete the dead initiative-grouping path (§3.2).
4. Replace `InitiativeRail` on Home with the pulse line (§2). Delete
   `InitiativeRail` and its component file once no surface mounts it.
5. Add the pending-action strip and the large sparkline to the detail page (§5).

The mission-state group headers on `/app/missions` are expected to converge on
the shared `GroupSection` primitive introduced by PR #1699 once it lands; until
then the existing `SECTION_DISPLAY` headers stay. This spec does not require the
swap and MUST NOT be blocked on it.

---

**Code surface**

- `apps/web/src/app/app/(protected)/home/page.tsx` — Home; currently mounts the
  rail and builds `actionQueue`.
- `apps/web/src/components/InitiativeRail.tsx` — the rail to be removed (§2.1).
- `apps/web/src/app/app/(protected)/missions/page.tsx` — Missions; holds the
  inline effort query and mounts `InitiativeTriage`.
- `apps/web/src/app/app/(protected)/missions/MissionGrid.tsx` — mission grouping,
  workspace buckets, the dead initiative-group path.
- `apps/web/src/app/app/(protected)/missions/InitiativeTriage.tsx` — zone
  partition, dismissal state; moves to the Initiatives list.
- `apps/web/src/app/app/(protected)/missions/InitiativeTriageRow.tsx` — row
  anatomy; sparkline mount size lives here.
- `apps/web/src/app/app/(protected)/missions/triage-types.ts` — `EffortDay`,
  `InitiativeTriageItem`; superseded by `InitiativePulse`.
- `apps/web/src/components/SparklineBar.tsx` — presentational sparkline (§6.4).
- `apps/web/src/app/app/(protected)/initiatives/page.tsx` — Initiatives list; the
  new triage host.
- `apps/web/src/app/app/(protected)/initiatives/[id]/page.tsx` — detail; gains
  the pending-action strip and the large sparkline.
- `apps/web/src/components/InitiativeCard.tsx` — current list row, folded into
  the triage row.
- `apps/web/src/app/api/initiatives/effort/route.ts` — HTTP effort endpoint;
  delegates to the loader.
- `apps/web/src/lib/initiative-list.ts` — `loadInitiativeList`,
  `InitiativeListItem`.
- `apps/web/src/lib/initiative-presentation.ts` —
  `deriveInitiativeDisplayStatus`, `sortInitiatives`.
- `apps/web/src/lib/action-queue.ts` — `ActionQueueItem`, `subjectKey` dedup
  (§2.3).
- `apps/web/src/lib/mission-helpers.ts` — `MissionGroup`, `GROUP_ORDER`,
  `SECTION_DISPLAY`, `healthToGroup`.
- `packages/core/mission-helpers.ts` — `computeMissionProgress`,
  `computeInitiativeProgress`, `computeInitiativeSegments`.

**New files**

- `apps/web/src/lib/initiative-pulse.ts` — `loadInitiativePulse`,
  `InitiativePulse` (§6.2).
- `apps/web/src/components/InitiativePulseLine.tsx` — the Home line (§2).
- `apps/web/src/app/app/(protected)/initiatives/InitiativeTriage.tsx` — the
  relocated zone list (moved, not copied).

**Out of scope**

- Real-time updates for any count; refresh on navigation is sufficient.
- Per-day drill-down from a sparkline bar.
- Archiving, deleting, or reordering initiatives from any surface.
- Effort attribution by workspace, role, or model within an initiative.
- History beyond the 14-day window, and any cost/dollar rendering.
- Mobile swipe animation details; the gesture contract is §4.4.
- The `GroupSection` / `MissionProgressBar` convergence tracked by PR #1699.
