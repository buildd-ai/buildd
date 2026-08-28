# Mobile Decision Flow — Design Spec

**Status:** Partially Implemented — I-7, I-8, I-11, I-13–I-16 shipped (condensed timeline default-open hierarchy, SegmentStrip in disclosure rows, gate-chip collapse, density tiers, bookkeeping footer, verdict collapse, wave banding). I-1–I-6, I-9, I-10, I-12 pending (initiative grouping, live-state card collapse, gesture grammar).  
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

### 3.5 Density tiers

Mission detail selects its default view from deliverable task count, not user preference:

| Tasks | Default | Timeline |
|---|---|---|
| ≤ N_small | Timeline | is the page |
| > N_small | Summary | a tab / drill-down |

**N_small = 8**, derived from the real mission distribution in the buildd workspace. Query (run against dev Neon instance):

```sql
SELECT
  count(*)                                                        AS mission_count,
  percentile_cont(0.5)  WITHIN GROUP (ORDER BY deliverable_count) AS p50,
  percentile_cont(0.75) WITHIN GROUP (ORDER BY deliverable_count) AS p75,
  percentile_cont(0.9)  WITHIN GROUP (ORDER BY deliverable_count) AS p90
FROM (
  SELECT mission_id, count(*) AS deliverable_count
  FROM tasks
  WHERE mission_id  IS NOT NULL
    AND status      != 'cancelled'
    AND (
      parent_task_id IS NULL
      OR mode = 'execution'                          -- spawned builder tasks count
    )
    AND title NOT SIMILAR TO '\[(CI Retry|reviewer)[^]]*\].*'
  GROUP BY mission_id
  HAVING count(*) > 0
) sub;
```

Proxy result from the 68-mission `buildd` workspace sample via the tasks API (deliverable counts as reported by `computeMissionProgress`): p50 = 5, p75 = 8, p90 = 13–14. The 25% of missions above the p75 threshold — those reaching 9–25 deliverable tasks — are precisely where the density problem manifests; the bottom 75% (≤8 tasks) are scannable as a flat timeline.

**Summary view composition — existing components only:**

```
Desktop (≥640px):
┌──────────────────────────────────────────────────────────────────────────────┐
│  Mission title                                           15/15 · ✓ completed │
│  [█████████████████████████████████████░░░░░░░░░░░░░░] 100%  full+labels    │
│  11 PRs merged · 0 open                                                      │
│  ─────────────────────────────────────────────────────────────────────────── │
│  WAITING ON YOU  (1)                                                          │
│  BUILD: Activity grouping model                                               │
│  Changes Requested · iteration 1/3   ✗ 0.88                                  │
└──────────────────────────────────────────────────────────────────────────────┘

360 px:
┌─────────────────────────────────────────────────┐
│  Mission title               15/15 · ✓ completed│
│  [██████████████████████████] 100%              │
│  11 PRs merged                                  │
│  ──────────────────────────────────────────────  │
│  WAITING ON YOU  (1)                             │
│  BUILD: Activity grouping model                  │
│  Changes Requested · iter 1/3   ✗ 0.88           │
└─────────────────────────────────────────────────┘
```

| Component | Density | Source |
|---|---|---|
| Mission outcome line (title + task count + status badge) | — | existing `missions/[id]/page.tsx` header |
| `MissionProgressBar` | `full` with labels | PR #1699 (spec 13551a50) |
| PR roll-up (`N PRs merged · M open`) | — | existing `MissionReviewSummary` or page-level count |
| Waiting-on-you band | — | §3.1 of this spec; existing `groupTimelineTasks` |

If Summary needs something `MissionProgressBar` cannot express at existing densities, that is a new density variant on `MissionProgressBar` — named and justified in the implementation task — **not** a new component.

### 3.6 Bookkeeping rows are not timeline rows

Rows classified as platform bookkeeping do not render as timeline rows at any density. They collapse to a single footer line, expandable.

**Discriminator:** `deriveTaskType({ title, parentTaskId, mode })` from `packages/core/mission-helpers.ts`, introduced by PR #1706 (merged). A row is bookkeeping when this function returns **non-null** (`'retry' | 'review' | 'review-retry'`). No local re-derivation; no title-prefix string matching; no `parentTaskId IS NOT NULL` raw check.

PR #1706 is merged into dev. The exact signature consumed:

```ts
import { deriveTaskType } from '@buildd/core/mission-helpers';
// non-null → collapse to footer
const isBookkeeping = deriveTaskType({ title: task.title, parentTaskId: task.parentTaskId, mode: task.mode }) !== null;
```

**Footer format:** one line per mission, right-aligned below all timeline bands:

```
── 12 orchestrator runs · last 2 d ago  ▶ ──
```

