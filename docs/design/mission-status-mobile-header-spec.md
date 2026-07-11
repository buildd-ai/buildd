# Spec — Mission Status Taxonomy & Mobile List-Page Header Layout

**Status**: Normative — all implementations must conform  
**Scope**: Missions page (`/app/missions`) and any future list page (Activity, etc.)  
**Related specs**: `mobile-feed-spec.md` (design tokens), `review-gate-ux.md` (status chips)

---

## 1. Mission Status Taxonomy

### 1.1 Health values → display buckets

Every mission resolves to exactly one **health** value via `deriveMissionHealth()` and then to exactly one **display bucket** (MissionGroup) via `healthToGroup()`. No health value may map to more than one bucket.

| DB `status` / runtime condition | Health (`MissionHealth`) | Display Bucket (`MissionGroup`) | Tab visibility |
|---|---|---|---|
| `status = 'completed'` | `shipped` | `completed` | Completed |
| `status = 'paused'` | `paused` | **`paused`** | All only |
| `activeAgents > 0` | `active` | `running` | Active |
| cron, within expected interval | `on-schedule` | `scheduled` | Scheduled |
| cron, overdue (>2× interval) | `stalled` | `attention` | Active |
| no cron, progress = 100 | `idle` | `review` | Active |
| no cron, progress < 100 | `idle` | `attention` | Active |

**Invariant**: `paused` is NOT in `completed`. A mission that the user has manually paused is dormant, not done. It appears only in the **All** tab.

### 1.2 Tab definitions and count invariants

| Tab | Groups shown | Count formula |
|---|---|---|
| All | all groups | `missions.length` |
| Active | running, attention, review | `running + attention + review` |
| Scheduled | scheduled | `scheduled` |
| Completed | completed | `completed` (excludes paused) |

**Invariant**: `active_count + scheduled_count + completed_count + paused_count ≤ all_count`.  
(The inequality, not equality, holds because sum-of-named-tabs excludes paused; `all` includes it.)

**Invariant**: The page-header **"N active"** figure uses the same formula as the Active tab count — derived from `FILTER_TO_GROUPS.active` via `healthToGroup`, not a separate ad-hoc health check.

### 1.3 Group render order

```
running → attention → review → scheduled → paused → completed
```

Paused and completed groups render as compact cards (dimmed, single-line). Active and scheduled groups render as full cards.

### 1.4 Single source of truth

All count computations (tab bar, page header, group headers) derive from:
1. `deriveMissionHealth()` — health from DB state
2. `healthToGroup()` — group from health
3. `FILTER_TO_GROUPS` — which groups appear in which tab

Never compute counts by matching raw `status` strings directly — always go through `healthToGroup`.

---

## 2. Mobile Header Layout — List Pages

Applies to: Missions page header. Pattern should be reused for any future list page (e.g. Activity).

### 2.1 Layout contract

**Desktop (≥ 640px / `sm:`)**: Single flex row — `justify-between`.
- Left: page title + "N active" count (inline, `items-baseline`)
- Right: controls (Seats chip + workspace selector + primary action button)

**Mobile (< 640px)**: Two stacked rows.
- Row 1: page title + "N active" count
- Row 2: controls row (Seats chip + workspace selector + primary action button), full-width, left-aligned

### 2.2 Implementation pattern

```tsx
<div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 mb-4">
  {/* Row 1 — always visible */}
  <div className="flex items-baseline gap-3 min-w-0">
    <h1>Page Title</h1>
    <span className="text-xs text-text-secondary font-light">N active</span>
  </div>
  {/* Row 2 on mobile / right on desktop */}
  <div className="flex items-center gap-2 flex-wrap">
    {/* Seats chip, if present */}
    {/* Workspace/filter selector */}
    {/* Primary action button */}
  </div>
</div>
```

### 2.3 Rules

1. **Chips and badges are always in normal document flow.** No `absolute` or `fixed` positioning for UI chrome that can obscure interactive controls (dropdowns, buttons).
2. **The controls row uses `flex-wrap`** so it gracefully wraps below 320px rather than overflowing or hiding content.
3. **Breakpoint**: `sm:` (640px). Below this width, stacking applies.
4. The Seats chip belongs in the controls row (Row 2), not the title row — it is operational metadata, not part of the page title.

### 2.4 Verification

- Screenshot at 375px width: no overlap between title, Seats chip, workspace selector, or New Mission button.
- Screenshot at 320px width: controls row wraps cleanly, no horizontal scroll.
- Screenshot at 640px+ width: single row with title on left, controls on right.
