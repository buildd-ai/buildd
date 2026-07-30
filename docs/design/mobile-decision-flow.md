# Mobile Decision Flow — Design Spec

**Status:** Proposed — awaiting Max's approval before any implementation begins  
**Related:**
- `docs/design/review-gate-ux.md` (Waiting-on-you queue, StatusChip, gate chips, §5.2.1 merge CTA, §8 Activity list)
- `docs/design/task-subject-anchors.md` §5–6 (prLifecycleStatus, reconciliation sweep, subjectStillLive)
- `docs/design/mission-state-progress.md` (SegmentStrip vocab, computeMissionProgress, drive/health badges)
- `docs/design/initiative-surfaces.md` (computeInitiativeSegments, InitiativeRail, detail page divergence, Home rail)
- `docs/design/mobile-feed-spec.md` (design tokens, SwiftUI component kit, brutalist system)
- `docs/design/mission-status-mobile-header-spec.md` (mobile header layout, status taxonomy)
- `docs/design/unified-app-ia.md` §D (nav structure — Initiatives is desktopOnly)

---

## 0. Scope

This spec covers four mobile-first concerns that span existing specs but have no single design home:

1. **Live-state card model** — which surfaces subscribe to subject liveness; how cards collapse when lifecycle state resolves; implementation `dependsOn` edges
2. **Gesture grammar** — swipe action table per card type; non-destructive invariant; merge interaction; undo affordance; accessibility fallback
3. **Condensed timeline** — default-open hierarchy; collapse rules for done tasks and resolved escalations; expand interaction; SegmentStrip in collapsed rows
4. **Initiative tier on mobile** — collapsible initiative group headers in Missions list; drill-down shell; Home surfacing; Ungrouped bucket; no nav changes

Section 5 covers rollout ordering and the proposed implementation task breakdown.

---

## 1. Live-state card model

### 1.1 Lifecycle state is always persisted — never re-derived in the UI

Subject liveness is defined in `docs/design/task-subject-anchors.md §6`. The authoritative value is `workers.prLifecycleStatus` (stamped by the GitHub webhook reconciliation sweep from §5 of that spec). **No mobile surface ever calls GitHub or re-derives PR state from live API calls.** All liveness rendering reads persisted DB fields:

- `workers.prLifecycleStatus` — `open | merged | closed`
- `workers.mergedAt` — non-null = PR merged
- `SubjectCompletionProposal.proposedAction` — `cancel | supersede | keep`
- `blockingGate.prUrl` + lifecycle state (derived via `blockingGate` field from review-gate-ux §2.1 / BT-2)

This invariant is enforcement-quality: a UI component that fetches GitHub to determine card state is a correctness defect, not a styling issue.

### 1.2 Surfaces that subscribe to subject liveness

Four mobile surfaces consume lifecycle state:

| Surface | What it shows | Lifecycle signal consumed | Null/unknown fallback |
|---|---|---|---|
| **Home — "Waiting on you" queue** (review-gate-ux §1.1) | Review gate cards: PR title, diff stats, blocked count, [Review PR] + [Merge] | `worker.prLifecycleStatus` | Treat as `open` — card stays visible |
| **Escalation inbox** (task-subject-anchors §5, merge-policy §5.2.1) | Completion proposals; unmergeable-PR escalations | `SubjectCompletionProposal.proposedAction` + `worker.prLifecycleStatus` | Treat as `keep` — proposal stays active |
| **Timeline escalation chips** (review-gate-ux §3) | Gate chip between task cycles on mission detail timeline | `worker.mergedAt IS NOT NULL` | Chip stays visible |
| **Mission needs-attention cards** (initiative-surfaces §Decisions) | `rollup.status = 'blocked'` mission cards; task rows with `blockingGate` | `blockingGate` PR lifecycle state | Badge stays visible |

### 1.3 Collapse and resolved rendering

#### Home — "Waiting on you" gate card

| `prLifecycleStatus` | Rendering |
|---|---|
| `open` or null | Full card: PR title, diff stats, `N tasks waiting`, [Review PR ↗] + [Merge] |
| `merged` | Height-animates to single-line confirmation row: "PR #N merged — N tasks starting." Stays visible for 5 s, then removes from queue |
| `closed` (unmerged) | Collapses to warning row: "PR #N closed without merging · N tasks still blocked." Tap → task list for the blocked tasks. Warning row persists until user dismisses or tasks are reassigned |

