---
title: Surface IA — Home, Missions, Initiatives
status: active
owner: max
last_verified: 2026-10-23
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
§0 is kept as history. §3 and §8-§10 are unchanged, except §8.5, rewritten on
2026-10-15 for `MissionReleaseSection`, and the drift notes in §3.1 and §8.2.
§11 (Home's card for a PR whose checks fail) was added on 2026-10-23.

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
| Mission-state groups | active subset only | portfolio sections (§3) | MUST NOT | MUST NOT | — | — |
| Workspace grouping header | MUST NOT | MUST NOT | MUST NOT | MUST NOT | — | — |
| Mission facts that need you, as links | MUST NOT | MUST NOT | MUST | MUST | — | — |
| Artifacts | MUST NOT | MUST NOT | MUST NOT | MUST | — | — |
| Release ledger status (§8.1) | MUST NOT (§8.2) | MUST NOT (§8.3) | MUST NOT (§8.4) | MUST NOT (§8.4) | this mission's Shipped row only (`MissionReleaseSection`, §8.5) | — |
| Release trigger action (`Release now`, §10.1) | MUST NOT (§10.2) | MUST NOT (§10.2) | MUST NOT (§10.2) | MUST NOT (§10.2) | MUST NOT (§10.2) | MUST NOT (§10.2) |
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

## 3. Missions portfolio

### Composition and scope

The Missions portfolio renders compact `MissionRow` rows. Open work is
sectioned by `buildMissionSections`: Waiting on you, In motion, Waiting, then
Landed, checks pending. Empty sections are omitted. Recently completed work
appears separately; older completed work is progressively revealed.

The status filters in `PORTFOLIO_STATUS_FILTERS` are All, Waiting on you,
In motion, Waiting and Landed. Search narrows the displayed rows and filter
counts; headline counts continue to describe the selected portfolio group.
`portfolioGroups` supplies an optional group picker. A selected group is
reflected in `?group=`; an unknown group falls back to all groups.

The shell workspace switcher supplies `?workspace=`. The server scopes reads
to the active team; a workspace selection includes that workspace's missions
and team-level missions. Workspace scope does not create bucket headers:
when several workspaces are represented, rows carry workspace context.
No initiative triage or token aggregation belongs to this page.

### Acceptance criteria

- AC-7: GIVEN active initiatives WHEN the Missions page renders THEN no
  initiative triage row is mounted.
- AC-8: GIVEN missions from multiple workspaces WHEN the portfolio renders
  THEN no workspace bucket header is emitted.
- AC-9: GIVEN a selected workspace WHEN the server loads the portfolio THEN
  it includes that workspace's missions and team-level missions in the active team.
- AC-10: GIVEN open missions in different delivery states WHEN the portfolio
  renders THEN nonempty sections follow Waiting on you, In motion, Waiting,
  Landed, checks pending order.
- AC-11: GIVEN a group filter naming no available group WHEN the portfolio
  initializes THEN it falls back to all groups.
- AC-12: GIVEN a search query WHEN portfolio results narrow THEN filter counts
  follow the query and headline counts retain the selected group's totals.

**Code surface**: `apps/web/src/app/app/(protected)/missions/page.tsx`,
`apps/web/src/app/app/(protected)/missions/MissionGrid.tsx`,
`apps/web/src/lib/mission-portfolio.ts`, `apps/web/src/lib/mission-sections.ts`.

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
#1845-#1924) without ever being reconciled against this document. The original implementation had four mounts with no host: `MissionReleaseFooter` on mission-list cards,
`ReleaseWidget` on Home, a `Release now` button on
`/app/workspaces/[id]/config`, and an orphan `/app/releases/[id]` with no
index and no nav entry. This section describes the current release surfaces; Home and portfolio
mounts have since been removed (§8.2–8.3).

### 8.1 Release ledger status

The signal already defined by the release initiative spec §9: for a gated
workspace, queue depth and the age of the oldest unshipped merge; for a
continuous workspace, the last deploy state; for `none` archetype, nothing
(§9.1 formalizes this as the `none` empty state). This is a *read*, never an
action — the trigger lives in a separate row (§10.1).

### 8.2 Home and 8.3 Missions portfolio

Neither Home nor the Missions portfolio mounts a release widget or a
mission-list release footer. Release state is rendered on mission detail
(§8.5) and in workspace release settings. The old Home exception widget and
list footer are retained components, not contracts for a mounted surface.

### 8.4 Initiatives list and detail — MUST NOT

An initiative-level release row would restate what the initiative's missions
already show: each mission line reads its own done state from the Missions card
model, and release state belongs to the mission (§8.5), not to the container
above it.

### 8.5 Mission detail: MUST

Mission detail answers one release question for **this mission only**: has
its merged work shipped? Before this section was built, mission detail had no
release surface at all. It now has one row,
`MissionReleaseSection` (`missions/[id]/MissionReleaseSection.tsx`), mounted
in the mission page's footer rows (`footerRows` in `missions/[id]/page.tsx`).

- **What it reads.** The Delivery model's Shipped step (`buildDeliverySteps`,
  which compares the mission's own trunk merges with the workspace release
  baseline from the shared release loader) plus the mission's release
  status (`missionReleaseStatus` in `lib/mission-delivery.ts`). The row is
  chosen by `missionReleaseRow`.
