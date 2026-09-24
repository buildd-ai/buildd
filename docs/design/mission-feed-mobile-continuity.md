---
status: partially
# No assertions yet, deliberately. Per docs/design/spec-conformance.md §2 a
# passing assertion under a non-terminal status is `code_ahead` and gets
# redispatched, and every S1–S3 symbol already passes. S3's wiring
# (buildMissionFeedGroups reachable from missions/[id]/page.tsx) is asserted by
# docs/specs/mission-feed.md, the active contract. Add this doc's assertions
# when the last slice lands and the status can move to implemented.
---

# Mission feed: mobile-first continuity (home → mission → task)

**Status:** Partially — S1 (pure model and vocabulary) is built, with D2's single-derivation part deferred to S5; S2 (shared components) is built; S3 (mission detail layout) is built, with the md+ list migration deferred; S4 (task sheet) is built; S5 (cards and inbound links, closing D2 for cards) is built; S6 and S7 are proposed.
**Related:** `apps/web/src/app/app/(protected)/missions/[id]/page.tsx`, `missions/[id]/MissionFlightStripNav.tsx`, `missions/[id]/CondensedTimeline.tsx`, `missions/[id]/MissionTabs.tsx`, `missions/[id]/TaskPanelWrapper.tsx`, `missions/[id]/TaskPanel.tsx`, `missions/[id]/MissionAutoRefresh.tsx`, `missions/[id]/MissionFeed.tsx`, `missions/MissionGrid.tsx`, `missions/page.tsx`, `home/page.tsx`, `tasks/[id]/page.tsx`, `tasks/[id]/respond/page.tsx`, `(protected)/layout.tsx`, `components/FlightStrip.tsx`, `components/FlightDetailSheet.tsx`, `components/SegmentStrip.tsx`, `components/BottomSheet.tsx`, `components/MissionProgressBar.tsx`, `components/MissionProgress.tsx`, `components/missions/MissionSituationBlock.tsx`, `components/NeedsInputBanner.tsx`, `lib/flight-strip-nav.ts`, `lib/mission-state-view.ts`, `lib/mission-helpers.ts`, `lib/task-presentation.ts`, `lib/task-origin.ts`, `lib/action-card-context.ts`, `lib/initiative-breadcrumb.ts`, `packages/core/mission-helpers.ts`, and the S1 modules `lib/mission-pulse.ts`, `lib/mission-feed-groups.ts`, `lib/mission-task-href.ts`. Sibling docs: `docs/design/mission-flight-strip.md` (§7), `mission-delivery-arc.md`, `mission-state-progress.md`, `mobile-artifact-feed.md` (§2.2–2.3), `mission-status-mobile-header-spec.md` (§1), `mobile-feed-spec.md`, `docs/specs/mission-legibility.md` (§4), `docs/specs/surface-ia-home-missions-initiatives.md` (§8.5).

---

## Problem

The user's complaint: *"Can't scroll through 15 tasks, click one, and scroll back up to see it."* Every line number below is from `origin/dev`. The browser capture failed, so nothing here was checked on a device and all pixel heights are estimates for a 390px viewport.

### P1. The page answers "which tasks exist" before "is this done"

`mission-flight-strip.md` §7 said the strip should be *pinned under the title*. What shipped is `MissionFlightStripNav` (`page.tsx:1047`) rendered **above** `MissionInlineEdit` (`:1058`), and it brings its own full task list (`MissionFlightStripNav.tsx:87-137`). With 15 work tasks at roughly 45–55px per row plus phase headers, the title, state chip and `MissionSituationBlock` (`:1113`) start around y≈1100–1300. That is the second screen. The page's own subject ("is this mission done", surface-IA §8.5) is below the fold.

### P2. The same tasks render three times, classified two ways

1. The nav list, with THINK/BUILD labels from `deriveWorkLane` (`page.tsx:902`).
2. `MissionTabs` → `MobileRail` (`CondensedTimeline.tsx:1505`), with `deriveWorkKind` glyphs.
3. The Summary tab's "Waiting on you" chains.

Each one groups and taps differently. Rule L-4 (one classifier per task) is still open: `deriveWorkLane` (`packages/core/mission-helpers.ts:706`) remains live at `page.tsx:902,1396,1405,1417`.

### P3. Tapping a bar scrolls the navigator away

- `selectFromBar` calls `scrollIntoView({block:'center'})` (`MissionFlightStripNav.tsx:59`), but the strip is not sticky (`:70`). After a tap the strip is off-screen, and seeing it again means scrolling up.
- Bars are `ROW_H=10`px tall and can be as narrow as `MIN_BAR_W=2`px (`FlightStrip.tsx:30,37`). At 390px they cannot be a 44pt tap target in any layout.

### P4. Three tap behaviours that look identical

| Row | Tap result |
|---|---|
| Nav-list row title (`:112`) | Full push to `/app/tasks/:id`. The row has no `data-task-id`. |
| Rail row | `TaskPanelWrapper` opens `TaskPanel` through `router.replace(?task=)` (`TaskPanelWrapper.tsx:25`). |
| Completed task with no PR (`CondensedTimeline.tsx:1273-1277`) | Full push. |

`TaskPanel` slides in full width from the right (`TaskPanel.tsx:163`). Because it opens with `replace`, the phone's Back gesture **leaves the mission** instead of closing the panel. `router.replace` also re-requests the RSC for a `force-dynamic` page (`page.tsx:74`), so every panel open re-runs the whole mission query. That query loads every task, workers, full artifact `content`, and possibly a GitHub reconcile (`:91-258`).

### P5. Nothing carries focus between screens

- `?task=<id>` is supported (`TaskPanelWrapper.tsx:12`) but no link in the app produces it.
- The `+N` links send `?tab=tasks` (`MissionProgressBar.tsx:167`, `MissionProgress.tsx:55`). The page reads only `from`, `initiativeId` and `artifact` (`page.tsx:82-85`), and `MissionTabs` keeps its tab in `useState` (`:23`), so the parameter does nothing.
- These links all skip the mission and go straight to `/app/tasks/:id`:
  - the card's running-task line (`MissionProgressBar.tsx:163`)
  - action cards (`lib/action-card-context.ts:27`)
  - `TaskCard.tsx:306`
  - `NeedsInputBanner.tsx:27-53`
- The task breadcrumb (`tasks/[id]/page.tsx:598,815`) goes to a bare `/app/missions/:id`: no anchor, nothing highlighted, and you land at the top.
- The page scrolls inside `<main class="overflow-y-auto">` (`layout.tsx:86`), so Next's window-based scroll restoration never applies.
- `FlightDetailSheet` (`components/FlightDetailSheet.tsx:238`) has no non-test consumer. The list-card strip (`MissionGrid.tsx:552,715`) gets no `onBarSelect`.

### P6. Four progress shapes and two vocabularies for one mission

- **Progress shapes.** Home uses `SegmentStrip` plus the running line. The list uses FlightStrip, SegmentStrip and the situation line. Detail uses FlightStrip, SegmentStrip, the rail and Summary. The task page uses none of them.
- **Chips.** Home and list use `MissionBadges`. Detail uses the `explainMission` chip. So "stalled" reads `STALLED` on one surface and `IDLE` on another (`lib/mission-helpers.ts:266`), and BLOCKED is warning-toned on one and error-toned on the other.
- **Grouping.** Home and `MissionGrid.tsx:126` group with `statusToGroup` (`lib/mission-helpers.ts:332-361`), which never returns `running`. Every active mission under 100% therefore lands in NEEDS ATTENTION. This violates `mission-status-mobile-header-spec.md` §1.1, which is normative and says `activeAgents > 0 → running` via `healthToGroup`.
- **Live workers.** Home counts `LIVE_WORKER_STATUSES` (`home/page.tsx:704`). The list (`missions/page.tsx:238`) and detail (`[id]/page.tsx:419`) count only `status==='running'`.

### P7. "What's left" is spread over seven cards

The progress card (`:1161`), mission PR card (`:1190`), release section (`:1227`), budget (`:1236,1258`), agents row (`:1281`), completion stats and review summary all sit between the situation sentence and the task list. `mission-delivery-arc.md` intended a single Delivery block directly under the outcome.

### P8. Links and copy that point nowhere

- "See Goal Criteria above ↑" appears at `page.tsx:1147,1447,1456`.
- `#mission-goal-criteria` (`MissionSituationBlock.tsx:79`) targets no element.
- "Records · N" counts `selectMissionRecords` but jumps to the unfiltered `#mission-artifacts` dump at the very bottom (`:1620`).
- Nav-list artifact chips are `<span>`s (`MissionFlightStripNav.tsx:122`).
- PR `#N` is always rendered `text-status-success` (`:130`).

### P9. The page re-renders on every progress event

`MissionAutoRefresh` calls `router.refresh()` on `worker:progress` with only a 500ms debounce. While agents run, the full server render repeats roughly every second, and an open `TaskPanel` adds its own 5s poll of `/summary` (`TaskPanel.tsx:96`).

### Also found (helper in slice S1, call site in slice S3)