Transition: height animation, 200 ms ease-out. Not an abrupt removal.

#### Escalation inbox item

A proposal resolves (moves to "Resolved" group) when both:
- `proposedAction` is `supersede` or `cancel`, **and**
- `worker.prLifecycleStatus = 'merged'` or `'closed'`

Resolved items are dimmed (opacity 0.5, ink-faint text) and sorted below active proposals. The "Resolved" group collapses to a disclosure row when ≥3 resolved items are present, using the same `▶ N resolved` pattern as review-gate-ux §8.2 blocked group:

```
▶  3 resolved escalations
```

#### Timeline gate chip (review-gate-ux §3)

The gate chip between task cycles is absent when `worker.mergedAt IS NOT NULL`. It does not animate away mid-session; it is absent on next render. A force-refresh reveals the resolved state immediately.

#### Needs-attention mission card

Mission cards with `rollup.status = 'blocked'` (from `computeInitiativeProgress` / `deriveMissionHealth`) surface a secondary line beneath the title when the block stems from a dependency gate:

```
PR #N · open         — ongoing dependency gate
PR #N · merged       — gate resolved; mission should re-evaluate soon
PR #N · closed       — gate closed without merge; human action needed
```

This line uses `prLifecycleStatus` from the dependency chain. The card does not auto-collapse; it remains in the attention group until the human resolves the blocking state.

### 1.4 `dependsOn` edges for implementation tasks

Every implementation task touching these surfaces **must** declare these edges:

| Task area | Must depend on |
|---|---|
| Home "Waiting on you" UI | review-gate-ux **BT-2** (`blockingGate` on task summary API) |
| Waiting-on-you card collapse on lifecycle change | task-subject-anchors **§5 reconciliation sweep deployed** (5/7 of mission ddfcebfe) |
| Escalation inbox resolved-group rendering | same 5/7 deployment |
| Timeline gate chip collapse | review-gate-ux **BT-1** (`checkDependsOnResolved` gate fix) + **BT-7** (merge endpoint) — so `mergedAt` is stamped promptly |
| Mission needs-attention card secondary line | BT-2 (`blockingGate` field carrying lifecycle state) |

---

## 2. Gesture grammar

### 2.1 Non-negotiable invariants

1. **Swipe is non-destructive only.** A swipe gesture may ack, dismiss, or snooze a card. It may never merge a PR, cancel a task, close an escalation, or trigger any irreversible server-side action.
2. **Merge is tap + inline confirm only**, per review-gate-ux §5.2.1. The confirm copy is the static inline label: `"Merging will automatically start N queued tasks."` No modal, no swipe path.
3. **Undo is always available.** After any swipe-dismiss or swipe-snooze, an undo toast appears for 4 s. See §2.3.
4. **Swipe-only is not acceptable.** Every action reachable via swipe must be reachable via the ⋯ tap menu. This is an accessibility requirement. See §2.4.
5. **No nested swipe conflict.** When a swipeable card sits inside a scrollable list:
   - Gesture within 30° of vertical → scroll wins
   - Gesture within 30° of horizontal → swipe wins
   - Threshold: 10 pt of horizontal travel before swipe is committed

### 2.2 Swipe action table

Left swipe = trailing action (reveals right edge). Right swipe = leading action (reveals left edge). Both reveal actions via spring animation; the card springs back to center after the action fires unless dismissed.