- **What it says.** The step label (`Shipped`), then one status:
  `Released` (only for a healthy deploy), `Partly released`, `Waiting for next
  release`, `Release dispatched`, `Deploying`, `Deploy failed` or `Health not
  reported`. The release status adds the dispatched, deploying, failed and
  unknown states, which show even when the Shipped step is hidden.
- **Where it links.** The whole row is a link, ending in `Release ›` (the
  word `Release` is hidden at phone width, the `›` stays). It opens the
  release that carries the work (`loadMissionCarryingReleaseId`), or the
  workspace's releases (`/app/releases?workspace=...`) while that release does
  not exist yet (`missionShippedHref`).
- **What it never shows.** The workspace queue ("N unshipped") and the
  `Release now` trigger are workspace facts, not this mission's, and do not
  render here (§10.1).
- **When it is absent.** A `none` archetype or a workspace with no release
  flow (`not_configured`), or nothing of the mission merged yet, renders no
  row (§9.1).

### 8.6 Acceptance criteria

- **AC-39**: GIVEN an initiative whose child missions have shipped 2 releases
  this week, WHEN `/app/initiatives` and the initiative detail page render,
  THEN neither page renders a release-ledger row — only the existing
  `shippedThisWeek` clause/chip carries the count.
- **AC-40**: GIVEN a gated mission whose merged work is after the last
  release, WHEN `/app/missions/[id]` renders, THEN its Delivery Shipped row
  reads `Waiting for next release`, links to the workspace's releases and
  shows no workspace queue depth; GIVEN all of it is in a release whose deploy
  is healthy, THEN it reads `Released` and links to that release; GIVEN the
  mission's archetype is `none`, THEN no Shipped row
  (`data-testid="mission-shipped-status"`) is present in the DOM.
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

### 10.1 Release actions

The former placement proposal put a Release now action in a Home readiness
widget. Home no longer mounts that widget. Neither Home nor the Missions
portfolio exposes a release trigger; mission detail continues to show only
this mission's shipped state. Release execution is defined in `release-flow.md`,
including the `trigger_release` MCP action.

### 10.2 Current placement

Workspace release settings configure strategy, branches, trigger policy and
token status. They expose no Release now button. The historical Home relocation
is not a requirement to mount a new control. Mission, initiative and task
surfaces retain their read-only release state as specified below.

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
  workspace queue depth is present.
- **AC-47**: WHEN `/app/settings/workspace/[id]` renders the release section,
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

## 11. Home — a PR whose checks are failing

### 11.0 Why this section exists

On 2026-10-23 Home showed two cards that each said only "Tests are failing."
with Start fix as the primary action. Neither was a code defect. In one, only
the real-Postgres job failed, because the database dropped its connections. Two
automatic fixes had already been pushed without changing the result. In the
other, `build` was red only because it reports the Windows runner job's result.
The saved log ended at checkout cleanup, so the failing test showed nowhere in
buildd, and the one automatic fix pushed nothing. Start fix sends an agent to
fix a flake, and "Tests are failing" does not say what failed.

This section covers the card for a PR whose required checks fail with no fix in
flight. A PR with a fix in flight keeps its agent-handled card, unchanged.

### 11.1 Requirements

- **R-1 Name the check.** The card names the job or jobs that failed. A summary
  gate, a job whose only work is to report other jobs' results (buildd's `build`,
  step "All build parts passed"), is folded into the jobs it reports on and is
  never the named failure while one of those jobs failed. When it is the only
  failed job, it is named.
- **R-2 Show the failing lines.** The CI digest, wherever it is read (`get_pr`
  with `includeCiFailures`, the card's sentence, the retry agent's brief), is
  taken from the failing test or error lines of the job's log, never from its
  last lines alone. Log text after the job's own steps (post-job cleanup) is not
  a failure. For a job that uploads a unit-test report artifact
  (`unit-test-report-*`), the failing tests are read from that report when
  the log does not name them.