At `page.tsx:590-603` the comment said `allTasks` is newest-first, but it is sorted ascending (`:576-578`). As a result `reviewerRetryMap` kept the **oldest** retry, not the newest. S1 ships `buildReviewerRetryMap` (`lib/mission-helpers.ts`) with its regression test; it keeps the newest retry per parent regardless of input order (AC-21). S3 swaps the page's loop for it, so `page.tsx` stays in S3's hands.

---

## Core goals per screen

| Screen | The one question it answers | Its one primary action |
|---|---|---|
| **Home mission card** | Is this mission moving without me, and if not, what does it need from me? | Open the exact task that needs me, in mission context. |
| **Mission detail** | Is this mission done? If not, what is it waiting on and what is left? The task list is evidence for that answer, not the headline. | The situation block's single action. After that, reach any task without losing my place. |
| **Task (sheet or page)** | What does this task need from me now, and where does it sit in its mission (phase, n of N)? | The phase action (answer, retry, merge, start). |

---

## Proposal

### Crux

**A task opens as a client-side bottom sheet over the mission. The sheet is driven by `?task=` written with native `window.history.pushState`/`replaceState`, never `router.push`/`router.replace`.**

Because the mission list never unmounts, there is no scroll position to restore. That removes "scroll back up" at its source rather than patching restoration afterwards. Native history calls update `useSearchParams` without a server round trip (supported since Next 14.1; this repo is on `^16.1.6`), so opening a task no longer re-runs the `force-dynamic` mission render.

**If this is wrong,** for example because `pushState` does not sync `useSearchParams` on this Next build, or iOS Safari fights the sheet, then every open and close costs a full server render. Scroll would then be lost again after every refresh, and the fallback is the intercepting-route slot described under Open questions. Slice S4 starts with a route test that proves the sync before anything else in it is built.

### The shared object: `MissionMasthead` + `MissionPulse`

One visual object carries from the Home card to the detail header to the task sheet and task page, drawn from one pure builder.

**`MissionPulse`** is a row of segments, one per **work** task.

- **Order** is phase order, then `createdAt`, exactly as `groupTasksByPhase` produces (`lib/flight-strip-nav.ts:27`). A task never moves along the pulse when its state changes, so its position is learnable.
- **Phase boundaries** are drawn as a 2px gap.
- **Colour means state:**

  | Token | State | Glyph |
  |---|---|---|
  | `accent` | needs you | `!` |
  | `info` with a pulsing trailing edge | moving (the ghost segment from `mission-state-progress.md`) | `▯` |
  | `border` | queued | `░` |
  | `success` | done | `▮` |
  | `error` | failed | `✕` |

- **Size variants:**

  | Variant | Visual height | Touch band | Where |
  |---|---|---|---|
  | `card` | 8px | none | Home and list cards |
  | `header` | 12px | 40px | Detail sticky header |
  | `context` | 8px, with the selected task ringed | none | Sheet header and task page |

- **Above 40 work tasks** the pulse draws one segment per phase, with fill equal to the phase's done fraction. Scrub then targets phase headers.
- With 15 tasks across 358px, each segment is about 22px wide inside a 40px band. That is thumb-usable.
- The 40px band is a deliberate exception to the 44px tap-target rule. The band spans the full content width, segments sit edge to edge, and the scrub resolves the nearest segment under the finger, so the effective target is the whole strip rather than one segment. Every other control in the feed (rows, attempt links, masthead links, sheet close) is at least 44px.
- It is built on `components/SegmentStrip.tsx` (`SegmentStrip` already takes `segments: {taskId, state}[]`), adding `selectedTaskId`, `inViewTaskIds` and `onSegmentSelect`.

**`MissionMasthead`** wraps the title, one state chip, the situation sentence, the pulse and a counts caption, at three sizes:

| Size | Where | Contents |
|---|---|---|
| `card` | Home, missions list | title, chip, situation line, pulse(card), caption, one primary line |
| `sticky` | Mission detail | Full on first paint (title, chip, Verified pill, pulse(header)). Folds on scroll to a single title+chip line plus pulse. |
| `micro` | Sheet header, `MissionContextBar` on the full task page | title, chip, pulse(context), `4 / 15 · BUILD`, ‹ › |

**One vocabulary everywhere:**

- The chip comes from `deriveMissionStateView` (`lib/mission-state-view.ts:485`) and the `explainMission` chip, the accessor detail already uses. `MissionBadges` is retired from Home and the list.
- The sentence is `MissionSituationLine`/`MissionSituationBlock` (`components/missions/MissionSituationBlock.tsx`).
- Group placement uses `healthToGroup`, per the normative `mission-status-mobile-header-spec.md` §1.1. Home and `MissionGrid` stop grouping with `statusToGroup`.
- Live workers mean `LIVE_WORKER_STATUSES` (`lib/task-presentation.ts:39`) on every surface.
- Stalled reads `STALLED` everywhere, and BLOCKED uses one tone (error).
- Task kind glyphs come only from `deriveWorkKind` (`lib/task-presentation.ts:254`). `deriveWorkLane` is deleted (L-4).

### One task row: `MissionTaskRow`

Rows are 52px, one line of title plus one meta line, and the whole row is the tap target:

```
│● ◆ Add claim lease column        #412↻ › │   status glyph, kind glyph, title (1 line, truncated), PR, ›
│    BUILD · running 4m · 2 rec            │   meta: phase · time/reason · records count
```

- The status glyph comes first. `FlightStripNavTask.status` is already passed today but never rendered.
- The PR `#N` colour follows the real PR state: open is `info`, merged is `success`, CI failing or closed is `error`. This fixes `MissionFlightStripNav.tsx:130`.
- Right-side meta precedence: needs-you reason, then PR, then elapsed or queued.
- DOM: `<a href="/app/missions/X?task=Y" id="t-Y" data-testid="mission-task-row" data-task-id="Y" data-status="…">`. It is a real link, so middle-click and long-press work. A delegated click handler intercepts it and calls `pushState`.
- Retries fold under the parent as `↻ 2 attempts` (`attachAttempts`, `packages/core/mission-helpers.ts:769`; delivery-arc U8). A retry is never its own row.

---

## Grouping rules

`buildMissionFeedGroups(tasks, ctx)` is a pure function written test-first. It returns an ordered list of groups. **Every work task renders as a row exactly once** (L-1).

1. **NEEDS YOU** is pinned first, always expanded, and omitted when empty. Members:
   - `waiting_input`
   - an open mission question note naming the task
   - a PR awaiting human review or merge
   - failed with no automatic retry pending
   - blocked by an open `waiting_decision`

   Sorted oldest ask first. At most 3 rows, then `+N more ▾`.
2. **MOVING NOW** is pinned second, always expanded, and omitted when empty. Members: claimed, starting or running. Each row's meta line shows the live current action and elapsed time. Sorted by start time.
3. **Phases**, in `groupTasksByPhase` order, with the header row from `mission-legibility.md` §4 (`RailPhaseRow`, 34px, **not** sticky).
   - A **finished** phase folds to one header row: `1 · THINK ✓ 4/4 · 2 records ▸`.
   - The **current** phase (the first unfinished one) is expanded.
   - **Future** phases show their first 3 rows, then `+N queued ▸`.
   - Order within a phase: failed, then queued (ready before blocked, where blocked reads "after #x"), then done.
4. **Slot markers.** When a task is shown in a pinned group, its place in its phase renders a 20px marker row, `↑ Lease shadow mode · in Needs you`, with `data-testid="mission-task-slot"`. It is a marker, not a second row, which keeps phase counts and n/N stable.
5. **Bookkeeping**:
   - Orchestrator and bookkeeping tasks never render as rows. They appear as one `Orchestrator · N plans, M ticks ›` row.
   - `Records · N` opens a sheet of `selectMissionRecords` (`lib/flight-strip-nav.ts:56`), with "All artifacts" at the bottom of that sheet.
   - `Notes · N` opens `MissionFeed` in a sheet.
   - Settings is one row.
6. **Numbering and stepping.** `n / N` and sheet ‹ › follow **pulse order** (phase order). Pinned groups are display promotions and do not reorder the numbering. The sheet also offers `Next needing you ›`, which crosses into NEEDS YOU.
7. **Budget.** With 15 tasks, the default render is about 2 needs-you rows, 2 moving rows, the expanded current phase (≤ 5 rows), folded headers for the other phases, and 4 footer rows. That is roughly 12 short rows instead of 15 tall rows, plus headers, plus chips, plus a second list.

**Freeze rule.** Realtime updates must not move rows under a finger.
- While a sheet is open, or within 1.5s of the last `pointerdown` on the list, group and row order are frozen. Pending moves then apply with a 200ms FLIP animation.
- A task created above the viewport never pushes content down. It shows a `N new ↑` pill (`data-testid="mission-new-rows-pill"`) instead.
- Across any `router.refresh()`, the focused row's (or the first visible row's) `getBoundingClientRect().top` is recorded before the refresh and `main.scrollTop` is corrected by the difference after commit. This does not rely on `overflow-anchor`, which is not trusted on iOS Safari inside a scroll container.

---

## Wireframes (390px, 358px content width)

Usable height assumptions: 844 total, minus the status bar, minus `MissionsBottomNav` (56px) and the safe area, leaves about 650–700px. `MobilePageHeader` renders nothing on detail pages. Brutalist tokens apply (square corners, ink borders, IBM Plex Mono for labels and numbers, one orange accent). Mission names are illustrative.