| Card type | Surface | Left swipe (trailing) | Right swipe (leading) | Tap | ⋯ menu contents |
|---|---|---|---|---|---|
| **Waiting-on-you gate card** | Home, escalation inbox | Snooze 24 h — accent background, clock icon | — (none) | Open gate detail sheet (full PR info + blocked task list) | Snooze 24 h · Snooze 3 d · Snooze 7 d · Open in GitHub |
| **Escalation proposal card** | Escalation inbox | Acknowledge (mark seen, dims, moves to bottom) — ink bg, check icon | — | Open escalation detail sheet | Acknowledge · File anyway (opens reason input sheet) · Ignore |
| **Blocked task row** | Activity list, mission timeline | Snooze notification (24 h) — muted bg, bell-off icon | — | Navigate to `/app/tasks/[id]` | Go to blocking PR (opens prUrl) · Snooze notification |
| **Needs-attention mission card** | Home, missions list | Snooze attention (24 h, suppresses attention chip on this device) — muted bg | — | Navigate to `/app/missions/[id]` | Snooze 24 h · View blocked tasks |
| **Running / queued task card** | Activity list, mission timeline | — | — | Navigate to task detail | Cancel task (opens confirm bottom sheet) |
| **Completed task row** | Activity list, mission timeline | Dismiss (collapses into done-group disclosure) — ink bg, X icon | — | Navigate to task detail | Dismiss · View PR (if prUrl) |
| **Initiative group header** | Missions list | — | — | Collapse / expand group | — |

**Right swipe is reserved and intentionally empty in v1.** Do not assign an action to right swipe on any card. Right swipe will be used in a future revision if a meaningful leading action is identified. Reserving it prevents gesture collision.

### 2.3 Undo affordance

After swipe-dismiss or swipe-snooze:

