---
title: Surface IA — Home, Missions, Initiatives
status: active
owner: max
last_verified: 2026-09-26
summary: Home, Missions and Initiatives MUST each answer one question (what needs me, what state is each mission in, what do an initiative's missions need) and MUST place release state per §8-10.
domain: surfaces
surfaces: [apps/web/src/app/app/(protected)/home/page.tsx, apps/web/src/app/app/(protected)/missions/page.tsx, apps/web/src/lib/initiative-view.ts]
related: [initiatives, mission-task-lifecycle, timeline-dependency-geometry, release-flow]
keywords: [placement matrix, release, ship state, empty-state doctrine, unseeded baseline, integration branch, workspace headers]
supersedes: [missions-tab-triage]
verified_by: [apps/web/src/app/app/(protected)/home/home-initiative-rail.test.ts, apps/web/src/lib/initiative-view.test.ts, apps/web/src/app/app/(protected)/missions/[id]/MissionReleaseSection.test.tsx, apps/web/src/components/TaskShipBadge.test.tsx]
# Structural conformance only; passing does not certify every prose invariant.
assertions:
  - id: "initiative-archetype"
    type: "symbol"
    name: "detectArchetype"
    path: "packages/core/release-archetype.ts"
  - id: "initiative-view-tests"
    type: "test_file"
    path: "apps/web/src/lib/initiative-view.test.ts"
---

# Surface IA — Home, Missions, Initiatives

**Capability statement**: Each of the three primary surfaces MUST answer exactly
one question — Home: *what needs me right now*; Missions: *what state is every
mission in*; Initiatives: *what state is each initiative in, and what do its
missions need from me* — and a signal MUST NOT appear on a surface whose question
it does not answer.

**2026-09-26:** the derived initiative verdict this spec introduced (`Losing`,
`Grinding`, `Stuck`, `Ready to close`, `Dormant`, the `unverified` qualifier,
the 14-day effort sparkline and the Home pulse line) was removed. Initiatives
are containers with a human-set status; their list and page are specified in
[`initiatives.md`](initiatives.md). §2 and §4-§7 below are replaced by pointers.
§0 is kept as history. §3 and §8-§10 are unchanged.

**Invariants**

- No initiative-scoped list, card rail, or triage row is rendered on Home or on
  the Missions tab. Cross-initiative comparison exists on `/app/initiatives`
  only.
- No mission-state grouping (`RUNNING NOW`, `NEEDS ATTENTION`, …) is rendered on
  `/app/initiatives` or `/app/initiatives/[id]`.
- Every count shown for an initiative on the Initiatives list and page is
  produced by one loader (`loadInitiativeCards`, see `initiatives.md`).
- A surface renders zero chrome for an empty signal: no header, no label, no
  zero-state row. Absence is the empty state.
- Home MUST NOT restate an item that the Waiting-on-You queue already lists.

---

## 0. Why this spec exists

As of v0.168.0 the three primary surfaces mixed their questions: Home carried an
initiative card rail whose only signals were a lifecycle chip and a percentage,
the initiative triage rows rendered on the Missions tab, and the effort
aggregation behind them existed twice with two different bucket keys. This spec
fixed placement. Its later attempt to answer "are we winning" with a derived
verdict was removed on 2026-09-26 (see the note above and `initiatives.md`).

---

## 1. Placement matrix

`MUST` = renders when its signal is non-empty. `MUST NOT` = never rendered on
that surface. `—` = not applicable.

The matrix originally covered four surfaces. §8 adds **Mission detail** and
**Task detail** because release (§8-10) is the first element whose natural
home is inside a single mission or task, not a cross-mission list — the prior
four columns have no row that needs them, which is why every pre-existing row
is `—` there.

| Element | Home | Missions | Initiatives list | Initiative detail | Mission detail | Task detail |
|---|---|---|---|---|---|---|
| Initiative card rail (160px cards) | MUST NOT | MUST NOT | MUST NOT | — | — | — |
| Derived initiative verdict, pulse line, effort sparkline | MUST NOT | MUST NOT | MUST NOT | MUST NOT | — | — |
| Initiative status + missions-done bar (`initiatives.md`) | MUST NOT | MUST NOT | MUST (one card each) | MUST | — | — |
| Progress headline (milestone crossing) | MUST | MUST NOT | MUST NOT | MUST NOT | — | — |
| Mission-state groups (`GROUP_ORDER`) | active subset only | MUST | MUST NOT | MUST NOT | — | — |
| Workspace grouping header | MUST NOT | conditional (§3.3) | MUST NOT | MUST NOT | — | — |
| Mission facts that need you, as links | MUST NOT | MUST NOT | MUST | MUST | — | — |
| Artifacts | MUST NOT | MUST NOT | MUST NOT | MUST | — | — |
| Release ledger status (§8.1) | MUST (exception only, §8.2) | MUST (card footer, §8.3) | MUST NOT (§8.4) | MUST NOT (§8.4) | this mission's Shipped line only (§8.5) | — |
| Release trigger action (`Release now`, §10.1) | MUST (§10.2) | MUST NOT (§10.2) | MUST NOT (§10.2) | MUST NOT (§10.2) | MUST NOT (§10.2) | MUST NOT (§10.2) |
| Task-level ship badge (§10.3) | MUST NOT | MUST NOT | MUST NOT | MUST NOT | MUST (per task row, §10.3) | MUST (§10.3) |
| Fifth task-rail segment for release (§10.4) | MUST NOT | MUST NOT | MUST NOT | MUST NOT | MUST NOT | MUST NOT |

---

## 2. Home — initiatives

Home renders no initiative list, rail, card or status line. Its one initiative
signal is the progress headline: when an initiative's missions-done percentage
crossed a milestone since this user's last visit, Home renders
`<title> crossed <N>%` under the greeting (`crossedMilestone`, with the per-user
snapshot in `initiative_progress_seen`). The verdict pulse line that used to sit here was
removed; see `initiatives.md`.

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
`CompactMissionCard`). The initiative-grouping path formerly in `MissionGrid` —
initiativeGroups, InitiativeGroupData, InitiativeGroupSection,
groupMissionsByInitiative — was dead (no caller passed the prop) and has been
deleted along with its test file (§7 migration step 4). None of those four
names resolve in the tree today; they are named here as history, not as a live
code surface.

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
  reference to groupMissionsByInitiative and issues no `SUM(input_tokens +
  output_tokens)` query.