### W1. Home mission card (`MissionMasthead size="card"`, the same component on the missions list)

```
┌────────────────────────────────────────┐
│ Claim loop hardening       [NEEDS YOU] │  chip: deriveMissionStateView / explain chip
│ Waiting on you: agent asked how lease  │  MissionSituationLine (same text as detail)
│ expiry should behave.                  │
│ ▮▮▮▮▮ ▮!▯▯░ ░░░░░        6/15 · 2 live │  pulse(card); gaps are phase boundaries
│ ▸ Answer: Lease shadow mode          › │  primary line: top NEEDS YOU task, else top MOVING
└────────────────────────────────────────┘
```

| Target | Goes to |
|---|---|
| Card body | `/app/missions/X?from=home` |
| Primary line | `/app/missions/X?from=home&task=Y`. The sheet opens immediately with a skeleton while the mission renders behind it. |
| Pulse, or `⤢` long-press | Opens `FlightDetailSheet` (now mounted) with the time-axis strip. A bar tap there goes to `/app/missions/X?from=home&task=<bar>`. |
| "blocked on N PRs" | `/app/missions/X?task=<first blocked-PR task>`. Today it links to `/app/home`. |

### W2. Mission detail, first screen (scrollTop = 0)

```
┌────────────────────────────────────────┐ ┐ sticky top-0 inside <main>, z-20
│ ‹ Home   Claim loop hardening        ⋮ │ │ 44  label from ?from= (Home|Missions|initiative)
│ [NEEDS YOU] [✓ 2/3 verified ▾]         │ │ 28  chip + MissionVerifiedPill; nothing else
│ ▮▮▮▮▮ ▮!▯▯░ ░░░░░            6/15   ⤢  │ │ 40  pulse(header), 40px touch band
├────────────────────────────────────────┤ ┘ ≈112
│ Waiting on you: agent asked how lease  │   MissionSituationBlock (moved up)
│ expiry should behave.                  │
│ [ Answer question ]        +2 more ▾   │   one action → opens that task's sheet
│ Integrated ◐ 4/6 · Verified 2/3 · Ship –│  MissionDelivery one-line stepper; tap expands
├────────────────────────────────────────┤ ≈250
│ NEEDS YOU · 1                          │
│! ? Lease shadow mode           #418  › │
│    BUILD · asked 12m                   │
│ MOVING NOW · 2                         │
│▯ ◆ Add claim lease column     #412↻ › │
│    BUILD · 4m · editing lease.ts       │
│▯ ◆ Heartbeat renew                   › │
│    BUILD · 1m                          │
│ 2 · BUILD  ▮▮▯▯░  3/5                  │  current phase, expanded
│  ↑ Lease shadow mode · in Needs you    │  slot marker
└────────────────────────────────────────┘ ≈650
```

At first paint the title, state, answer, action, delivery, everything that needs you and everything moving are visible. On `dev` today the title starts around y≈1100.

**Delivery expanded** (tap the stepper). Empty steps are hidden:

```
│ DELIVERY                               │
│ ◐ Integrated  4 of 6 PRs merged      › │  → mission PR card (existing, inside)
│ ○ Verified    2/3 criteria           › │  → Verified pill sheet
│ ○ Shipped     after next release       │  MissionReleaseSection
│ ✕ Budget      paused at cap          › │  only when it blocks
```

### W3. Mission detail, scrolled

```
┌────────────────────────────────────────┐ ┐ masthead folded (≈84)
│ ‹ Claim loop harden…  [NEEDS YOU]    ⋮ │ │ 44
│ ▮▮▮▮▮ ▮!▯▯░ ░░░░░   ‾‾‾‾‾        6/15  │ │ 40  ‾ underline = segments whose rows are in view
├────────────────────────────────────────┤ ┘
│✓ ◆ Schema for lease v2         #409  › │
│┃░ ◆ Drop legacy lock (after #418)   ›┃│  focused row (hash #t-…), outline fades after 2s
│ 3 · CHECK  ░░░  0/3      +3 queued ▸   │
│ 1 · THINK ✓ 4/4 · 2 records         ▸  │  finished phase, folded
│ ─ Orchestrator · 4 plans, 31 ticks   › │
│ ─ Records · 5                        › │  sheet: selectMissionRecords, lazy content
│ ─ Notes · 3                          › │  sheet: MissionFeed
│ ─ Settings                           › │
└────────────────────────────────────────┘
```

**Pulse interaction on detail** (mobile):
- Tapping or scrub-releasing a segment **focuses** its row. It sets `#t-Y` with `replaceState`, unfolds the row's phase if needed, scrolls the row under the sticky masthead (`scroll-margin-top` equals the folded masthead height), and outlines it.
- The masthead stays put, so there is never a "scroll back up".
- A second tap on the same segment, or a tap on the row, opens the sheet. This two-step keeps a mis-tap on a roughly 22px segment from opening the wrong task.
- While scrubbing, a floating label shows `Heartbeat renew · running`. The strip uses `touch-action: pan-y` so vertical page scroll still works.

### W4. Task sheet over the mission (`BottomSheet`, about 88% height)

```
┌────────────────────────────────────────┐
│ ░ mission dimmed, still in place ░░░░░ │  row outlined behind the backdrop
├━━━━━━━━━━━━━━━━ ▬▬▬ ━━━━━━━━━━━━━━━━━━━┤  drag handle: down = close
│ ‹   4 / 15 · 2 BUILD            ›   ✕  │  ‹ › = pulse order (replaceState)
│ ▮▮▮◉▮ ▮!▯▯░ ░░░░░                      │  pulse(context), this task ringed
│ Add claim lease column   [RUNNING] ⋮   │  data-testid="task-header-status" on the badge
│ ┌────────────────────────────────────┐ │
│ │ TaskActionZone (by phase)          │ │  answer / retry·switch / run now / merge
│ └────────────────────────────────────┘ │
│ Live · editing lease.ts · 4m           │  LiveWorkerActivity
│ PR #412 · CI ↻            [View diff]  │  PrCard
│ Records: plan.md · schema.diff         │  real links (/app/artifacts/Z)
│ Origin: planned by orchestrator        │  deriveTaskOrigin (U6)
│ Next needing you: Lease shadow mode  › │
│ Open full page                       › │  /app/tasks/Y?from=mission&missionId=X
└────────────────────────────────────────┘
```

The sheet renders a skeleton at once and fills from `/api/tasks/:id/summary`, as `TaskPanel` already does. A completed task with no PR still opens the sheet (summary, records, origin). The `data-task-actionable="false"` fall-through is removed.

### W5. Returning to the mission

```
Swipe down / ✕ / system Back  →  history.back() (sheet was pushed)
┌────────────────────────────────────────┐
│ ‹ Claim loop harden…  [NEEDS YOU]    ⋮ │  same scrollTop: <main> never unmounted
│ ▮▮▮◉▮ ▮!▯▯░ ░░░░░                      │  segment ringed ~2s
│┃▯ ◆ Add claim lease column    #412↻ ›┃ │  outline on the last task viewed
└────────────────────────────────────────┘    (the one you stepped to with ‹ ›)
```

If the page was entered with `?task=` already present (a deep link from Home), there is no in-app history entry to pop. Closing then calls `replaceState` to `/app/missions/X?from=…#t-Y`, which drops `task` and keeps focus.

### W6. Full task page, for a mission task (cold load or "Open full page")

```
┌────────────────────────────────────────┐ ┐ sticky MissionContextBar (≈72)
│ ‹ Claim loop harden…  [NEEDS YOU]      │ │ → /app/missions/X#t-Y
│ ▮▮▮◉▮ ▮!▯▯░ ░  4 / 15 · 2 BUILD   ‹ ›  │ │ ‹ › → sibling task pages (router.replace)
├────────────────────────────────────────┤ ┘
│ Add claim lease column                 │
│ [RUNNING] 14m                        ⋮ │  Edit / Reassign / View Source / Delete → ⋮
│ [ TaskActionZone — same component ]    │  action first
│ Mission questions about this task      │  !task.missionId gates dropped (:135, :1138)
│ Origin · Shipped in                    │  U6 / U7
│ …description, deps, history, details…  │
└────────────────────────────────────────┘
```

This replaces the bare "Next" chain CTA (`tasks/[id]/page.tsx:1191`). `/tasks/Y/respond` redirects after an answer to `/app/missions/X#t-Y`, and its back link names the mission, not the workspace.

---

## Interaction, URL and scroll model

**URL state** (mission page):

| Param | Meaning | Written by |
|---|---|---|
| `?task=Y` | The sheet is open on Y. | Open: `pushState`. Step: `replaceState`. Close: `history.back()`, or `replaceState` if the page was entered with it. |
| `#t-Y` | Focused row: scrolled into view and outlined. A hash change triggers no RSC fetch. | Segment focus and sheet close (`replaceState`). Inbound links from the task page and respond page. |
| `?from=home\|missions\|initiative&initiativeId=` | Breadcrumb label only. | Extends `lib/initiative-breadcrumb.ts`. |
| `?artifact=Z` | Opens the Records sheet at Z. | Existing convention (`mobile-artifact-feed.md` §2.2). |
| `?tab=…` | **Retired.** Accepted and ignored for backwards compatibility. No link emits it. | — |