- A toast appears at the bottom of the viewport, above the tab bar, 12 pt gap from the tab bar top edge
- Format: `"{Action} · Undo"` — e.g. `"Dismissed · Undo"`, `"Snoozed 24 h · Undo"`
- Duration: 4 s, then auto-dismisses
- Style: ink background (#101216), white text (IBM Plex Mono 12/600), hard shadow (3,3) copper accent, no rounded corners (mobile-feed-spec design tokens)
- Tapping "Undo" reverses the last swipe action and re-inserts the card at its original position with a spring animation
- No partial-undo chaining: only the most recent action is undoable at any time

### 2.4 Accessibility fallback — the ⋯ menu

The `⋯` (more actions) button is **required** on every swipeable card. It is never hidden, never conditionally rendered, never behind a feature flag.

The ⋯ menu must surface every action available via swipe. On keyboard-only or pointer-only sessions, the ⋯ menu is the sole path to those actions.

Implementation requirements:
- `role="menu"`, `aria-label="More actions for {task title}"`
- Each item: `role="menuitem"`
- Open: tap / click of ⋯ button, or Space/Enter when button is focused
- Navigate: Arrow keys (up/down)
- Close: Escape (returns focus to ⋯ button), or tap outside on mobile (backdrop)
- On mobile: the menu opens as a bottom sheet with 44 pt minimum tap targets and safe-area bottom padding

The ⋯ button is 36×36 pt minimum touch target, right-aligned on the card, icon: `more-horizontal` or `ellipsis-vertical`.

---

## 3. Condensed timeline

The condensed timeline is the task spine for a single mission. It renders on:
- Mission detail page (`/app/missions/[id]`) — full timeline
- Home "Right now" in-flight mission card — the top 3 rows only, collapsed
- Anywhere `task-presentation.md`'s task chain strip renders

### 3.1 Default-open information hierarchy

Default rendering (no user interaction required):

```
┌──────────────────────────────────────────────────────┐
│  WAITING ON YOU   (if any gates open)                │
│  Review gate card(s), newest PR first                │
│  ────────────────────────────────────────────────    │
│  RUNNING · NEEDS INPUT   (if any active workers)     │
│  Task cards, sorted by startedAt ASC                 │
│  (longest-running first — mission-state-progress     │
│   cross-link spec)                                   │
│  ────────────────────────────────────────────────    │
│  NEXT QUEUED   (if dependsOn-resolved tasks exist)  │
│  First 3 shown; "▶ N more queued" if >3             │
│  ────────────────────────────────────────────────    │
│  ▶  N done  ·  N failed  [SegmentStrip]   (closed)  │
└──────────────────────────────────────────────────────┘
```

Group rendering rules:
- A group is **absent** when it has zero items. No empty group headers.
- "Waiting on you" appears only when ≥1 review gate is open for this mission.
- "Next queued" appears only when ≥1 task has all `dependsOn` resolved and `status = 'pending'`.
- Done/failed group is always present once ≥1 task is terminal; it defaults to collapsed.

Section ordering is fixed. User customization of section order is out of scope.

### 3.2 Collapse rules

#### Done tasks

A completed task collapses into the done disclosure group when **both**:
- `task.status = 'completed'`, **and**
- `worker.mergedAt IS NOT NULL` (or `worker.prUrl IS NULL` — no PR was produced)

Exception: if a completed task has `worker.prLifecycleStatus = 'open'` (open PR with dependent tasks waiting), it surfaces in the "Waiting on you" group and does **not** collapse into the done pile. Review gate takes priority.

#### Failed tasks

Failed tasks (`status = 'failed'`) collapse into the done/failed disclosure group alongside completed tasks. They are counted separately in the disclosure label: `"▶ 4 done · 2 failed"`.

#### Resolved escalations

A timeline escalation chip (review-gate-ux §3) resolves when `worker.mergedAt IS NOT NULL`. Resolved chips are removed from the timeline on the next render; they do not accumulate in a "resolved" group within the timeline. The done-task count already captures that cycle.

#### Blocked group disclosure

Follows review-gate-ux §8.2 exactly:
- ≥3 blocked tasks → collapses to `"▶ N waiting on dependencies"`
- ≤2 blocked tasks → always expanded
- Expanded blocked rows show the `waiting on:` cause text (tappable link per §8.3 of that spec)

### 3.3 Expand interaction

Tapping a disclosure row expands the group inline with a height animation (200 ms ease-out). Tapping again collapses it.

Expanded state is **local component state** (not URL-persisted, not server-stored). It resets to default (collapsed done group, auto-collapsed blocked group) on page re-entry.

Expanded done task rows render in compact format: title + relative time + PR link icon (if `prUrl`). No StatusChip, no cause text. Compact rows are not interactive beyond tapping to navigate to the task detail.

The `"▶ N more queued"` disclosure in the Next Queued group expands to show all pending tasks inline.

### 3.4 SegmentStrip in collapsed disclosure rows

Every collapsed group disclosure row renders a `<SegmentStrip>` at its right edge, in `continuous` mode, representing the completion distribution of tasks within that group only. It does not re-render the whole-mission bar.

**The shared `<SegmentStrip>` component is the only renderer.** No per-surface strip is introduced. The compact strip is `<SegmentStrip continuous height={4} maxWidth={80} />` (4 pt height, 80 pt max width, right-aligned within the disclosure row).

Segment vocabulary (mission-state-progress §Progress bar):

| Segment | Meaning |
|---|---|
| solid | completed, PR merged |
| half | completed, PR open |
| ghost (hatch) | in flight |
| empty | pending |
| notch | failed |

The `segments` array is server-computed (same shape returned by the mission detail API). **No client-side segment computation is permitted.** The compact strip in the disclosure row receives a slice of the server-returned `segments` array filtered to the tasks in that group; it does not re-invoke `computeMissionProgress`.

Ghost segments must be distinguishable without color (hatch pattern, not a tint) — mission-state-progress §Progress bar ghost rule applies here too.

---

## 4. Initiative tier on mobile

### 4.1 Missions list — collapsible initiative group headers

The Missions list page (`/app/missions`) on mobile presents missions grouped under their initiative when `initiativeId` is set. Grouping is **display-layer only**: the data fetch remains `GET /api/missions` (team-primary, optional workspace filter per unified-app-ia §B.1). Client-side grouping is applied in the page component after fetch.

**Group header layout:**

```
┌──────────────────────────────────────────────────────┐
│ ▼  Initiative Name                     ACTIVE   82%  │
│    [███████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░] │
└──────────────────────────────────────────────────────┘
```

- **Chevron**: 16 pt, rotates 180° on collapse; left of title
- **Initiative name**: IBM Plex Mono 14/600 ink
- **Status chip**: `rollup.status` via `initiativeStatusChip()` from `apps/web/src/lib/initiative-presentation.ts` — same function as desktop list; no mobile-specific chip logic
- **Progress %**: IBM Plex Mono 11/600 accent-deep, right of chip
- **Rollup bar**: shared `<SegmentStrip continuous>` built by `computeInitiativeSegments(children)` from `packages/core/mission-helpers.ts`. Not a flat status-colored bar. This is the same shared primitive as every other segment surface.

The initiative name taps to `/app/initiatives/[id]` (not to expand/collapse — the chevron is the expand toggle). These are two distinct tap targets.

**Collapsed state:** Group header visible; child mission cards hidden, height-animated away (200 ms). Default: **expanded**, except when a group contains ≥6 missions (defaults collapsed — group header only, with the SegmentStrip giving a visual summary).

**Ordering within the Missions list:** Initiative groups sort by `rollup.status` (blocked-first) then `lastMotionAt` desc, matching the `sortInitiatives` logic in `initiative-presentation.ts`. Within a group, missions follow the existing mission sort (health group → createdAt desc). Groups are not alphabetical.

### 4.2 Ungrouped "Other" bucket

Missions with `initiativeId IS NULL` appear under an implicit **"Other"** bucket at the bottom of the list, below all initiative groups.

- No group header rollup bar (no initiative to roll up)
- No collapse control — always expanded
- No status chip
- Header label: `"Other"` (IBM Plex Mono 14/600 ink-faint), rendered only when ≥1 initiative group exists above it; if all missions are ungrouped, the list renders flat with no group headers
- When zero missions are ungrouped, the "Other" bucket is entirely absent

**Safety property (from initiative-surfaces §Safety):** the "Other" bucket must never hide a mission. Missions without `initiativeId` must always appear. The `soonScheduled` surfacing (home/page.tsx) is preserved within the "Other" bucket for scheduled missions without an initiative. No mission may be silently excluded from the list due to grouping logic.

Verification: after any change to the grouping component, `home-missions.test.ts` (the grouping regression guard) must still pass unchanged.

### 4.3 Drill-down: `/app/initiatives/[id]` on mobile

The initiative detail page exists (`apps/web/src/app/app/(protected)/initiatives/[id]/page.tsx`). It has a renderer divergence that must be fixed before this feature ships:

| Bug | File location | Fix |
|---|---|---|
| Bespoke child-mission rows (lines ~166–178) that render `{completedTasks}/{totalTasks} · {progress}%` text instead of the shared `<MissionProgress>` | `initiatives/[id]/page.tsx` | Replace with `<MissionProgress segments={m.segments} ... />` using `segments` already returned by the detail API |
| Flat rollup status-colored bar (lines ~129–134) that ignores `segments` and renders a plain width % bar | same | Replace with `<SegmentStrip continuous>` built by `computeInitiativeSegments(children)` |
| Child mission drive/health chips inferred from invented labels | same | Use `<MissionBadges>` component — same as every other mission surface |

**This fix is a prerequisite for the Missions-list initiative grouping feature (§4.1).** An implementation task that adds initiative groups in the list without fixing the detail page is blocked — adding new entry points to a divergent renderer makes the bug worse, not better.

**Mobile layout (single-column, `< 640px`):**

```
BREADCRUMB:  Initiatives / {initiative.title}

[dark masthead — initiative title · rollup % · completedMissions/totalMissions]

[aggregate SegmentStrip continuous — full width]

MISSIONS  (N)
  {MissionProgress card × N, each → /app/missions/[id]}

ARTIFACTS  (if any)
  {artifact list}
```

Desktop two-column layout (missions left, pinned artifacts + Linear panel right) is already specced in initiative-surfaces §Implementation #2. Below 640 px the existing `md:` breakpoint already collapses to single-column. No new mobile-specific layout code.

The `<MissionProgress>` cards in the initiative detail on mobile are the same cards that render in the Missions list — the same component, the same `segments` data shape.

### 4.4 Breadcrumbs

When a user navigates from the Missions list → initiative group → mission detail, they receive the full breadcrumb:

```
Missions / {initiative.title} / {mission.title}
```

The initiative name links to `/app/initiatives/[id]`. "Missions" links to `/app/missions`.

**Breadcrumb injection mechanism:** The initiative group header in the Missions list links to the mission detail with a query param:

```
/app/missions/{missionId}?from=initiative&initiativeId={id}
```

The mission detail page reads `searchParams.from` and `searchParams.initiativeId` to render the extended breadcrumb. When these params are absent (direct navigation to `/app/missions/[id]`), the standard `"Missions / {mission.title}"` breadcrumb renders. No layout-level navigation state or context is required.

The same param pattern applies to navigation from the initiative detail page to a child mission: `/app/missions/[id]?from=initiative&initiativeId={id}`.

### 4.5 Home durable-arc surfacing

The `InitiativeRail` component (initiative-surfaces §4 + §Implementation #4) is already deployed. This section specifies mobile-specific placement and the `initiativeId` select fix.

**`initiativeId` select fix (required):** `home/page.tsx` currently omits `initiativeId` from the missions fetch (identified in initiative-surfaces §Problem ~line 20). This must be added so the Home page can know which missions belong to which initiative for the arc headline computation and for any mission card that wants to show its initiative. Change: add `initiativeId` to the Drizzle select in the missions query in `home/page.tsx`. This is a read-only additive change to an existing query.

**Mobile placement in the Home scroll view:**

```
[dark masthead — workspace / date / live worker count]
[InitiativeRail — horizontal scroll, capped at 6 cards]
[Waiting on you — if any review gates are open]
[Running now]
[Needs Input]
[Shipped today]
```

`InitiativeRail` renders nothing (zero DOM nodes) when no initiatives exist. Home is byte-for-byte unchanged for teams without initiatives.

**Mobile card dimensions:** Each rail card is 160 pt wide. Contents:
- 4 pt accent (copper) left border on active/blocked initiatives
- Initiative name: IBM Plex Mono 14/600 ink, single line with ellipsis at 140 pt
- Rollup %: IBM Plex Mono 11/600 accent-deep
- Status chip: `initiativeStatusChip(rollup.status)` — same tokens as desktop

**Arc headline on mobile:** The H1 (`crossedMilestone` → `{initiative} crossed X%`) and subheading (`{N} ships today · {M} waiting on you`) both wrap naturally at 393 pt — no truncation of the subheading. The initiative name in the H1 truncates at 32 characters with an ellipsis.

### 4.6 No nav changes

The Initiatives nav entry is already `desktopOnly` in `NAV_ITEMS` (per initiative-surfaces §Implementation #3). **Do not add Initiatives to the mobile bottom tab bar.** The five mobile tabs (Home · Missions · Activity · Team · Health per unified-app-ia §D.2) are frozen.

Mobile users reach initiatives via two paths:
1. **Home → `InitiativeRail` → initiative card → `/app/initiatives/[id]`**
2. **Missions list → initiative group header → title tap → `/app/initiatives/[id]`**

No new mobile nav entries, no tab bar changes.

---

## 5. Rollout and risks

### 5.1 Dependency on task-subject-anchors 5/7

The live-state card collapse behavior in §1.3 depends on `prLifecycleStatus` being persisted by the GitHub webhook reconciliation sweep. This is task 5/7 of mission ddfcebfe (state reconciliation sweep + pre-claim `subjectStillLive()` gate).

**Items that can ship before 5/7 deploys (graceful degradation):**

| Item | Fallback if `prLifecycleStatus` is null |
|---|---|
| Home "Waiting on you" card rendering | Treat as `open` — card stays visible, no false collapse |
| Timeline gate chip | Chip stays visible (correct — PR is still open or status unknown) |
| Needs-attention secondary line | Omit the PR status line entirely; card still shows BLOCKED badge |

**Items that must wait for 5/7:**
- Card collapse triggered by `prLifecycleStatus = 'merged'` or `'closed'` (§1.3)
- Escalation inbox "resolved" grouping based on lifecycle state (§1.3)

All other items in this spec are independent of 5/7.

### 5.2 Desktop/mobile shared-component blast radius

These components are shared. Any change affects both viewports; the implementation task must verify at 393 pt and ≥ 1280 pt:

| Component | Current call sites | Risk |
|---|---|---|
| `<StatusChip>` (review-gate-ux §8.4) | Activity list, mission timeline, sidebar, Home, task detail | Label copy or color token changes affect all 5+ surfaces |
| `<SegmentStrip>` (mission-helpers + initiative-surfaces) | Mission cards, initiative cards, mission-state-progress bars | Adding `continuous` mode prop must not break existing `discrete` mode usage; must remain the single renderer |
| `<MissionProgress>` | Mission detail, initiative detail (after fix), Home running card | Segment data shape must stay consistent; no new props that would break existing callers |
| `computeInitiativeSegments()` | Initiative detail bar (after fix), Missions-list group rollup bar | Pure function; must have unit test coverage before adding a second call site |
| `SwipeableRow` (new) | All swipeable card types (§2) | Touch event handling; scroll conflict; must not regress existing scroll behavior on list pages |
| `InitiativeRail` | Home | `select initiativeId` fix is additive; must not change the rail's data shape |

**Global token changes** (mobile-feed-spec §1 + §6): changes to `--primary`, `--card-shadow`, `border-radius`, or IBM Plex Mono font registration affect all ~40 pages. These changes should be gated by the same pre-merge visual QA pass that `visual-qa.yml` provides for release PRs.

### 5.3 Items that ship independently

These items have no cross-feature dependencies and can be filed and merged in any order:

| Item | Rationale |
|---|---|
| Initiative detail page divergence fix (§4.3) | Correctness fix for existing page; no new data needed |
| Missions list initiative grouping (§4.1) | Reads existing `initiativeId` on mission rows; no new API changes |
| Home `initiativeId` select fix (§4.5) | Additive column to existing query |
| Breadcrumb injection (§4.4) | URL param passthrough; additive |
| Condensed timeline hierarchy rendering (§3.1–3.3) | Reads existing task `status` fields + `blockingGate` (BT-2 dependency noted) |
| `SegmentStrip` in collapsed disclosure rows (§3.4) | Requires `segments` from server; already returned by mission API |
| `SwipeableRow` component + gesture grammar (§2) | Purely additive; no data dependency |

### 5.4 Proposed implementation task breakdown

Recommended ship order. `dependsOn` values reference task IDs in this table (I-1 through I-12) and review-gate-ux build tasks (BT-1 through BT-12 in that spec). Do not file these tasks until Max approves this spec.

| ID | Title | Key files | `dependsOn` |
|---|---|---|---|
| **I-1** | Fix initiative detail page: replace bespoke rows + flat bar with shared renderers | `apps/web/src/app/app/(protected)/initiatives/[id]/page.tsx` | — |
| **I-2** | Add `SegmentStrip continuous` mode (if not already supported) | `apps/web/src/components/SegmentStrip.tsx` | — |
| **I-3** | Missions list — initiative group headers + collapsible sections | `apps/web/src/app/app/(protected)/missions/page.tsx` | I-1, I-2 |
| **I-4** | Missions list — Ungrouped "Other" bucket + safety guard | same | I-3 |
| **I-5** | Initiative detail breadcrumb injection (`?from=initiative` passthrough) | `apps/web/src/app/app/(protected)/missions/[id]/page.tsx`, `initiatives/[id]/page.tsx` | I-1 |
| **I-6** | Home — add `initiativeId` to missions select in `home/page.tsx` | `apps/web/src/app/app/(protected)/home/page.tsx` | — |
| **I-7** | Condensed timeline: default-open hierarchy (Waiting-on-you → Running → Queued → Done collapsed) | `apps/web/src/app/app/(protected)/missions/[id]/page.tsx` + timeline component(s) | BT-2 (`blockingGate` field) |
| **I-8** | Condensed timeline: `SegmentStrip` in collapsed disclosure rows | same | I-2, I-7 |
| **I-9** | Live-state card: Waiting-on-you card collapse on `prLifecycleStatus` | Home page "Waiting on you" section | BT-1, BT-7, **5/7 deployed** |
| **I-10** | Live-state card: Escalation inbox resolved-group rendering | Escalation inbox component | **5/7 deployed** |
| **I-11** | Live-state card: Timeline gate chip collapse on `mergedAt` | Mission detail timeline component | BT-1, BT-7 |
| **I-12** | Gesture grammar: `SwipeableRow` + per-card swipe actions + undo toast | `apps/web/src/components/SwipeableRow.tsx` (new); apply to Home gate cards, Activity list rows, mission timeline rows | — |

**Parallel-safe groups:**
- `{I-1, I-2, I-6, I-12}` — fully independent; start these in parallel
- `{I-3, I-4, I-5}` — parallel after I-1 completes
- `{I-7, I-8}` — after I-2; I-8 additionally after I-7
- `{I-9, I-10, I-11}` — gate on 5/7 deployment; I-9 and I-11 additionally gate on BT-1 + BT-7

---

## Approval gate

This spec is for Max's review. No implementation should begin until:

1. Max approves (or provides revision feedback)
2. Implementation tasks I-1 through I-12 are filed from this doc
3. Each task follows TDD: failing test first, then implementation