Tapping `▶` expands an inline list of the collapsed rows in reverse-chronological order (same compact format as expanded done rows from §3.3: title + relative time + PR link icon if `prUrl`).

`review` and `review-retry` typed tasks are **already excluded** from `timelineTasks` in `page.tsx` (current filter: `t.category !== 'review'`). The §3.6 change applies to tasks where `deriveTaskType` returns `'retry'` — CI retries and orchestrator echoes — which currently pass through the category filter and appear as regular rows.

### 3.7 Verdict collapse

Reviewer verdict blobs — `🤖 Approved (confidence 0.90)` body prose + `→ Merging automatically…` — collapse to a trailing chip on the row: `✓ 0.93`. Tap expands inline. This extends PR #1589's chips-only-when-they-carry-signal rule (cite it — do not restate it): an approved verdict with merged PR is done state; the chip carries full signal.

**Exception — this is the point of the feature:** the following verdict states render **expanded by default** at every density tier, and sort into the Waiting-on-you band from §3.1:

- `Changes Requested` (any confidence)
- `escalate` verdict type
- Any reviewer verdict where the task status is `failed`

A verdict demanding human action must never be collapsed or buried under merged history. The expanded Waiting-on-you render is identical to the current rendering of these states — no new layout.

**Chip format:** `✓ {confidence}` for approved, `✗ {confidence}` for changes-requested when collapsed (changes-requested is not collapsed — included here for completeness). Color tokens: approved → `text-status-success`, changes-requested → `text-status-error`.

Applies to: `CondensedTimeline.tsx` verdict rendering (lines 264–330 in the current file — the inline `reviewerNote` block). The body prose (`note.body`, `note.title` in `<p>` elements) and the "→ Merging automatically…" line are replaced by the chip for non-escalated approved verdicts.

### 3.8 Wave banding