**History rules:**

| Action | Call | Back does |
|---|---|---|
| Open a task while no sheet is open (row, second segment tap, situation action) | `pushState(?task=Y)` | Closes the sheet. |
| ‹ ›, "Next needing you", or a row tap while the sheet is already open (docked md+) | `replaceState(?task=Z)` | Closes the sheet. It does not walk back through the tasks visited. |
| Segment focus / scrub-release | `replaceState(#t-Y)` | No new entry. |
| Card body → mission | `<Link>` push `?from=home` | Home. |
| Card primary line | `<Link>` push `?from=home&task=Y` | Home. |
| Sheet "Open full page" | `<Link>` push `/app/tasks/Y?from=mission&missionId=X` | The mission with the sheet open (the RSC cache is reused). |
| Task page up-link | `<Link>` push `/app/missions/X#t-Y` | The task page. |

**Every** link into a mission-owned task goes through `missionTaskHref({missionId, taskId, from, mode: 'sheet' | 'focus'})`. The call sites are: `lib/action-card-context.ts:27`, `TaskCard.tsx:306`, `NeedsInputBanner.tsx`, `MissionProgressBar.tsx:163,167`, `MissionProgress.tsx:55`, `home/page.tsx:2658-2664`, `MissionGrid.tsx:604` (and the compact-card equivalent), `FlightDetailSheet.tsx:331`, `tasks/[id]/page.tsx:598,815`, `TaskPanel.tsx:178,273`, and the respond page.

**Scroll:**

- The mission list never unmounts while the sheet is open, so no restoration is needed on close.
- Hash focus lands arrivals from the task page and respond page. A small effect in `MissionFocusProvider` unfolds a collapsed phase or `+N`, then calls `scrollIntoView({block:'center'})` inside `<main>`.
- No `sessionStorage` scroll offset is used.

**Scroll lock.** `BottomSheet` locks `document.body.style.overflow` (`BottomSheet.tsx:27-28`), but the page scrolls in `<main>` (`layout.tsx:86`). `BottomSheet` gains a `lockTarget?: () => HTMLElement | null` prop. It defaults to `document.body`, so existing consumers see no change. The mission sheet passes `<main>`.

**Realtime:**

- `MissionAutoRefresh` stops refreshing on `worker:progress`. That event patches a client `MissionLiveStore` instead, which feeds the MOVING rows' live line and the pulse's ghost segment.
- Structural events still call `router.refresh()`, trailing-throttled to at most one per 3s: `task:created`, `task:claimed`, `worker:completed`, `worker:failed`, `children_completed`, `note_posted`, `completion_decision`.
- The sheet's 5s `/summary` poll pauses when `document.hidden` is true or when the Pusher channel is connected.
- **Safety bound:** at most one full mission render per 3s per open tab, regardless of event rate.

---

## Desktop adaptation (md and up)

- **Layout:** two columns. The left mission column is about 640px (masthead, situation, Delivery, list). On the right, the same `?task=` state renders the sheet body **docked** at about 420px: today's `TaskPanel` shell without `w-full`. There is no backdrop and no scroll lock.
- **Header strip:** the full time-axis `FlightStrip` renders inline under the masthead in place of `MissionPulse`. At md and up its bars are wide enough for a mouse, and `onBarSelect` (already a prop) sets focus. The pulse remains available as the md+ `card` variant on list cards.
- **Timeline and Structure:** `TimelineView` stays as the md+ rendering of the same `MissionTaskRow` model. The Structure view stays md+ only, behind one list-header toggle (`?view=structure`, md+ only). `MissionTabs` survives at md+ only as that two-way toggle.
- **Keyboard:** `j`/`k` step focus in pulse order, `Enter` opens, `Esc` closes.

---

## What this supersedes and keeps

**From `mission-flight-strip.md` §7 and Implementation item 3c:**

| Item | Status here |
|---|---|
| "Strip is the page's navigator, pinned under the title, one selection shared between bar and row" | **Kept and actually implemented.** On mobile the navigator is `MissionPulse`. On md+ it is `FlightStrip`. Both are sticky and both share `MissionFocusProvider`. |
| Tapping a bar scrolls to and outlines the row | **Kept as focus.** The masthead is sticky, so the navigator stays on screen. A second tap opens the sheet. |
| The phase-grouped list with a lane per row | **Kept.** It is the *only* list, replacing both `MissionFlightStripNav`'s list and `MobileRail`. The per-row label is the `deriveWorkKind` glyph. |
| Item 3c, `FlightDetailSheet` for the list card | **Kept and finally mounted**, with a focus-carrying "Open mission →". |
| Criteria in the Verified pill; Records = review-worthy; orchestrator as one row; Archive/Delete behind ⋮ | **Kept.** Records becomes a sheet rather than an anchor. |
| Rule L-4 | **Completed** in slices S1 and S3. |
| The time-axis strip as the always-visible mobile navigator | **Superseded on mobile.** Its bars cannot be tapped at 390px (`FlightStrip.tsx:30,37`). It moves into `FlightDetailSheet` on mobile. |

**Also kept:**

- **`mission-delivery-arc.md`:** the Delivery block directly under the outcome with no empty rows, here as a one-line stepper that expands. U6 (Origin) and U7 (Shipped in) go on the sheet and the task page, and U8 (attempts under parent) goes in the list.
- **`mission-state-progress.md`:** the ghost segment, one segment vocabulary shared by the mission bar and the task position, and two-way links (the card names its task, the task names its mission).
- **`mission-legibility.md` §4:** phase header rows.
- **`mobile-artifact-feed.md` §2.2–2.3:** `?artifact=` and `?from=mission&missionId=`, generalised to `?from=` plus `#t-`.
- **`mission-status-mobile-header-spec.md` §1.1:** now enforced on Home and the list via `healthToGroup`.

**Retired:**

- the list inside `MissionFlightStripNav.tsx:87-137`, and then the component itself
- `MissionTabs` on mobile, and the `N_SMALL=8` default-tab logic (`page.tsx:839`)
- the Summary tab (absorbed into NEEDS YOU)
- the Feed tab (it becomes the Notes sheet)
- the standalone progress card (`:1161`) and agents row (`:1281`), absorbed into the masthead caption and Delivery
- the page-bottom `MissionArtifacts` full-content dump (`:1620`)
- `?tab=`
- `router.replace` in `TaskPanelWrapper`
- the `data-task-actionable` opt-out
- `MissionBadges` on Home and the list
- `statusToGroup` as the source of the card grouping

**Doc bookkeeping when S3 lands:** set `mission-flight-strip.md` item 3c to "Done" and L-4 to "Done", then promote it to `implemented`. PR #2666's premise (AC-1 unmet) is already false on `dev`, so close it rather than rebase.

---

## Acceptance criteria

Each one is checkable by a unit, component or route test, or by a `git grep` test.

1. **Order.** In the mission detail DOM, `[data-testid=mission-masthead]` precedes `[data-testid=mission-situation]`, which precedes `[data-testid=mission-delivery]`, which precedes the first `[data-testid=mission-task-row]`. Nothing with `data-testid=mission-task-row` appears before `mission-situation`.
2. **One list.** For every work task, exactly one `[data-testid=mission-task-row][data-task-id=<id>]` exists in the mobile render. `MissionFlightStripNav` has no importer.
3. **Slot markers.** A task in NEEDS YOU or MOVING NOW also yields exactly one `[data-testid=mission-task-slot][data-task-id=<id>]` inside its phase group, and no second row.
4. **Pulse parity.** `buildPulseSegments(tasks).map(s => s.taskId)` equals the flattened `groupTasksByPhase` order. The `[data-testid=mission-pulse-segment]` count equals the work-task count when ≤ 40 and the phase count when > 40. The same builder output renders in card, header and context variants (snapshot of `data-task-id` order).
5. **Sticky.** `[data-testid=mission-masthead]` has `position: sticky; top: 0` (class assertion). Rows carry `scroll-margin-top` equal to the folded masthead height token.
6. **Focus.** Segment select calls `history.replaceState` with a URL ending in `#t-<id>`, sets `aria-current="true"` on that segment, and outlines the row (`data-focused="true"`). A second select on the same segment opens the sheet.
7. **Sheet open.** A row click calls `window.history.pushState` with `?task=<id>` and does **not** call `router.push`, `router.replace` or `router.refresh` (spies). `[data-testid=mission-task-sheet]` renders synchronously with a skeleton.
8. **Sheet history.** ‹ › call `replaceState`. A `popstate` with no `task` param closes the sheet. When the page is entered with `?task=`, close calls `replaceState` to a URL without `task` and with `#t-<id>`.
9. **Scroll lock.** With `lockTarget` set to `<main>`, `main.style.overflow === 'hidden'` while open and `document.body.style.overflow` is unchanged. With no `lockTarget`, body is locked (the default no-op preserved).
10. **Tap uniformity.** No element under `mission-rail`/`mission-feed` has `data-task-actionable="false"`. A completed task with no PR opens the sheet.
11. **Link helper.** A grep test fails if any file in the call-site list contains a template `` `/app/tasks/${ `` outside `lib/mission-task-href.ts`. `git grep -n "tab=tasks"` under `apps/web/src` returns nothing.
12. **Return.** The task-page up-link and the `TaskPanel` full-page return link have `href` `/app/missions/X#t-Y`. The respond action redirects to `/app/missions/X#t-Y` for mission tasks.
13. **Context bar.** For a mission task, `tasks/[id]` renders `[data-testid=mission-context-bar]` containing `n / N` and the phase label, with ‹ › hrefs to the pulse-order siblings. It is absent for non-mission tasks.
14. **Vocabulary.** A mission with `activeAgents > 0` and progress < 100 lands in the `running` group on both Home and `MissionGrid` (via `healthToGroup`). A stalled mission shows chip text `STALLED` on card and detail. A worker in `waiting_input` counts as live on all three surfaces.
15. **L-4.** `git grep -w deriveWorkLane` returns nothing. `computeMissionFlightStrip` lanes come from the `deriveWorkKind` adapter (core unit test).
16. **Copy and links.** `git grep "See Goal Criteria above"` and `git grep "#mission-goal-criteria"` return nothing. `Records · N` opens `[data-testid=mission-records-sheet]`, listing only `selectMissionRecords` output.
17. **Realtime.** A `MissionAutoRefresh` test with a mocked Pusher: 20 `worker:progress` events produce 0 `router.refresh` calls and N store patches. 5 structural events within 3s produce exactly 1 refresh.
18. **Payload.** The mission page's task query `columns`/`with` do not select artifact `content`, task `result` or task `context` (query-shape test).
19. **Kept testids.** `task-header-status` (sheet and page status badge), `sidebar-task-item`, and `worker-needs-input-banner` still render in their existing positions (existing tests stay green).
20. **FlightDetailSheet.** It has at least one non-test importer. Its "Open mission →" href carries `task=<selectedBar>`.
21. **reviewerRetryMap.** Given two retries, the map keeps the newer one (regression test).

