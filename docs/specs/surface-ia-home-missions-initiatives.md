---
title: Surface IA — Home, Missions, Initiatives
status: draft
owner: max
last_verified: 2026-08-29
summary: Each of the three primary surfaces MUST answer exactly one question — Home what needs me now, Missions what state each mission is in, Initiatives are we winning — and a derived verdict MUST show its own missing evidence.
domain: surfaces
surfaces: [apps/web/src/lib/initiative-pulse.ts, apps/web/src/lib/verdict-presentation.ts, apps/web/src/lib/initiative-presentation.ts, apps/web/src/app/app/(protected)/home/page.tsx]
related: [mission-task-lifecycle, timeline-dependency-geometry]
keywords: [losing, grinding, won_unclaimed, awaitingVerification, criteriaFail, effortDays, verdict ladder, unverified confidence]
supersedes: [missions-tab-triage]
---

# Surface IA — Home, Missions, Initiatives

**Capability statement**: Each of the three primary surfaces MUST answer exactly
one question — Home: *what needs me right now*; Missions: *what state is every
mission in*; Initiatives: *are we winning, and on which arc* — and a signal MUST
NOT appear on a surface whose question it does not answer.

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

   The root cause is a dimension that was designed and then skipped.
   `initiative-presentation.ts` documents three orthogonal dimensions borrowed
   from Linear — `status` (DB lifecycle), `progress` (derived), `health`
   (*"derived/evaluated: on mission cards, not initiative cards"*). Initiatives
   got the first two. With health absent, an initiative can only be described by
   its paperwork and a fraction, so a percentage became the headline by default.
   §6.5 supplies the missing dimension.
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
| Verdict label (§6.5) | as clause counts | MUST NOT | MUST (leads the row) | MUST (leads the page) |
| Verdict evidence numbers | MUST NOT | MUST NOT | MUST NOT | MUST |
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

Clauses count **initiatives by verdict** (§6.5) — not missions, not PRs:

| Clause | Source | Copy |
|---|---|---|
| losing arcs | verdict `losing` | `N losing` |
| grinding arcs | verdict `grinding` | `N grinding` |
| stuck arcs | verdict `stuck` | `N stuck` |
| finished arcs nobody closed | verdict `won_unclaimed` | `N ready to close` |

Clause order is fixed and is the ladder's own order: losing → grinding → stuck →
ready to close. A clause with a zero count is omitted entirely. Arcs that are
`winning`, `dormant` or `empty` contribute no clause, so a team that is winning
everywhere gets **no line at all** — no label, no header, no "nothing to see"
text.

That is the whole point of the line: it fires only when the answer to *are we
winning* is no.

Link target: `/app/initiatives` when more than one initiative contributes;
`/app/initiatives/<id>` when exactly one does.

### 2.3 Why verdict clauses and not merge/review counts

The mockup for this line read `4 awaiting merge · 1 blocked`. `awaiting merge` is
excluded deliberately: the Waiting-on-You queue directly below the line already
lists each of those PRs as a `MERGE` card, so the count would restate the very
rows it sits above, and the two numbers would drift the moment the queue's
dedup-by-`subjectKey` dropped an item the count still included.

Every clause that survives is an initiative-level state the action queue
structurally cannot show. `held` and `blocked` are work that is stuck *without*
waiting on the user, so they never reach the queue — they appear here as evidence
behind `stuck`. `grinding` is invisible to every existing surface: tokens burn,
tasks close, the percentage climbs, nothing merges. And `ready to close` is the
honest reading of the `AWAITING` chip the rail was displaying.

**Invariant**: for every subject key in the Waiting-on-You queue, that subject
contributes to no clause of the pulse line.

### 2.4 Cost

The line is fed by one call to the shared loader (§6), scoped to the active
team. Home's query count MUST increase by at most one relative to v0.168.0, and
the loader MUST NOT be called per initiative.

### 2.5 Acceptance criteria