Completed history in the done group bands into waves rendered with the **existing `GroupSection`** component (the same component doing Today / Yesterday / This week in Activity — `apps/web/src/components/GroupSection.tsx`, PR #1699). Only the band-key derivation is new.

**Band-key derivation:**

Gap-cluster completed tasks by `worker.mergedAt` (or `task.updatedAt` when `mergedAt` is null). Any gap of **≥ 4 hours** between consecutive completions opens a new band. The label derives from the first task's completion timestamp relative to now, using the same `deriveTimeBandLabel` vocabulary as `TaskGrid.tsx`:

```
Today · Yesterday · {Weekday} · {Month D} · {Month D, Year}
```

When two consecutive bands have the same label (e.g., both "Yesterday" — possible when tasks complete over two calendar days within the same 4 h window), append an ordinal suffix: `Yesterday (1)`, `Yesterday (2)`.

**Derivation location:** `deriveBandKey(tasks: CondensedTimelineTask[], now: Date): BandedGroup[]` lives in `apps/web/src/lib/condensed-timeline.ts` — the same module that owns `groupTimelineTasks`.

**Wave banding is timeline-only.** `CondensedTimeline.tsx` (done-group banding) is the sole `deriveBandKey` consumer. The Activity list (`TaskGrid.tsx`, groupBy=time) uses `deriveDayBands` from the same module — one section per calendar day, no ordinals. Gap-clustering there produced two same-day sections ("Today" above "Today (2)"), which reads as a duplicated header, not as two waves: Activity is a chronological index, so the day is the band.

**Band render** (replaces the current single collapsed done disclosure row):

```
Desktop:
▶  Today  · 3 tasks · 2 PRs  [████░░░] collapsed
▶  Yesterday · 4 tasks · 4 PRs  [████████] (done)
▶  This week · 6 tasks · 5 PRs  [████████] (done)
── 12 orchestrator runs · last 2 d ago  ▶ ──

360 px:
▶  Today  · 3 t · 2 PR  [████░░░]
▶  Yesterday · 4 t [████████]
▶  This week · 6 t [████████]
── 12 runs · 2 d ▶ ──
```

- Bands are **collapsed by default** (showing count + PR count + `SegmentStrip continuous height={4} maxWidth={80}` per §3.4).
- The open/in-flight band (if it exists — tasks merged today with open-PR siblings) is **expanded by default**.
- `GroupSection` is already always-expanded in Activity (no toggle). For timeline banding, it renders in collapsed mode: the existing component's `collapsible` prop (or equivalent) is set; collapsed state is local `useState` per band, reset on page re-entry per §3.3.
- `TypeGlyph` (`TaskTypeBadge`, PR #1684) is rendered on expanded rows inside a band — same as existing CondensedTimeline task rows. No new glyph logic.

### 3.9 Surface applicability table

Which of §3.5–3.8 apply to each surface, and at which density:

| Surface | §3.5 density tier | §3.6 bookkeeping footer | §3.7 verdict collapse | §3.8 wave banding |
|---|---|---|---|---|
| `missions/[id]/page.tsx` | ✓ governs view selection | ✓ pass `isBookkeeping` discriminator to grouping | ✓ (via CondensedTimeline) | ✓ (via CondensedTimeline done group) |
| `missions/[id]/CondensedTimeline.tsx` | ✓ implements Summary + Timeline views | ✓ footer accumulator replaces row render | ✓ chip replaces body prose for approved verdicts | ✓ done group replaced by banded `GroupSection` list |
| `home/page.tsx` (Right-now card) | ✗ always top-3 compact; no count gate | ✓ bookkeeping rows excluded (show top 3 non-bookkeeping) | ✓ chip only — compact card has no space for verdict prose | ✗ no history; compact card shows running tasks only |
| `tasks/TaskGrid.tsx` (Activity) | ✗ Activity is always a flat/grouped list; no summary tier | ✓ bookkeeping rows already excluded via `parentTaskId IS NULL` DB filter; no change needed | ✗ Activity does not render reviewer verdict notes | replaces ad-hoc inline `deriveTimeBandLabel` with shared `deriveBandKey` from condensed-timeline.ts |
| `home/page.tsx` (ACTIVITY feed) | ✗ fixed 6-row feed, no count gate | ✓ **real change** — feed is derived from workers (last 12 terminal, deduped by task), never filtered by `parentTaskId IS NULL`; `deriveTaskType({ title, parentTaskId, mode })` applied in post-processing; excluded rows are dropped (6-row feed does not warrant an expandable footer) | ✗ feed query does not fetch reviewer verdict notes | ✗ 6-row window is too narrow to span meaningful time bands |
| `missions/MissionGrid.tsx` | ✗ mission card surface; no timeline | ✗ | ✗ | ✗ |
| `initiatives/[id]/page.tsx` | ✗ shows mission list, not task timeline | ✗ | ✗ | ✗ |

**Justification for surface-specific rules:**

- §3.5 does not apply to Home or Activity because neither is a mission detail timeline — they have fixed layouts.
- §3.6 already satisfied in Activity (`parentTaskId IS NULL` DB filter, per PR #1674). Applying it again would be a no-op.
- §3.6 on the Home ACTIVITY feed is a real change: this feed is derived from workers, not from a task query with a `parentTaskId IS NULL` guard. Without the fix a reviewer-retry row and its parent both appear in the same 6-slot feed. Excluded rows are simply dropped; the feed is too narrow for an expandable footer.
- §3.7 does not apply to Activity because `TaskGrid` rows do not render reviewer verdict notes — that data is not fetched for the Activity list query.
- §3.7 does not apply to the Home ACTIVITY feed for the same reason.
- §3.8 wave banding replaces (not supplements) `TaskGrid`'s existing time-band grouping, sharing the new helper. Per spec 13551a50 §7: duplicated jobs are the bug.
- §3.8 does not apply to the Home ACTIVITY feed because a 6-row window rarely spans a 4-hour gap and the feed has no existing band UI to replace.

**Delete-list** — sites that will be superseded by this spec:

| File | Lines / construct | Superseded by |
|---|---|---|
| `apps/web/src/app/app/(protected)/missions/[id]/CondensedTimeline.tsx` | Lines 264–330: `reviewerNote` block rendering body prose (`note.body`, `note.title` in `<p>` elements) + "→ Merging automatically…" line for non-escalated approved verdicts | §3.7 chip |
| `apps/web/src/app/app/(protected)/missions/[id]/CondensedTimeline.tsx` | Single collapsed done-disclosure `<button>` row (current `{!doneExpanded && ...}` block) | §3.8 per-band `GroupSection` list |
| `apps/web/src/app/app/(protected)/missions/[id]/page.tsx` | Line 423 `timelineTasks` filter (`t.category !== 'review'`) — currently passes CI retry rows through | §3.6: extend filter to exclude `deriveTaskType() !== null` rows; accumulate them into footer counter |
| `apps/web/src/components/TaskGrid.tsx` | Inline `deriveTimeBandLabel` logic (Today / Yesterday / This week / Older classification) | §3.8 shared `deriveBandKey` helper |

The build task's job includes deleting or replacing each of these. No other sites re-derive band keys, re-render verdict prose, or re-implement a collapse toggle for the done group.

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

Recommended ship order. `dependsOn` values reference task IDs in this table (I-1 through I-16) and review-gate-ux build tasks (BT-1 through BT-12 in that spec). Items I-1 through I-12 require approval of this spec; items I-13 through I-16 additionally require approval of the §3.5–3.9 addendum (same doc, same PR).

| ID | Title | Key files | `dependsOn` |
|---|---|---|---|
| **I-1** | Fix initiative detail page: replace bespoke rows + flat bar with shared renderers | `apps/web/src/app/app/(protected)/initiatives/[id]/page.tsx` | — |
| **I-2** | Add `SegmentStrip continuous` mode (if not already supported) | `apps/web/src/components/SegmentStrip.tsx` | — |
| **I-3** | Missions list — initiative group headers + collapsible sections | `apps/web/src/app/app/(protected)/missions/page.tsx` | I-1, I-2 |
| **I-4** | Missions list — Ungrouped "Other" bucket + safety guard | same | I-3 |
| **I-5** | Initiative detail breadcrumb injection (`?from=initiative` passthrough) | `apps/web/src/app/app/(protected)/missions/[id]/page.tsx`, `initiatives/[id]/page.tsx` | I-1 |
| **I-6** | Home — add `initiativeId` to missions select in `home/page.tsx` | `apps/web/src/app/app/(protected)/home/page.tsx` | — |
| **I-7** ✅ | Condensed timeline: default-open hierarchy (Waiting-on-you → Running → Queued → Done collapsed) | `apps/web/src/app/app/(protected)/missions/[id]/page.tsx` + `CondensedTimeline.tsx` + `apps/web/src/lib/condensed-timeline.ts` | BT-2 (`blockingGate` field) |
| **I-8** ✅ | Condensed timeline: `SegmentStrip` in collapsed disclosure rows | same | I-2, I-7 |
| **I-9** | Live-state card: Waiting-on-you card collapse on `prLifecycleStatus` | Home page "Waiting on you" section | BT-1, BT-7, **5/7 deployed** |
| **I-10** | Live-state card: Escalation inbox resolved-group rendering | Escalation inbox component | **5/7 deployed** |
| **I-11** ✅ | Live-state card: Timeline gate chip collapse on `mergedAt` | `apps/web/src/app/app/(protected)/missions/[id]/CondensedTimeline.tsx` | BT-1, BT-7 |
| **I-12** | Gesture grammar: `SwipeableRow` + per-card swipe actions + undo toast | `apps/web/src/components/SwipeableRow.tsx` (new); apply to Home gate cards, Activity list rows, mission timeline rows | — |
| **I-13** | Density tier selector: Summary default for missions > 8 tasks; Summary view composed of `MissionProgressBar density=full+labels` + PR roll-up + Waiting-on-you band | `apps/web/src/app/app/(protected)/missions/[id]/page.tsx`, `CondensedTimeline.tsx` | I-7, I-8 |
| **I-14** | Bookkeeping row collapse to footer: filter `deriveTaskType() !== null` rows out of `timelineTasks`; accumulate into `"N orchestrator runs · last X ago"` footer expandable | `apps/web/src/app/app/(protected)/missions/[id]/page.tsx` (line 423 `timelineTasks` filter), `CondensedTimeline.tsx` | I-7, PR #1706 (✅ merged) |
| **I-15** | Verdict collapse to chip: replace approved verdict body prose with `✓ {confidence}` chip; expand on tap; `Changes Requested` / `escalate` / `failed` verdicts remain expanded and sort into Waiting-on-you band | `apps/web/src/app/app/(protected)/missions/[id]/CondensedTimeline.tsx` (lines 264–330) | I-7 |
| **I-16** | Wave banding: replace single done-disclosure row with `GroupSection`-backed per-wave bands; `deriveBandKey()` helper in `condensed-timeline.ts`; 4 h gap threshold; shared with `TaskGrid.tsx` time-banding | `apps/web/src/lib/condensed-timeline.ts` (new `deriveBandKey`), `CondensedTimeline.tsx` (done group), `apps/web/src/components/TaskGrid.tsx` (replace inline `deriveTimeBandLabel`) | I-7, I-8 |

✅ = implemented and deployed to production. Prerequisites for I-13–I-16.

**Parallel-safe groups:**
- `{I-1, I-2, I-6, I-12}` — fully independent; start these in parallel
- `{I-3, I-4, I-5}` — parallel after I-1 completes
- `{I-7, I-8}` — after I-2; I-8 additionally after I-7 (both ✅ — no longer actionable)
- `{I-9, I-10, I-11}` — gate on 5/7 deployment; I-9 and I-11 additionally gate on BT-1 + BT-7 (I-11 ✅)
- `{I-13, I-14, I-15, I-16}` — all depend on I-7 ✅ and I-8 ✅; fully parallel with each other; no cross-dependency

---

## Approval gate

This spec is for Max's review. No implementation should begin until:

1. Max approves (or provides revision feedback)
2. Implementation tasks I-1 through I-16 are filed from this doc (I-13 through I-16 require approval of the §3.5–3.9 addendum)
3. Each task follows TDD: failing test first, then implementation