---

## Build plan

Each slice is one PR with tests written first. Ownership is disjoint so that slices marked parallel can proceed concurrently. The two sequential hand-offs of a shared file are called out explicitly. Test paths follow the repo's co-location rules and are collected by `bun run test`.

### S1: Pure model and vocabulary (no layout change)

**Owns:**
- new `apps/web/src/lib/mission-pulse.ts`
- new `apps/web/src/lib/mission-feed-groups.ts`
- new `apps/web/src/lib/mission-task-href.ts`
- `apps/web/src/lib/mission-helpers.ts`
- `packages/core/mission-helpers.ts` (L-1 adapter only)

**Change:**
- `buildPulseSegments(tasks)` (phase order, phase gaps, state mapping, > 40 fold).
- `buildMissionFeedGroups(tasks, ctx)` (NEEDS YOU, MOVING NOW, phases, slot markers, fold defaults, pulse-order `n/N` and siblings).
- `missionTaskHref(...)`.
- The chip mapping in `apps/web/src/lib/mission-helpers.ts`: STALLED instead of IDLE at `:266`, and a single BLOCKED tone.
- Switch `computeMissionFlightStrip`'s lane source to a `deriveWorkKind`-based adapter. Leave `deriveWorkLane` exported until S3 removes its last callers.

**Tests:**
- `apps/web/src/lib/mission-pulse.test.ts`: order equals `groupTasksByPhase`, gaps, the 40/41 boundary.
- `apps/web/src/lib/mission-feed-groups.test.ts`: every task once, slot markers, pinned caps, fold defaults, siblings.
- `apps/web/src/lib/mission-task-href.test.ts`
- the chip cases in the existing mission-helpers tests
- `packages/core/__tests__/` flight-strip lane adapter

**Deps:** none. Land first.

**Built.** What S1 shipped, including where it differs from the plan above:

- `lib/mission-pulse.ts` owns the two facts every surface must agree on: which tasks are rows (`foldMissionDeliverables`, D1) and what state a row is in (`deriveFeedTaskState`). `buildPulseSegments` and `buildMissionFeedGroups` both read them, so the pulse, the list and `n / N` count the same rows. Attempts are detected by `taskClass === 'attempt'` only. A pre-backfill row with a NULL `taskClass` is not folded, because the task-class invariants (`packages/core/__tests__/task-class-invariants.test.ts`) ban the title-prefix predicate.
- A cancelled or failed deliverable that has a later deliverable with the same title (bracket prefix stripped) is treated as a re-creation. It folds under the newest one. Two completed tasks with the same title stay two rows.
- The Rule L-1 kind→lane table (`WORK_KIND_LANE`) and the one precedence chain (`resolveWorkKind`) live in `packages/core/mission-helpers.ts`, not in `task-presentation.ts`. The reason is that `computeMissionFlightStrip` is computed in core, for the cache and its backfill, and core cannot import the web app. `deriveWorkKind` is now a glyph lookup over `resolveWorkKind`. `computeMissionFlightStrip` reads `workKindLane`. `deriveWorkLane` is deprecated and remains exported only for the detail page's callers, which S3 removes.
- D2, **partly built; D2 stays open.** Built in S1: the `stalled` chip reads `STALLED`. `HEALTH_CHIP_CLASS` gives the Home/list health chip the same tokens as the detail chip, so BLOCKED is error-toned on both. The steering-cost stats (`MissionAuthorshipStats`) moved off the list cards and the detail header into the mission Settings panel under "Diagnostics", and the list page no longer computes them. `deriveVerificationNeighbour` owns the goal-criteria pill beside the card chip and renders nothing beside a completed, archived or cancelled mission, so "Complete" next to "Needs verification" or "Evaluating" cannot happen on a card (table-tested).
  **Deferred:** the *single derivation*. Cards still derive their chip from `Health` (`MissionBadges`), and the detail header from `MissionDisplayState` (`explainMission` / `deriveMissionStateView`). **S5** closes this when Home and the list render `MissionMasthead size="card"` with the `deriveMissionStateView` chip; the verification pill folds into that one chip there (the `awaiting_verification` state already exists), which also covers "Ready for review" next to "Needs verification". The detail header already suppresses the criteria banner for terminal missions; **S3** keeps that rule when it moves the header into the sticky masthead.
- D3: `selectMissionCompletionSummary` picks the completion summary. In order it tries the completion-evaluation task, then an orchestrator summary written after the last *completed* deliverable (a cancelled or failed deliverable touched later does not make it stale), then the system "Mission completed" note. It never uses a work task or an attempt. A mission completed by hand, with none of those, shows no summary. That is intended: the only other candidate is the latest task's summary, which is the D3 defect.
- `deriveFeedPrState` maps every `prLifecycleStatus` value (table-tested). `conflict` and `unresolvable` are error-toned. `pr_open` / `ci_running` read as moving, not NEEDS YOU, because auto-merge evaluates on the green transition. A PR still open at `ci_green` is yours: auto-merge already ran and declined, or is off. `unresolvable` is terminal and reads failed, never NEEDS YOU, because nobody can act on it from the mission.
- `buildReviewerRetryMap` (AC-21) is built and tested here. The call-site swap in `page.tsx` is left to S3.

### S2: Shared components (unwired)

**Owns:**
- new `apps/web/src/components/missions/MissionPulse.tsx`
- new `components/missions/MissionMasthead.tsx`
- new `components/missions/MissionTaskRow.tsx`
- `apps/web/src/components/BottomSheet.tsx`
- `components/SegmentStrip.tsx`
- new `app/app/(protected)/missions/[id]/MissionFocusProvider.tsx`

**Change:**
- Pulse variants, the scrub handler (pointer events, `touch-action: pan-y`, floating label) and the `inViewTaskIds` underline.
- Masthead sizes `card`/`sticky`/`micro` with fold-on-scroll.
- The row anatomy: status glyph first, PR state colour, attempts disclosure.
- `BottomSheet` gets `lockTarget` (default body) and a `height="tall"` option (88vh).
- `MissionFocusProvider` holds the single selection, hash read and write, unfold-then-scroll, IntersectionObserver, and the freeze window.

**Tests:** component tests with `data-testid`: `mission-pulse`, `mission-pulse-segment` (`data-task-id`, `data-state`, `aria-current`), `mission-masthead`, `mission-task-row` (`data-status`), and `BottomSheet` lockTarget (AC-9). Focus-provider tests cover AC-6 and the freeze window using fake timers.

**Deps:** S1.

**Built.** What S2 shipped, including where it differs from the plan above. Nothing is wired into a page yet; S3–S6 mount these.