- **AC-1**: GIVEN a team whose every initiative has verdict `winning`,
  `dormant` or `empty`, WHEN Home renders, THEN no pulse line element is present
  in the DOM.
- **AC-2**: GIVEN initiative A with verdict `grinding` and initiative B with
  verdict `stuck`, WHEN Home renders, THEN the line reads
  `Initiatives · 1 grinding · 1 stuck` and links to `/app/initiatives`.
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
[ Verdict ] [ Title (truncated) ]  [ sparkline 84×24 ] [ XX% ]
[ subline — only when a signal exists ]
[ N/M missions · N/M tasks ]
```

The verdict (§6.5) leads the row, with its confidence qualifier when
`unverified`. The percentage stays, at the far right, as the scope meter it is —
it MUST NOT be styled as the row's primary signal.

### 4.2 Subline

Rendered only when at least one condition holds, all true conditions joined by
` · ` in this order: `N awaiting merge` (awaitingVerification) → `N blocked` →
`N held` → `N shipped this week` (only when the first three are all zero). When
none hold, no subline element appears in the DOM.

### 4.3 Zones

Rows are partitioned by verdict, not by pending-action count — the list is
ordered by *are we winning*, so the answer is readable top-down:

- **Not winning** — verdict `losing`, `grinding`, `stuck` or `won_unclaimed`,
  sorted in exactly that ladder order. Within one verdict, sort by descending
  `awaitingVerification + blocked + held`, then descending `progress`.
- **Winning** — verdict `winning`. Sorted by descending `merges7d`, then
  descending 14-day token total.
- **Dormant** — verdict `dormant` or `empty`. Collapsed behind a
  `Show N dormant` disclosure; MUST NOT appear in either zone above.

A single visual divider renders between Not-winning and Winning, and only when
both are non-empty.

A `losing` row MUST be reachable without scrolling whenever one exists: it is the
first row of the first zone.

### 4.4 Dismissal

Dormant rows only. Dismissal writes the initiative id to `localStorage` key
`triage-dismissed-<teamId>`, hides the row, and shows a 4-second banner that acts
as undo. Server state is not mutated; a reload restores the row. A row in the
Needs-you or Recent zone MUST NOT be dismissible by swipe or by button.

### 4.5 Acceptance criteria

- **AC-13**: GIVEN 3 initiatives, WHEN `/app/initiatives` renders, THEN exactly 3
  initiative rows are present and each renders exactly one sparkline.
- **AC-14**: GIVEN initiative A with verdict `stuck` (`awaitingVerification: 2,
  blocked: 1`) and initiative B with verdict `winning`, WHEN the list renders,
  THEN A precedes B, a divider separates them, and A's subline reads
  `2 awaiting merge · 1 blocked`.
- **AC-14a**: GIVEN a `losing` arc and a `grinding` arc, WHEN the list renders,
  THEN the `losing` arc is the first row on the page.
- **AC-15**: GIVEN an initiative with zero pending actions and zero tokens across
  14 days, WHEN the list renders, THEN it is absent from both zones and a
  `Show 1 dormant` control is present.
- **AC-16**: GIVEN a row in the Not-winning or Winning zone, WHEN a swipe-dismiss
  gesture is performed on it, THEN the row remains visible and no `localStorage`
  write occurs.
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
status; **verdict and its evidence**; description; rollup (`progress %`,
`n/m missions · n/m tasks`, `SegmentStrip`); **pending-action strip**; **14-day
effort sparkline**; KPI panel (only when KPIs are set); missions list; artifacts
(only when non-empty).

The three new blocks:

- **Verdict and evidence** — the §6.5 verdict as the page's first claim, with its
  confidence qualifier, followed by the numbers it was derived from:
  `3 merged · 11 attempts · 240k tokens · 7d`. The evidence line is mandatory: a
  verdict a reader cannot audit is a slogan. When confidence is `unverified`, the
  block links to the KPI editor so the fix for "nothing checked this" is one
  click from the claim.

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

type Verdict = 'losing' | 'grinding' | 'stuck' | 'won_unclaimed' | 'winning' | 'dormant' | 'empty';
type Confidence = 'verified' | 'unverified';

interface InitiativePulse {
  id: string;                   // initiative uuid, or '__unassigned__'
  title: string;
  progress: number;             // 0–100, canonical (§6.3) — scope meter, not the headline
  effortDays: EffortDay[];      // exactly 14 entries, oldest first
  awaitingVerification: number; // completed tasks whose PR is open and unclosed
  blocked: number;              // pending tasks blocked on an unmerged PR
  held: number;                 // child missions with isHeld = true
  shippedThisWeek: number;      // missions shipped within 7 days
  // Verdict (§6.5) and the evidence it was derived from. Every surface that
  // shows a verdict MUST also be able to show these numbers.
  verdict: Verdict;
  confidence: Confidence;
  merges7d: number;
  attempts7d: number;
  tokens7d: number;
  criteriaFail: number;
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

### 6.5 The winning verdict

Progress percentage answers *how much scope is checked off*. It MUST NOT be used
to answer *are we winning*, because task count is the one quantity an autonomous
fleet inflates by working: more tasks closed, same outcome. The verdict below is
the initiative-level `health` dimension §0.1 describes as missing.

It has two independent parts. **Never collapse them into one word.**

#### Verdict — derived from motion

Inputs, per initiative, all already available:

| Input | Derivation |
|---|---|
| `merges7d` | workers with `mergedAt >= now - 7d` on tasks under the initiative |
| `attempts7d` | tasks created in 7d where `deriveTaskType(task) !== null` |
| `tokens7d` | sum of the last 7 entries of `effortDays` |
| `criteriaFail` | child missions whose `goalCriteriaState.overall === 'fail'`, plus the initiative's own `kpiState.overall === 'fail'` |
| | Counts `fail` only, never `UNVERIFIED`. As of PR #1901 an `all_prs_merged` criterion on a mission with no PRs yields `UNVERIFIED` rather than `fail` (absence of evidence is not a contradiction), so a PR-less mission no longer pushes an arc to `losing`. Such a mission still cannot complete — it surfaces through `awaitingVerification`, which is the correct signal for "nobody has answered this" — and `confidence` stays `unverified`. |
| `held`, `blocked`, `awaitingVerification` | §6.1 |
| `allTerminal` | every child mission is in a terminal status |

`THRASH_RATIO = 3`. The ladder is evaluated top to bottom; the first match wins,
and it is total — every initiative gets exactly one verdict:

```
totalMissions === 0                                        → 'empty'
criteriaFail > 0                                           → 'losing'
tokens7d > 0 && attempts7d > THRASH_RATIO * max(merges7d,1) → 'losing'
allTerminal && status === 'active'                          → 'won_unclaimed'
tokens7d > 0 && merges7d === 0                              → 'grinding'
tokens7d > 0                                                → 'winning'
held + blocked + awaitingVerification > 0                   → 'stuck'
                                                            → 'dormant'