---

## 4-7. Initiatives list, detail, data contract, migration

Replaced by [`initiatives.md`](initiatives.md). The verdict ladder, confidence,
zones, dismissal, effort window and the initiative effort endpoint no longer
exist.

---

## 8. Release — placement

### 8.0 Why release is here

`docs/design/release-management-ui.md` and the initiative artifact "Spec:
release as a first-class object" were both written and shipped (M1-M3, PR
#1845-#1924) without ever being reconciled against this document. The result
is four mounts with no host: `MissionReleaseFooter` on mission-list cards,
`ReleaseWidget` on Home, a `Release now` button on
`/app/workspaces/[id]/config`, and an orphan `/app/releases/[id]` with no
index and no nav entry. This section is that reconciliation — it does not
change what those components render, except where §8.5 and §10 explicitly say
so.

### 8.1 Release ledger status

The signal already defined by the release initiative spec §9: for a gated
workspace, queue depth and the age of the oldest unshipped merge; for a
continuous workspace, the last deploy state; for `none` archetype, nothing
(§9.1 formalizes this as the `none` empty state). This is a *read*, never an
action — the trigger lives in a separate row (§10.1).

### 8.2 Home

`ReleaseWidget` (already shipped, PR #1877/#1905) is correct as built: it
renders only the exception — queue depth over threshold **and** CI green on
the source ref — never a standing "release available" card, per §9 of the
release spec. This matrix entry formalizes that shipped behavior; no change.

### 8.3 Missions

`MissionReleaseFooter` on the mission-list card (already shipped, PR #1856) is
correct as built. No change.

### 8.4 Initiatives list and detail — MUST NOT

An initiative-level release row would restate what the initiative's missions
already show: each mission line reads its own done state from the Missions card
model, and release state belongs to the mission (§8.5), not to the container
above it.

### 8.5 Mission detail — MUST (new)

Mission detail today has **zero** release surface — `MissionReleaseFooter` is
mounted only on the list-card grid (`MissionGrid.tsx`), never on
`/app/missions/[id]/page.tsx`. This is the actual gap: mission detail is the
page whose entire subject is "is this mission done," and it currently cannot
answer whether the mission's merged work has shipped.

Mission detail answers the question for **this mission only**: the Delivery
stepper's Shipped step (`buildDeliverySteps`, which reads the mission's own
trunk merges against the release baseline from the same loader as the card
footer) renders as one line — `Released`, `Partly released` or `Waiting for next release` —
linking to the release detail page, or to the workspace's releases while the
release that will carry it does not exist yet
(`missions/[id]/MissionReleaseSection.tsx`). The workspace queue ("N
unshipped") and the trigger action are workspace facts, not this mission's,
and do not render here (§10.1). `none` archetype, or nothing of the mission
merged yet, renders nothing (§9.1).

### 8.6 Acceptance criteria

- **AC-38**: GIVEN a gated workspace with 3 unshipped merges and CI green on
  the source ref, WHEN Home renders, THEN the release widget is present;
  GIVEN CI failing on the same ref, THEN the widget renders the CI-blocking
  state, not the release link.
- **AC-39**: GIVEN an initiative whose child missions have shipped 2 releases
  this week, WHEN `/app/initiatives` and the initiative detail page render,
  THEN neither page renders a release-ledger row — only the existing
  `shippedThisWeek` clause/chip carries the count.
- **AC-40**: GIVEN a gated mission whose merged work is after the last
  release, WHEN `/app/missions/[id]` renders, THEN its Delivery Shipped line
  reads `Waiting for next release` and shows no workspace queue depth; GIVEN
  all of it is in a release, THEN it reads `Released` and links to the
  release; GIVEN the mission's archetype is `none`, THEN no Shipped line is
  present in the DOM.
- **AC-41**: GIVEN the same mission on both the missions-list card and its own
  detail page in one request cycle, THEN both read the same release loader:
  the card shows the workspace queue depth and age, and mission detail shows
  only this mission's Shipped line (no queue depth), so the two cannot
  disagree about the release baseline.

---

## 9. Release — empty-state doctrine

### 9.1 The three states

The code today collapses three distinct conditions into one blank render,
which makes a built feature indistinguishable from an unbuilt one (the defect
diagnosed and fixed for the Home widget and mission-card footer in the
"Release surfaces render nothing before the first healthy release" task —
that fix is the mechanism this section names and generalizes to every release
surface, present and future).

| State | Condition | Rendering |
|---|---|---|
| `none` | `detectArchetype()` returns `none` (§4 of the release spec — `releaseConfig` absent/disabled and no deploy signal) | Render nothing. **Permanently** — this is the only state that never resolves into something else. |
| `unseeded` | Archetype ≠ `none`, but the workspace has zero `healthy` rows in `releases` (or, for a single mission, no release has ever attributed its tasks) | Render the queue against the baseline ladder: `MAX(healthy_at)` → `MAX(deployed_at)` → latest release row of any state → current prod-branch head. Normal on day one for every release-capable workspace — MUST NOT be hidden or treated as an error. |
| `clean` | Archetype ≠ `none`, a baseline resolves (seeded or unseeded), and queue depth against that baseline is genuinely zero | Render nothing. This is the *correct* empty state — everything merged is already shipped — and MUST NOT be distinguished from `none` by any visible chrome, because a reader does not need to know *why* there is nothing to ship, only that there is nothing to ship. |

`none` and `clean` render identically (nothing); they are named separately
here because they must never be *computed* the same way. A surface that
special-cases `none` (skip the query entirely, per `detectArchetype`) but
falls through to `clean` for every other archetype cannot regress into the
epoch-baseline bug (`c3ea1d05`, PR #1905) where a null baseline silently
became "everything since 1970" instead of either `unseeded`'s ladder or a
correct zero.

### 9.2 Where this applies

Every row in §1 marked `MUST` for "Release ledger status" (Home, Missions,
Mission detail) and every future release surface MUST implement all three
states via the shared baseline-ladder helper (one implementation, per §6.2's
single-loader discipline extended to release data) — not a per-surface
COALESCE-to-epoch or a per-surface "if no rows, hide" shortcut. Both of those
shortcuts collapse `unseeded` into either `none` (undercounts) or a fabricated
history (overcounts) — this is precisely the bug class `c3ea1d05` filed and
the fix generalized here.

### 9.3 Acceptance criteria

- **AC-42**: GIVEN a workspace with `archetype: none`, WHEN any release
  surface renders, THEN no release element appears, and no release query
  (baseline or queue) is issued.
- **AC-43**: GIVEN a gated workspace with zero rows in `releases` and 4
  commits merged ahead of `prodBranch`, WHEN any release surface renders,
  THEN the baseline ladder falls through to the prod-branch-head rung and the
  surface reports 4 unshipped — never 0 (undercount-as-`none`) and never a
  count keyed from an unbounded epoch (overcount, the `c3ea1d05` regression).
- **AC-44**: GIVEN a gated workspace with a `healthy` release and zero merges
  since, WHEN any release surface renders, THEN no release element appears —
  the same DOM output as `none` (AC-42), but reached via the queue-depth-zero
  branch, not the archetype-none branch.
- **AC-45**: GIVEN two release surfaces (e.g. the mission card footer and the
  mission detail section) rendered for the same mission in one request cycle,
  THEN both classify the state (`none` / `unseeded` / `clean`) identically,
  because both call the same baseline-ladder helper.

---

## 10. Release — action placement and task-level ship state

### 10.1 Where the `Release now` action lives

**Decision: the Home readiness widget. Not mission detail, not workspace
config, not the missions list, not task detail.**

### 10.2 Reasoning

The release initiative spec's own §1 names the failure this whole effort
exists to fix: *"a mission can reach 'all tasks complete, all PRs merged' and
still not be shipped. Mission completion overstates reality."* That failure
is a property of a **mission**, observed at the moment someone is looking at
that mission. The affordance to fix it — fire the release — therefore
belongs next to the work whose completeness it corrects, not three clicks
away in workspace settings where nothing about *this mission's* unshipped
state is visible.

Concretely:

- **Mission detail — MUST NOT.** A release ships the whole workspace queue,
  not one mission, so a mission page offering it — next to a workspace-wide
  "N unshipped" count — read as a claim about the mission that it was not.
  Mission detail keeps only its own Shipped line (§8.5), which links to the
  release.
- **Home — MUST.** The readiness widget already computes "queue depth over
  threshold AND CI green" (§8.2) — the exact precondition for a safe release.
  Surfacing the action where that precondition is already evaluated avoids a
  second click through to a page that re-derives it. The widget gains the
  button; it does not gain a second, competing surface.
- **Missions list, Initiatives (list/detail), Task detail — MUST NOT.** List
  surfaces render summaries, not side-effecting controls (§3.1's "nothing
  else" doctrine for Missions applies equally here); an initiative spans many
  missions so "release" has no single target; a task cannot release on its
  own (§10.3).
- **Workspace config — configuration only.** `ReleaseSection.tsx` on
  `/app/workspaces/[id]/config` keeps the strategy selector, branch pickers,
  trigger-policy selector, and read-only Vercel-token status — everything
  that decides *how* a release runs. The `Release now` button that currently
  lives there is **removed from that surface** and relocated to Home. Configuration and action were conflated in one card;
  §5.2's own AC-13 ("Release now fires the release") never specified *where*
  the button must live, so this is a relocation, not a spec violation of the
  original design doc.

### 10.3 Task-level ship state: badge only, no fifth rail segment

**Decision: extend the existing task-detail badge (release-management-ui.md
§5.2, AC-24-26) to carry a `Shipped` state. Do not add a fifth segment to the
task rail.**

This closes both halves of the twice-deferred question in one move, because
they were never actually two separate questions — both are "does a task show
whether it shipped," and they have the same answer for the same reason.

**Why not the rail.** The release initiative spec §9 already gives the
argument, and the current codebase confirms it holds: `SegmentStrip` (as used
by `TaskCard`) renders one segment per entry in a task's *dependency chain* —
a variable-length structure keyed to `deriveChainPosition`, not a fixed
`code → review → ci → merge` pipeline. The same primitive renders mission
progress (`MissionProgressBar`). Grafting a release stage onto it would mean
either inventing a fixed-stage rail that doesn't exist today (a much larger
change than this spec's scope) or adding a segment whose meaning
("released") doesn't compose with what every other segment already means
("this upstream task's state"). And the substantive objection stands
regardless of implementation: **a task cannot ship alone.** Release is
mission-shaped — it attributes a commit range to *all* the tasks that
contributed, not one. A rail segment on an individual task would either be
permanently dark (continuous repos, where "shipped" means nothing per-task)
or read as N identical pending segments across every task in a gated mission
that hasn't released yet — noise, not signal.

**Why the badge.** A badge is mission-agnostic annotation, not a pipeline
stage — it says "this task's work is part of release R," full stop, with no
claim about the task's own progression. It also composes cleanly with the
two badge states release-management-ui.md already specified:

| Task state | Badge | Source |
|---|---|---|
| `tasks.release = 'false'` | `Skip release` (muted) | already spec'd, AC-24 |
| `tasks.release = 'true'` | `Force release` (amber) | already spec'd, AC-25 |
| `tasks.release = 'inherit'`, not yet attributed to a `healthy` release | none (default, no noise) | already spec'd, AC-26 — unchanged |
| attributed to a `healthy` release via `release_tasks` | `Shipped` (muted success), links to the release detail page | **new — closes this section's question** |

`Shipped` is additive: a task can show both `Force release` and `Shipped` at
once (it was force-released, and that release is now healthy). The badge
mounts everywhere `TaskCard`'s metadata row already mounts — mission detail's
task list and the standalone task detail page — so mission detail and task
detail get the same component, not two implementations to keep in sync.

### 10.4 Acceptance criteria

- **AC-46**: GIVEN a mission with unshipped merges, WHEN mission detail
  renders, THEN no `Release now` button (or other trigger control) and no
  workspace queue depth is present; the Home readiness widget carries the
  trigger (§10.2).
- **AC-47**: WHEN `/app/workspaces/[id]/config` renders the release section,
  THEN no `Release now` button (or equivalent trigger control) is present in
  the DOM — only strategy, branch, trigger-policy, and read-only token-status
  fields.
- **AC-48**: GIVEN a task whose PR was merged and later attributed (via
  `release_tasks`) to a release in state `healthy`, WHEN the task detail page
  or its `TaskCard` row on mission detail renders, THEN a `Shipped` badge is
  present and links to `/app/releases/[releaseId]`.
- **AC-49**: GIVEN a task with `tasks.release = 'inherit'` whose PR has not
  yet been attributed to any release, WHEN the task renders on any surface,
  THEN no ship-related badge is present (unchanged from the existing
  `inherit`-is-silent rule).
- **AC-50**: WHEN `TaskCard.tsx` or the task rail primitive (`SegmentStrip`)
  is inspected, THEN it renders exactly the segments produced by
  `deriveChainPosition` (or the mission-progress equivalent) and contains no
  release/ship segment — the fifth-segment path was evaluated and rejected,
  not merely unbuilt.

---

**Code surface**

- `apps/web/src/app/app/(protected)/home/page.tsx` — Home; builds `actionQueue`
  and the progress headline (§2). Mounts no initiative rail or status line.
- `apps/web/src/app/app/(protected)/missions/page.tsx` — Missions; no longer
  mounts triage or loads effort (#1710).
- `apps/web/src/app/app/(protected)/missions/MissionGrid.tsx` — mission grouping,
  workspace buckets, the dead initiative-group path.
- `apps/web/src/lib/initiative-list.ts` — `loadInitiativeList`,
  `InitiativeListItem`; feeds Home's progress headline and `GET /api/initiatives`.
- Initiatives list and page: see `initiatives.md`.
- `apps/web/src/lib/action-queue.ts` — `ActionQueueItem`, `subjectKey` dedup.
- `apps/web/src/lib/mission-helpers.ts` — `MissionGroup`, `GROUP_ORDER`,
  `SECTION_DISPLAY`, `healthToGroup`.
- `packages/core/mission-helpers.ts` — `computeMissionProgress`,
  `computeInitiativeProgress`, `computeInitiativeSegments`, `crossedMilestone`.
- `apps/web/src/components/MissionReleaseFooter.tsx` — mission-list card
  footer (§8.3); the empty-state ladder (§9.1-9.2) becomes its shared
  dependency rather than an inline COALESCE.
- `apps/web/src/app/app/(protected)/home/ReleaseWidget.tsx` and
  `apps/web/src/lib/release-readiness.ts` — Home exception widget (§8.2);
  gains the trigger action (§10.2, AC-46).
- `apps/web/src/app/app/(protected)/workspaces/[id]/config/ReleaseSection.tsx`
  — loses the `Release now` button (§10.2, AC-47); keeps strategy/branch/
  trigger-policy/token-status fields.
- `apps/web/src/app/app/(protected)/releases/[id]/page.tsx` — release detail;
  gains inbound links from the mission detail section (§8.5) and the
  `Shipped` task badge (§10.3, AC-48).
- `apps/web/src/app/app/(protected)/tasks/[id]/` and
  `apps/web/src/components/TaskCard.tsx` — gain the `Shipped` badge (§10.3);
  `TaskCard`'s `SegmentStrip` usage stays dependency-chain-shaped, no release
  segment (§10.4, AC-50).

**New files**

- `apps/web/src/app/app/(protected)/missions/[id]/MissionReleaseSection.tsx`
  — new (§8.5); mission detail's one-line Shipped status for this mission.
  Reads the same loader as `MissionReleaseFooter`, does not fork the query.
- `apps/web/src/lib/release-baseline.ts` — new (§9.2); the shared
  `none` / `unseeded` / `clean` baseline-ladder helper. One implementation
  for `MissionReleaseFooter`, `ReleaseWidget`/`release-readiness.ts`, and
  `MissionReleaseSection` — none of the three may carry its own ladder or
  COALESCE.
- `apps/web/src/components/TaskShipBadge.tsx` — new (§10.3); renders
  `Skip release` / `Force release` / `Shipped`, mounted by both `TaskCard`
  and the standalone task detail page.

**Out of scope**

- Archiving, deleting, or reordering initiatives from any surface.
- The `GroupSection` / `MissionProgressBar` convergence tracked by PR #1699.
- A releases index page (`/app/releases`) or a nav entry for it. §8-10 give
  `/app/releases/[id]` inbound links from Home, mission cards, and mission
  detail; a standalone list of every release across every workspace answers a
  different question than any of the three primary surfaces (§0) and is not
  scoped here.
- Implementing §8-10 — this document only places the release object and
  settles the two twice-deferred questions (§9, §10.3). `MissionReleaseFooter`
  and `ReleaseWidget` already exist and need no change; `MissionReleaseSection`,
  `TaskShipBadge`, and `release-baseline.ts` are new and are M4 build-task
  scope, not this spec's.
- Store-reviewed and published-package archetypes (§4 of the release spec) on
  any of these surfaces. Every ledger-status row above assumes gated or
  continuous; `pending_external` and registry states are unaddressed here.