- `MissionPulse` renders `buildPulseSegments` output in three variants (`card` 8px, `header` 12px in a 40px band, `context` 8px with the task ringed). Every segment carries `data-task-id`, `data-state`, `data-kind`, `data-gap-before`, `data-in-view`, `data-ringed` and `aria-current`. Colour comes only from `PULSE_STATE_TOKEN` through one token→class table. The scrub gesture is a pure state machine (`createPulseScrub` over `pulseLayout`/`segmentAt`). A click right after a handled release is swallowed, so a tap cannot select twice and open the sheet by accident. With `connected`, the pulse reads the selection and in-view set from `MissionFocusProvider`, which is how the sticky header gets them from a server-rendered page (no function props).
- **Deviation:** the pulse is its own renderer instead of new props on `SegmentStrip`. `SegmentStrip` speaks the chain glyph vocabulary (`solid`/`half`/`ghost`/…). The pulse speaks `PulseState` with the accent/info tokens. Merging the two would recolour every existing `SegmentStrip` consumer. `SegmentStrip.tsx` is unchanged.
- `MissionMasthead` renders `card` (stretched card link, with the primary line as a sibling link, never nested), `sticky` (`sticky top-0 z-20`, folds on scroll with hysteresis via `nextMastheadFolded`) and `micro` (`n / N · PHASE`, ‹ › as hrefs or `onStep`). It takes the accessor's `chip` and `situation` and phrases neither. `MISSION_MASTHEAD_FOLDED_PX` (84) is the folded-height token.
- `MissionTaskRow` is a real `<a>` to `missionTaskHref(mode: 'sheet')`, with `id="t-<id>"`, `data-testid="mission-task-row"`, `data-task-id`, `data-status` (the pulse state) and `data-focused`. Its `scroll-margin-top` equals the folded masthead token (AC-5). The status glyph comes first, then the `deriveWorkKind` glyph (`MissionFeedTaskInput` gained `roleSlug` for its fallback tier). The PR `#N` is coloured by `PR_STATE_TOKEN`, with `↻` while checks run. Attempts fold into a `↻ N attempts` disclosure beside the link, not inside it. `buildTaskRowMeta` builds the meta line.
- `BottomSheet` gained `lockTarget` (default body; `lockScroll`/`resolveLockTarget` are exported and tested for AC-9), `height="tall"` (`h-[88dvh]` with a scrolling body) and `testId`. Existing consumers are unchanged.
- `MissionFocusProvider` wraps `createMissionFocusStore`, which takes injected history, location, timers and observer. It holds the selection, and the outline clears after `FOCUS_OUTLINE_MS`. First select writes `#t-<id>` with `replaceState`. A second select opens the task with `pushState(?task=)`, never `router.*`. S4 can take this over with `setOpenTask` and reports the sheet with `setSheetOpen`. A folded row is marked `revealedTaskIds` and scrolled once it registers. The store also runs the IntersectionObserver rooted on `<main>` and the freeze window (`FREEZE_AFTER_POINTER_MS`, or while the sheet is open), exposed as `createFreezeGate`. The React context lives in `components/missions/mission-focus-context.ts`, so components never import a route file. The 200ms FLIP on unfreeze is left to S3, which owns the list that moves.
- **D4, S2 part:** the pulse is the mobile card and header object. `FlightStrip`'s axis labels (phase, `now`, `+N more`) are collision-culled by `cullAxisLabels` with a 4px minimum gap. `now` is clamped inside the strip, other labels that would overflow are dropped, and an unlabelled gap is fine. The lane-label column widens (`laneLabelColumnWidth`) only when a label such as UNCLASSIFIED would not fit, so lane labels are never cut off. `flight-strip-board-encodings.test.tsx` now counts phase dividers instead of requiring every phase label, because a culled label is correct. Moving the time strip into `FlightDetailSheet` on mobile is S3/S5.

### S3: Mission detail layout

**Owns:**
- `missions/[id]/page.tsx` (render tree and callers only)
- `missions/[id]/MissionFlightStripNav.tsx` (delete)
- `missions/[id]/MissionTabs.tsx` (md+ toggle only)
- `missions/[id]/CondensedTimeline.tsx` (`MobileRail` replaced; `TimelineView` fed `MissionTaskRow`)
- new `missions/[id]/MissionFeedList.tsx`
- new `missions/[id]/MissionDelivery.tsx`
- new `missions/[id]/MissionRecordsSheet.tsx`
- `components/missions/MissionSituationBlock.tsx`
- `missions/[id]/MissionFeed.tsx` (render inside a sheet)
- then, sequentially after S1, the deletion of `deriveWorkLane` (and `hasNoWorkLaneData`) in `packages/core/mission-helpers.ts`

**Change:**
- Render order per W2 and W3.
- Sticky masthead, with the situation block first.
- The one-line Delivery stepper merging the progress, PR, release and budget cards.
- The feed list with footer rows: Orchestrator, Records sheet, Notes sheet, Settings.
- Remove the "above ↑" copy and the dead anchor.
- Replace `deriveWorkLane` at `:902,1396,1405,1417`.

**Tests:**
- a page render test for AC-1/2/3/5/16 using fixture missions of 3, 15 and 45 tasks
- an update to `CondensedTimeline.rail.test.tsx`
- the grep tests for AC-15/16

**Deps:** S1, S2. Keep it small and quick, because concurrent sessions touch `page.tsx`.

**Built.** What S3 shipped, including where it differs from the plan above. The contract is `docs/specs/mission-feed.md`, which supersedes `docs/specs/timeline-mobile-rail.md`.