- **R-3 Say when it looks like a flake.** Rules decide first: a database
  connection the server terminated, a lost runner or an image the runner
  could not pull, and a timeout with no failing assertion each read as a likely
  flake. A real failing test or compile error reads as a real failure. Where
  no rule decides, Jev judges. Until Jev is wired, the card says what failed and
  treats it as a real failure. The card also says when earlier automatic fixes
  pushed nothing, or pushed and did not change the result.
- **R-4 Actions follow the cause.** A likely flake: **Re-run** is the primary
  action and Start fix the secondary. A real failure: **Start fix** is primary.
  Re-run re-runs the failed jobs of the head's failed workflow run only, through
  the GitHub App. It records who re-ran what and when, and the card names the re-run.
  When the re-run fails again with the same signature, Start fix becomes primary
  and the card says it failed twice.
- **R-5 Plain, specific words.** The sentence names the check and the cause:
  "Postgres tests lost their database connection.", "Windows runner tests
  failed: <test name>." It never reads "Tests are failing." alone, and no
  stock phrasing (Product voice d4613613).
- **R-6 The same words as Mission checks.** The card's label follows Mission
  checks (072de598) I-12: a PR whose review approved it reads "Approved ·
  checks failing", and the stage stays Verify. Other PRs read "Checks failing".

### 11.2 Acceptance criteria

- **AC-51**: GIVEN a PR whose only failed job is the real-Postgres job with
  "terminating connection due to administrator command" in its log and two
  earlier automatic fixes, WHEN Home renders its card, THEN the sentence names
  the job and says the Postgres tests lost their database connection, says the
  two fixes did not change the result, and Re-run is the primary action with
  Start fix beside it.
- **AC-52**: GIVEN a PR whose failed jobs are `build` (step "All build parts
  passed") and "Runner unit tests (windows)", WHEN Home renders its card, THEN
  the card names "Runner unit tests (windows)" and never `build`; GIVEN `build`
  is the only failed job, THEN it is named.
- **AC-53**: GIVEN a job log whose failing test lines sit mid-log and whose last
  lines are post-job cleanup, WHEN the digest is read, THEN it holds the failing
  lines and none of the cleanup.
- **AC-54**: GIVEN a likely-flake card, WHEN a person clicks Re-run, THEN only
  the failed jobs of the head's failed run are re-run and the re-run is
  recorded with who and when; GIVEN that re-run fails with the same signature
  on the same head, WHEN Home renders, THEN Start fix is primary and the
  sentence says it failed twice.
- **AC-55**: GIVEN an approved PR whose required checks fail, WHEN Home renders
  its card, THEN the label reads "Approved · checks failing", the same words
  072de598 AC-10 gives the header, board and chat.
- **AC-56**: GIVEN a Windows runner job that failed a test the log does not
  name and an uploaded `unit-test-report-windows` artifact naming it, WHEN the
  failure is recorded, THEN the card names that test.

---

**Code surface**

- `apps/web/src/app/app/(protected)/home/page.tsx` — Home; builds `actionQueue`
  and the progress headline (§2). Mounts no initiative rail or status line.
- `apps/web/src/app/app/(protected)/missions/page.tsx` — Missions; no longer
  mounts triage or loads effort (#1710).
- `apps/web/src/app/app/(protected)/missions/MissionGrid.tsx` — portfolio sections,
  status/search/group filters and compact mission rows.
- `apps/web/src/lib/initiative-list.ts` — `loadInitiativeList`,
  `InitiativeListItem`; feeds Home's progress headline and `GET /api/initiatives`.
- Initiatives list and page: see `initiatives.md`.
- `apps/web/src/lib/action-queue.ts` — `ActionQueueItem`, `subjectKey` dedup.
- `apps/web/src/lib/mission-helpers.ts` — `MissionGroup`, `GROUP_ORDER`,
  `SECTION_DISPLAY`, `healthToGroup`.
- `packages/core/mission-helpers.ts` — `computeMissionProgress`,
  `computeInitiativeProgress`, `computeInitiativeSegments`, `crossedMilestone`.
- `apps/web/src/components/MissionReleaseFooter.tsx` — retained, unmounted list footer;
  it is historical context, not the portfolio rendering contract.
- `apps/web/src/lib/release-readiness.ts` — the readiness helper of the
  Home exception widget (§8.2). The unmounted widget itself was deleted
  (spec 3ef37387 R-18: nothing loaded or kept that is not shown).
- `apps/web/src/app/app/(protected)/settings/workspace/[workspaceId]/ReleaseSection.tsx`
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
  `/app/releases/[id]` inbound links from mission
  detail and task ship badges; a standalone list of every release across every workspace answers a
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