```

Each verdict's meaning, and the copy that MUST be used for it:

| Verdict | Label | What it says |
|---|---|---|
| `losing` | `Losing` | A verified criterion failed, or rework is outrunning ships 3:1 |
| `grinding` | `Grinding` | Tokens burning, tasks closing, nothing merged in 7 days |
| `stuck` | `Stuck` | Nothing burning, but something is held, blocked, or awaiting merge |
| `won_unclaimed` | `Ready to close` | Every mission terminal, nothing failing, initiative still open |
| `winning` | `Winning` | Merging, nothing failing, rework within ratio |
| `dormant` | `Dormant` | No burn, no pending action |
| `empty` | `Empty` | No child missions |

`grinding` is the state a percentage cannot express: tasks close, the bar advances,
and nothing ships. It MUST be reachable on Home (§2.2).

#### Confidence — derived from the oracle

- `verified` — every child mission has goal criteria and an `overall` of `pass`
  or `fail`, or the initiative's own KPIs have a non-`UNVERIFIED` `overall`.
- `unverified` — otherwise: criteria absent, or present and `UNVERIFIED`.

A verdict at `unverified` confidence MUST be rendered with the qualifier
(`Winning · unverified`), never bare. This is not decoration: as of 2026-08-16 no
initiative in the reference team has KPIs set — the KPI panel only mounts when
`kpis.length > 0` and it does not render on any current arc — so every verdict
starts `unverified` and gets sharper only where someone defines criteria. A
derived verdict that hides its own missing evidence is worse than no verdict.

Confidence MUST NOT change the verdict. `won_unclaimed · unverified` means
"looks finished, nothing checked it", and that difference is the entire reason
the `AWAITING` chip was uninformative.

### 6.6 Acceptance criteria

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
- **AC-30**: GIVEN an initiative with `tokens7d: 40000, merges7d: 0`, WHEN the
  verdict is derived, THEN it is `grinding` — regardless of its progress
  percentage.
- **AC-31**: GIVEN an initiative with `merges7d: 2, attempts7d: 9,
  criteriaFail: 0`, WHEN the verdict is derived, THEN it is `losing`
  (9 > 3 × 2); GIVEN `attempts7d: 6`, THEN it is `winning` (6 ≤ 3 × 2).
- **AC-32**: GIVEN one child mission with `goalCriteriaState.overall === 'fail'`
  and `merges7d: 5`, WHEN the verdict is derived, THEN it is `losing` — a
  verified failure outranks every motion signal.
- **AC-33**: GIVEN every child mission terminal, no failing criteria, and
  initiative status `active`, WHEN the verdict is derived, THEN it is
  `won_unclaimed` and the label reads `Ready to close`.
- **AC-34**: GIVEN `tokens7d: 0` and `held: 1`, WHEN the verdict is derived,
  THEN it is `stuck`; GIVEN `tokens7d: 0` and zero pending actions, THEN it is
  `dormant`.
- **AC-35**: GIVEN an initiative with zero child missions, WHEN the verdict is
  derived, THEN it is `empty` and no other rule is evaluated.
- **AC-36**: GIVEN an initiative whose child missions have no goal criteria,
  WHEN its verdict renders on any surface, THEN the label carries the
  `unverified` qualifier and the verdict itself is unchanged from what the motion
  ladder produced.
- **AC-37**: GIVEN two initiatives whose inputs differ only in `progress`, WHEN
  verdicts are derived, THEN both verdicts are identical — progress is not an
  input to the ladder.

---

## 7. Migration

Ordered so that no intermediate commit leaves a surface without its signal:

1. ~~Extract the loader (§6.2); point the inline Missions query and the effort
   route at it.~~ **Done** — `apps/web/src/lib/initiative-pulse.ts` (#1701).
2. ~~Extend the loader with the verdict inputs — `merges7d`, `attempts7d`,
   `tokens7d`, `criteriaFail` — and add `deriveVerdict` as a pure function with
   the §6.5 ladder. Nothing renders it yet; the ladder is unit-tested first
   because every surface below depends on it being total.~~ **Done** — #1707,
   with #1709 threading `mode` into the `attempts7d` classifier.
3. ~~Add the verdict-led triage rows to `/app/initiatives` at `84×24`.~~
   **Done** — #1710. The triage components moved out of `missions/` in the same
   commit rather than living on both tabs for one, because the move is what
   makes them verdict-shaped; the Missions page therefore already lost its
   triage mount.
4. Apply the workspace-header rule (§3.3); delete the dead initiative-grouping
   path (§3.2).
5. Replace `InitiativeRail` on Home with the pulse line (§2). Delete
   `InitiativeRail` and its component file once no surface mounts it.
6. Add the verdict-and-evidence block, the pending-action strip and the large
   sparkline to the detail page (§5).

The mission-state group headers on `/app/missions` are expected to converge on
the shared `GroupSection` primitive introduced by PR #1699 once it lands; until
then the existing `SECTION_DISPLAY` headers stay. This spec does not require the
swap and MUST NOT be blocked on it.

---

**Code surface**

- `apps/web/src/app/app/(protected)/home/page.tsx` — Home; currently mounts the
  rail and builds `actionQueue`.
- `apps/web/src/components/InitiativeRail.tsx` — the rail to be removed (§2.1).
- `apps/web/src/app/app/(protected)/missions/page.tsx` — Missions; no longer
  mounts triage or loads effort (#1710).
- `apps/web/src/app/app/(protected)/missions/MissionGrid.tsx` — mission grouping,
  workspace buckets, the dead initiative-group path.
- `apps/web/src/app/app/(protected)/initiatives/InitiativeTriage.tsx` — zone
  partition, dismissal state; relocated from `missions/` in #1710.
- `apps/web/src/app/app/(protected)/initiatives/InitiativeTriageRow.tsx` — row
  anatomy; sparkline mount size lives here.
- `apps/web/src/lib/verdict-presentation.ts` — `Verdict`, `Confidence`,
  `VERDICT_LABEL`, `verdictChip`, `InitiativePulse`,
  `partitionInitiativeZones`. The client-safe half of §6.5: client components
  need the labels, and `initiative-pulse.ts` imports the database. Supersedes
  `missions/triage-types.ts` and its `InitiativeTriageItem`.
- `apps/web/src/components/SparklineBar.tsx` — presentational sparkline (§6.4).
- `apps/web/src/app/app/(protected)/initiatives/page.tsx` — Initiatives list; the
  triage host.
- `apps/web/src/app/app/(protected)/initiatives/[id]/page.tsx` — detail; gains
  the pending-action strip and the large sparkline.
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
  `computeInitiativeProgress`, `computeInitiativeSegments`; also `deriveTaskType`
  (the `attempts7d` oracle) and the `GoalCriteriaState` / `InitiativeKPIState`
  evaluators behind `criteriaFail` and `confidence`.
- `apps/web/src/lib/initiative-pulse.ts` — `loadInitiativeEffort`,
  `derivePendingCounts` (#1701); gains the verdict inputs and `deriveVerdict`.
- `apps/web/src/app/api/initiatives/[id]/evaluate/route.ts` — fills the KPI
  verdicts that move `confidence` from `unverified` to `verified`.
- `apps/web/src/app/app/(protected)/initiatives/[id]/InitiativeKPIPanel.tsx` —
  KPI editor the unverified verdict block links to.

**New files**

- ~~`apps/web/src/lib/initiative-pulse.ts`~~ — done (#1701, #1707). The
  `InitiativePulse` shape itself lives in `verdict-presentation.ts`, so client
  components can import it without reaching the database.
- `apps/web/src/components/InitiativePulseLine.tsx` — the Home line (§2).
- ~~`apps/web/src/app/app/(protected)/initiatives/InitiativeTriage.tsx`~~ — done
  (#1710); moved, not copied.

**Out of scope**

- Real-time updates for any count; refresh on navigation is sufficient.
- Per-day drill-down from a sparkline bar.
- Archiving, deleting, or reordering initiatives from any surface.
- Effort attribution by workspace, role, or model within an initiative.
- History beyond the 14-day window, and any cost/dollar rendering.
- Mobile swipe animation details; the gesture contract is §4.4.
- The `GroupSection` / `MissionProgressBar` convergence tracked by PR #1699.
- A **human-declared** health status. Linear's model has a project lead set On
  track / At risk / Off track and write a periodic update; buildd has no such
  lead by design, so §6.5 derives the verdict instead. If a declared override is
  ever wanted, it belongs in its own spec and MUST NOT silently replace the
  derived verdict — a claim nobody can audit is what §5.1's evidence line exists
  to prevent.
- Verdict history and trend ("winning for 3 weeks"). Nothing stores a verdict
  time series today; `initiative_progress_seen` holds one percentage per user per
  initiative, which is a milestone tripwire, not history.
- Tuning `THRASH_RATIO` per workspace or per initiative. One constant, team-wide,
  until there is evidence it misclassifies.