- `page.tsx` loads and derives; the new `MissionDetailView` renders, in W2 order: sticky `MissionMasthead` (back label from `?from=` via `mastheadBack`, chip, Verified pill, header pulse, caption, ⋮), the situation, `MissionDelivery`, then the list, then the footer rows. The composition is a server component with every client piece passed in, so `MissionDetailView.test.tsx` renders the whole order for 3-, 15- and 45-task fixtures (AC-1/2/3/4/5). `TaskPanelWrapper` (S4) wraps it and mounts `MissionFocusProvider`; the page derives the feed once (`buildMissionFeedView`, `mission-feed-view.ts`) and hands the same `feedTasks` to the sheet owner, the pulse and the list.
- `MissionFeedList` is the one mobile list, over `buildMissionFeedGroups`. Folded rows (finished phases, `+N queued`, NEEDS YOU past three) stay in the DOM with `hidden`, so every deliverable is exactly one `mission-task-row` and a `#t-` arrival always finds its row. A reveal from the focus store unfolds the row's group and scrolls it once it is visible. The freeze gate holds the task set while frozen; moved rows slide into place over 200ms (`flipDeltas`). A mission with no phased task renders no phase header and never folds (mission-legibility §4). A slot marker sits at the task's own place in its phase (where its row would sort unpinned); it is a non-interactive, `aria-hidden` 20px marker, because the pinned row is the tap target. Focusing a pinned row never unfolds its home phase.
- `MissionDelivery` over `buildDeliverySteps` (`lib/mission-delivery.ts`) replaces the progress card, the mission PR card, the release card, both budget cards, the completion stat tiles and the agents row (D5). Empty steps are hidden. A blocked step opens it. The mission PR card and the review summary sit under Integrated, `MissionReleaseSection` under Shipped, the budget banner under Budget. The completion stats are the Integrated detail.
- D6, S3 part: the Shipped step is this mission's fact. It compares the mission's own trunk merges (`missionTrunkMergedAt`: every worker merge, or only the merged integration PR for an integration-branch mission) with how far releases reach (`deliveryReleaseInput`: the gated baseline, everything for a zero queue, a healthy continuous deploy's time). Nothing merged hides the step; any merge newer than the baseline reads "after next release"; every merge at or before it reads "released". The workspace's queue depth and Release now appear once, inside the expanded Shipped step, never on the step line.
- The one-line summary wraps between steps instead of truncating, so Budget never drops off at 358px. The expanded Verified step links to the Verified pill's sheet.
- Footer rows: Orchestrator (a disclosure of the bookkeeping runs, mobile only because the md+ Timeline keeps its own footer), `Records · N` (`MissionRecordsSheet`: `selectMissionRecords`, then "All artifacts" in the same sheet; `?artifact=` opens it), Notes (`MissionNotesSheet` in `MissionFeed.tsx`, which mounts the feed only when opened) and Settings. The page-bottom artifact dump is gone.
- Settings is a footer row like the others (44px). It also holds what used to crowd the header: title and description editing, the workspace link, next run, heartbeat badge, policy chip and initiative selector.
- The situation's criteria affordance targets `#mission-criteria`, the Verified pill's id; the pill opens its sheet on that hash and on any click of a link to it. When the pill is not rendered (a terminal mission whose criteria do not pass, or one with none), the affordance is dropped rather than pointing at nothing. The "above ↑" copy is removed. Task affordances in the situation block link to `?task=` with `data-task-id`, so the sheet owner intercepts them.
- D2 rule kept: beside a terminal mission's chip the Verified pill renders only when criteria pass.
- Live workers on the detail page count `LIVE_WORKER_STATUSES`.
- `deriveWorkLane` and `hasNoWorkLaneData` are deleted (L-4, AC-15). `reviewerRetryMap` is `buildReviewerRetryMap` (AC-21). `MissionFlightStripNav.tsx` is deleted. `mission-detail-retirements.test.ts` pins all of this with `git grep`.
- **Deviation — md and up.** `CondensedTimeline` keeps `TimelineView` as the md+ list, behind the `MissionTabs` Timeline / Structure toggle (`?view=structure`, written with `replaceState`). It is not yet fed `MissionTaskRow`, so desktop still groups with the old chain classifier; that migration is a follow-up. `MobileRail` and the Summary view are removed from it. The md+ time-axis strip renders inline under the masthead (`MissionFlightStripInline`) in place of the header pulse, which is `md:hidden`; a bar opens its task directly, because the md+ list has no focusable `#t-` rows yet. On mobile ⤢ opens `FlightDetailSheet` (D4).
- **Deviation — rail model.** The rail's pure model (`buildRail` and friends in `lib/condensed-timeline.ts`) and its model tests remain; nothing renders them. Deleting them is a follow-up.
- **Not built here:** NEEDS YOU from open mission questions and open decisions (the `ctx` maps of `buildMissionFeedGroups`; the page passes none yet), the phase header's mini pulse (W2 `2 · BUILD ▮▮▯▯░ 3/5`), the Notes count, the `N new ↑` pill and the refresh scroll anchor (S7), and the sheet itself (S4).
- Edits outside S3's own files: `pulseDoneCounts` and `buildPulseCaption` moved into `lib/mission-pulse.ts` (S1; re-exported from the S2 components), because the server page calls them and a function exported from a `'use client'` module is a client reference (`client-boundary.test.ts`). `buildMissionFeedGroups` (S1) now places a slot at its row's sorted position instead of first. `MissionMasthead` (S2) takes `pulseClassName`. `MissionVerifiedPill` (unowned) opens on clicks of `#mission-criteria` links. The gated release footer and `ReleaseState` carry `baselineAsOf`, the instant the queue is measured from.

### S4: Task sheet (parallel with S3)

**Owns:**
- `missions/[id]/TaskPanelWrapper.tsx` and `TaskPanelWrapper.test.ts`
- `missions/[id]/TaskPanel.tsx`
- new `missions/[id]/TaskActionZone.tsx`, extracted from `TaskPanel.tsx:226-337`
- new `missions/[id]/TaskSheet.tsx`

**Change:**
- The delegated handler on `data-task-id` uses `pushState`/`replaceState`, and close follows the rules in W5.
- `BottomSheet` tall on mobile (locking `<main>`), docked at md+.
- The sheet header with `micro` masthead, ‹ ›, and "Next needing you".
- Remove the `data-task-actionable` fall-through.
- Pause the `/summary` poll while hidden or connected.

**Tests:**
- **First test:** `useSearchParams` reflects a `pushState` on this Next version (the crux gate).
- Then AC-7, 8 and 10 with router spies, the popstate close, and `task-header-status` present in the sheet.

**Deps:** S2.

**As built (PR #2718):**
- The sheet body carries W4's Records and Origin lines. `/api/tasks/:id/summary` returns `records` (titles only, across every worker, `impl_plan` excluded) and `origin` (`deriveTaskOrigin`, the same derivation as the task page). Records link to `/app/artifacts/Z` rather than `?artifact=Z`: the mission page reads `?artifact=` only on its first render, so a soft link from an open sheet would not open the viewer.
- Opening moves focus into the sheet (mobile: modal, Tab trapped; md+: the docked panel). Closing returns focus to the task's row.
- The drag handle sits above `BottomSheet`'s header (a `handle` slot), so it stays at the top while the body scrolls.
- Whether the sheet entry was pushed is held in memory, so it does not survive a remount (Open full page → Back): ✕ then closes by replacing, leaving one extra mission entry behind. Accepted and pinned by a test (`task-sheet-history.ts`).
- Cross-slice edits: `page.tsx` (S3) passes the new `TaskPanelWrapper` props; `MissionFocusProvider.tsx` (S2) writes through `nativeHistoryData`; `CondensedTimeline.tsx` drops `data-task-actionable`.

### S5: Cards and inbound links (parallel with S3 and S4)

**Owns:**
- `home/page.tsx`
- `missions/MissionGrid.tsx`
- `missions/page.tsx`
- new `apps/web/src/lib/mission-card-views.ts` (`loadMissionCardViews()`, lifted from `missions/page.tsx:365`, batched, capped to the visible missions)
- `components/MissionProgressBar.tsx`
- `components/MissionProgress.tsx`
- `components/FlightDetailSheet.tsx`
- `lib/action-card-context.ts`
- `TaskCard.tsx`
- `components/NeedsInputBanner.tsx`

**Change:**
- Home and the list render `MissionMasthead size="card"`.
- Group via `healthToGroup`, and count live workers with `LIVE_WORKER_STATUSES`.
- Mount `FlightDetailSheet` from the card.
- Route every link through `missionTaskHref`.
- Remove `?tab=tasks`.

**Tests:** AC-11, 14 and 20. The Home render test asserts that the situation line and pulse are present and that the `running` group renders. `worker-needs-input-banner` is unchanged.

**Deps:** S1, S2.

**Built.** What S5 shipped, including where it differs from the plan above:

- The card model is split in two. `lib/mission-card-view.ts` is pure and client-safe: `summarizeMissionForCard` (health, group, live workers, schedule timing, cheap enough for every loaded mission) and `buildMissionCardView` (the `deriveMissionStateView` chip and situation, the pulse, the `n/N` caption, the one primary line). `lib/mission-card-views.ts` holds `loadMissionCardViews`. It adds one batched read (human steering marks for the time-axis strip), capped at `MISSION_CARD_VIEW_CAP`, and Home calls it only for the missions it shows. The list page already loads those marks, so it calls the pure builder directly and its serial-wait ceiling does not move.
- Group is `missionCardGroup`: terminal statuses map to `completed`, a future start gate maps to `scheduled`, and everything else goes through `healthToGroup`. Live workers are counted with `LIVE_WORKER_STATUSES`, so a worker in `waiting_input` makes its mission `running`, and "N active" counts it (D8). The header count and the tab counts both read `view.group`. A held or paused mission now sits in PAUSED / HELD per §1.1, not in SCHEDULED, which means Home no longer shows it.
- D2 is closed for cards. One chip, from the detail header's accessor. `MissionBadges` and the verification pill are gone from Home and the list (`MissionBadges` survives only on the initiative page), and the `awaiting_verification` chip carries the criteria state.
- Primary line precedence: the top NEEDS YOU row (`Answer:` / `Decide:` / `Merge:` / `Fix PR:` / `Retry:`), then the top MOVING row, then the first task blocked on a PR ("Blocked on N PRs", which used to link to `/app/home`). Every one of these links is `missionTaskHref(mode: 'sheet')`. The blocked-on-PR rule (`blockedByPRTaskIds`) now lives in the pure module, and `countBlockedByPR` returns its length, so the count and the link cannot disagree.
- `components/missions/MissionCard.tsx` renders the card for both surfaces. A full card is `MissionMasthead size="card"`, which now also renders its `expand`/`actions` slots, above the stretched link. `⤢` (`mission-card-expand`) opens `FlightDetailSheet` only when there is a strip to draw (D4). The list's Arm button uses `actions`. A completed card is compact (`mission-card-compact`): the title plus `Completed <when> · n/n`, with no pulse and no strip (D7). Descriptions are no longer printed on cards, so raw markdown cannot leak, and the role, budget, deferral, policy and finding tokens are gone.
- **Deviation (W1):** a bar tap in `FlightDetailSheet` **selects** the bar (`aria-pressed`, ring) instead of navigating, and "Open mission →" becomes "Open task in mission →" with `?task=<bar>` (AC-20). This is the same focus-first rule as the detail pulse: bars can be 2px wide, and a mis-tap should cost nothing. Each bar's target is a transparent band (`pointer-events: all`, at least 12px wide and the row height plus most of the gap), so a hollow queued bar or a 2px sliver is still hit. The bar's accessible name is its task title. Each opening of the sheet starts from `initialTaskId`, not from the last opening's selection.
- **Deviation (W1):** only `⤢` (44px) opens `FlightDetailSheet`. The pulse is not a second entry point, and there is no long-press: the pulse sits inside the card-body link, and a second target on it would compete with the tap that opens the mission.
- **Deviation (§1.3 of `mission-status-mobile-header-spec.md`):** paused and held cards stay full, not compact. Only completed cards are compact. A held mission's card carries its Arm action and the situation that explains the hold, and the compact layout has room for neither.
- **Open (§1.1 vs D8):** held and budget-exhausted missions group as PAUSED / HELD, so they appear only under the list's All tab, never on Home or in the Active and Scheduled tabs, even when the next step is the user's (Arm). This follows §1.1 as written. It sits close to D8's "waiting on the user counts as active", so the design owner should confirm it.
- Live workers on Home are an exact batched `count(distinct workers.id)` over `LIVE_WORKER_STATUSES`, passed into `summarizeMissionForCard`. The nested worker relation (`MISSION_CARD_WORKERS_WITH`, and the list's query) is capped at 5 per task, so it is ordered newest first (`startedAt`, then `updatedAt`) to keep the live re-claim inside the limit. The card reads a task's PR from its latest worker (`latestWorker`), never `workers[0]`.
- Home no longer loads `tasks.result`. The card's failed-task list doesn't read it: the `infra` flag only matters alongside a completion decision, and a card never has one.
- `selectHomeMissions` applies `MISSION_CARD_VIEW_CAP`, so capped active missions count in `hiddenCount`, and the "+N more" line names them (`N active, …`).
- D6, placement part: `MissionReleaseFooter` renders once per workspace bucket on the list (`workspace-release-footer`), never on a card. Home keeps its single Release Queue widget. **Open:** the queue count right after a release reads from the baseline ladder (`resolveGatedReleaseBaseline`: healthy, then deployed, and so on). A just-cut release is not the baseline until it is healthy, so the "unshipped" count can lag. That ladder is shared with the release routes, so the fix belongs in `lib/release-baseline.ts` and is left out of this slice.
- Inbound links: the Waiting-on-You cards (the ones inlined on Home, plus `WaitingOnYouMergeCard`, `WaitingOnYouReviewCard` and `AgentHandledCard`) go through `actionCardTaskHref`, which opens the sheet. Where a `<Link>` needs an href, `actionCardTaskLink` falls back to the mission, or to the task list, so an item without a task id cannot crash Home. `WaitingOnYouDiscrepancyCard` still links doc-fix tasks by hand: those tasks are not rows in the item's mission. The "needs input" OS notification (`NeedsInputProvider`) opens the same sheet as the banner. Retry attempts and plan approvals open their task page with `?from=mission&missionId=`. The card context line lands on `#t-<task>`. `TaskCard`, `NeedsInputBanner` (the waiting-input route now returns `missionId`), `MissionProgressBar`/`MissionProgress` and Home's recent activity all route through `missionTaskHref`. `?tab=tasks` is gone. `lib/mission-task-href-callsites.test.ts` is the AC-11 grep guard; S4 and S6 add `TaskPanel.tsx`, `tasks/[id]/page.tsx` and the respond page to its list.

### S6: Task page continuity

**Owns:**
- `tasks/[id]/page.tsx`
- new `tasks/[id]/MissionContextBar.tsx`
- `tasks/[id]/respond/page.tsx` (and its submit action)

**Change:**
- A sticky context bar backed by one light sibling query (`tasks where missionId=X and taskClass='work'`: id, title, status, kind inputs, phase fields, `createdAt`) fed through `buildPulseSegments`.
- The up-link becomes `#t-self`.
- Action zone first, importing `TaskActionZone`. Admin buttons move into ⋮.
- Drop the `!task.missionId` gates at `:135,1138`.
- Replace the `nextChainTask` CTA.
- The respond redirect and its mission-labelled back link.

**Tests:** AC-12 and 13. A mission task shows its scoped questions. The status badge testid is unchanged.

**Deps:** S2, S4 (for `TaskActionZone`).

### S7: Realtime split and payload trim

**Owns:**
- `missions/[id]/MissionAutoRefresh.tsx`
- new `missions/[id]/MissionLiveStore.ts`
- then, sequentially after S3, the query block `page.tsx:91-258`
- the records-content fetch route used by `MissionRecordsSheet`

**Change:**
- `worker:progress` patches the store. Structural events refresh at most once per 3s (trailing).
- Anchor `rect.top` across a refresh, plus the `N new ↑` pill.
- Drop artifact `content`, task `result` and task `context` from the RSC query. The Records sheet fetches content on open.

**Tests:** AC-17 and 18. A pill test asserts that an insertion above the viewport leaves `scrollTop` unchanged.

**Deps:** S3.

**Order:** S1 → S2 → {S3, S4, S5 in parallel} → S6 (after S4) and S7 (after S3).

---

## Open questions

1. **Should Home's primary line open the task sheet over Home instead of over the mission?** Doing that needs the `@sheet/(.)tasks/[id]` intercepting slot in `(protected)/layout.tsx`, and no parallel or intercepting routes exist today. It also needs `default.tsx` and catch-all handling, must exclude `/respond`, and must un-nest the task page's own scroller (`tasks/[id]/page.tsx:573`). **Lean: no for now.** Landing on the mission with the sheet open gives the user mission context, which is the point of the request. Revisit desktop-first once S7 stops refresh-on-progress.
2. **Should a segment tap open the sheet directly?** That saves a tap but risks mis-taps on roughly 22px segments, and fewer px past about 20 tasks. **Lean: focus-first, as specified.** The sheet's ‹ › makes a wrong open cheap, so this could flip after device testing.
3. **Should the up-link call `router.back()` when the previous history entry is the same mission?** That would reuse the RSC cache and avoid task↔mission back-and-forth, but the detection (a sessionStorage marker) is heuristic. **Lean: ship the plain `#t-` link, measure, then decide.**
4. **Should the 1.5s freeze window apply on desktop too?** **Lean: yes, but only while the pointer is over the list.**
5. **`MissionViewTransition` from card to masthead** (`experimental.viewTransition` in Next 16). **Lean: defer.** It is polish on an experimental flag.

## Non-goals

- Reordering Home's sections (Missions stays where it is on Home).
- The new-mission form's "Done when…" step (delivery-arc U5).
- Moving mobile scrolling from `<main>` to the window. That is a separate, app-wide PR.
- Changing mission status derivation (`deriveMissionHealth`) or the database schema. There are no migrations in any slice.
- Structure view on mobile.
- Any change to what counts as a review-worthy artifact (`selectMissionRecords` is used as-is).
---

## Addendum: defects confirmed from screenshots of the live site

These are acceptance criteria and join the slice named in brackets.

- **D1 [S1] Retries and cancellations fold.** Cancelled re-creations and retry/reviewer attempts never render as their own rows. They fold under their parent as an attempts line, and the counts shown equal the number of deliverable rows shown.
- **D2 [S1] One state chip.** A mission shows exactly one state chip, from a single derivation. There are no contradictory neighbours (for example COMPLETE next to Pending, or Complete next to Needs verification). Internal jargon like "HUMAN n% (x AT START, y MID-FLIGHT) FOLLOW-UPS" is removed from cards and headers. At most it appears as a detail inside Settings or diagnostics.
- **D3 [S1] Correct completion summary.** The mission completion summary comes from the mission's own completion or decision record, never from the latest task's summary. A stale retry's "no action needed" can't become the mission summary.
- **D4 [S2/S3] Flight strip readable or absent.** Axis gap labels never overlap. They are collision-culled with a minimum pixel gap, and an unlabelled gap is fine. Lane labels are never truncated. On mobile, cards and headers use the pulse, not the multi-lane time strip. The time strip lives only in the expandable FlightDetailSheet.
- **D5 [S3] Stats in one line.** The progress bar and the four stat tiles (Tasks, Completed, PRs, Duration) collapse into the one-line delivery stepper. Records and artifacts render once, in the Records sheet.
- **D6 [S3/S5] Release status is fresh and in the right place.** "N unshipped · Release now" is workspace-level. It appears once, on the workspace or Home surface, never on each mission card. It reflects the latest deploy, so it can't be stale right after a release.
- **D7 [S5] One clean card.** A missions-list card shows the title, one chip, the situation line, the pulse (card variant), the n/N caption and one primary line. It has no raw markdown (the description is rendered or stripped, never printed as `## …`) and no orphan tokens like "· Deferred". Completed missions render compact, with no strip and a single "Completed <when> · n/n" line.
- **D8 [S5] Header counts agree with the cards.** The list header's "N active" uses the same grouping as the cards. A mission that is waiting on the user counts as active.
- **D9 [S6] Task page cleanup.** Reviewer or retry attempts never render as the "Execution plan". Deliverable text isn't duplicated between the description and the summary. The title has room, with Edit moved into the ⋮ menu.

## Addendum: polish pass after S7 (390px review)

- **Attempts ride the meta line.** `MissionTaskRow` no longer adds a full-height `↻ N attempts` line under a retried row; the count is the tail of the meta line (`done · 1 rec · ↻ 3`). The link cannot hold a button, so an overlay repeats the meta text invisibly and puts the `mission-task-attempts` toggle exactly over `· ↻ N`. Its hit area is 44px, anchored to the row's bottom edge so it never reaches into the next row. It may overlap the title just above the count, where a mis-tap only unfolds the attempts. Expanded attempts render inline under the row (`mission-task-attempts-list`), one 44px link each.
- **A finished unphased mission folds.** The mission-legibility §4 rule (no phase header on a mission with no phased task) now holds only while work is open. Once every row is finished, the single group folds like a finished phase under a `Tasks ✓ n/n · N records ▸` header, so a completed mission's first screen is the masthead, the situation, delivery and folded headers. `buildMissionFeedGroups` already marked the group `finished`/`collapsed`; the list was overriding it.
- **No provenance on the page.** The situation block's `from <source>` line is gone; the source is kept on the block as `data-derived-from` for diagnostics. The completion record is humanised at render (`formatCompletionRecord`): `12 delivered · 9 cancelled`, and `evaluated 3h ago` through `timeAgo` instead of a raw ISO time. Stored notes are unchanged.
- **D8, the paused half.** `deriveMissionHealth` returns `paused` before it reads workers or criteria, so a paused or budget-stopped mission whose chip read READY FOR REVIEW or AWAITING DECISION sat under PAUSED / HELD and "N active" skipped it. `missionCardGroup` now puts such a mission in `review` (work done), `attention` (criteria escalated, nothing left to do) or `running` (a live worker, including `waiting_input`). Held missions stay in PAUSED / HELD per §1.1.
- **Missions list spacing.** Consecutive completed-only workspaces stack in one `mission-compact-workspaces` list. Each is one full-width 44px button with no padding of its own, so the list no longer shows a large gap between one-line headers.
