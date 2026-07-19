# Mobile Filter Pattern — List Pages

**Status:** Implemented — `TaskGrid.tsx` (Activity). Apply to Missions and Team pages as they are fixed.

## Problem

On mobile (≤375px), filter controls for list views (Activity, Missions, Team) occupy 2–3 full rows before any content, pushing the first item below the midpoint of the screen. With a header, type-toggle, status-tab row, and search/group row, users on a 375px phone see only controls — no tasks — above the fold.

## Rule

**Max 2 rows of controls before the first content item on mobile.**

- Row 1: Combined filter chips (horizontally scrollable)
- Row 2: Utility controls (search icon toggle + grouping dropdown)
- Row 2.5 (conditional): Expanded search input, only when active

Desktop layout is unaffected — this is a responsive change only.

---

## Row 1 — Combined Chip Row

One horizontally scrollable chip strip replaces the separate type-toggle row and status-tab row.

**Layout:**

```
← [All] [Missions] [Tasks]  |  [Active 2] [Done 197] [Failed 1] →
```

- Single `overflow-x-auto` container, `flex`, `flex-nowrap`
- Items are `shrink-0` — they never shrink or wrap
- A thin vertical rule (`w-px h-4 bg-border-default`) separates type chips from status chips
- Chip size: `px-2.5 py-1 text-[12px]`, 28px max height

**Type chips** (left of divider): `All | Missions | Tasks`
- Active: `bg-surface-3 text-text-primary`
- Inactive: `text-text-muted`
- Controls `contentFilter` state

**Status chips** (right of divider): `Active N | Done N | Failed N`
- Active: `bg-text-primary text-surface-1` (filled dark)
- Inactive: `text-text-desc`
- Counts shown when > 0 (they carry signal)
- Chips with count=0 remain visible in muted state — absence of count is meaningful
- **Toggle behavior**: tapping an already-active status chip deselects it (returns to "all statuses")
- The "All" status option is implicit (no chip) — deselection achieves it

**Scrollbar:** hidden (`[scrollbar-width:none] [&::-webkit-scrollbar]:hidden`) — swipe gesture is discoverable from the partial overflow.

---

## Row 2 — Utility Row

```
[🔍]                                              [Group: None ▾]
```

- Search icon left; group dropdown right; flex spacer between
- Search icon tap target: 36×36px minimum
- When search is open: icon shows X (close), input appears in Row 2.5

---

## Row 2.5 — Expanded Search (conditional)

Appears below the utility row when search is active.

```
[___________________________________🔍_]
```

- Full-width `<input>` with `focus:outline-none focus:border-text-secondary`
- Auto-focused on open
- Closing (X tap) clears the search value and hides the row

---

## Search Collapse Pattern

| State | Trigger | Result |
|---|---|---|
| Collapsed (default) | — | Search icon visible in Row 2 |
| Open | Tap search icon | X icon; full-width input appears in Row 2.5, auto-focused |
| Close | Tap X icon | Search cleared; Row 2.5 hidden; back to icon |

On **desktop**: search is always a visible fixed-width input inline with the filter row (no collapse).

---

## Applied Pages

| Page | Status | Notes |
|---|---|---|
| Activity (`/app/tasks` → `TaskGrid.tsx`) | ✅ Implemented | Reference implementation |
| Missions (`/app/missions`) | TODO | After the mission header overlap fix merges |
| Team (`/app/team`) | TODO | Lower priority; simpler filter surface |

See `docs/design/mission-status-mobile-header-spec.md` for the mobile header layout being applied to Missions. Filter rows begin below the page header per that spec.

---

## Custom Dropdown Contract — WorkspaceFilter

**Rule: Never use native form controls for primary navigation or filter surfaces.**

Native `<select>` elements are OS-rendered and cannot carry brand tokens. All workspace/team filter selectors must use the custom `WorkspaceFilter` component.

### Dropdown anatomy

```
┌─────────────────────────────┐  ← 2px border-strong, hard shadow (no blur)
│ All workspaces          ✓   │  ← options list, mono font, checkmark on current
│ acme/api                    │
│ acme/frontend               │
├─────────────────────────────┤  ← 1px divider (border-default)
│ + New workspace             │  ← pinned actions footer (accent color)
└─────────────────────────────┘
```

- **Trigger**: `height: 2rem`, 2px `border-strong` border, `bg-surface-2`, mono text, chevron icon
- **Options list**: `role="listbox"`, each option is `role="option"` with `aria-selected`; checkmark (accent color) on the currently active selection
- **Pinned footer**: Separated by `border-default` divider; contains action links (e.g. "+ New workspace" → `/app/workspaces/new`). Footer links are not options — they are not focusable via Arrow keys.
- **Keyboard**: Arrow keys navigate options; Enter/Space selects; Escape closes and returns focus to trigger
- **Shadow**: `shadow-md` (hard 4px offset, no blur) on the panel when open

### Mobile presentation rule

On viewports `< 640px` the dropdown opens as a **bottom sheet**:
- Full-viewport-width panel slides up from the bottom edge
- Black/60 backdrop closes on tap
- Drag handle visual cue at top of sheet
- Options have `py-3.5` tap targets (min 44px height)
- Safe-area padding at bottom for notch phones

On desktop the panel anchors directly below (or above, if space is constrained) the trigger, right-aligned, minimum 180px wide.

### Where this component is used

`WorkspaceFilter` is the single shared component for all workspace-scoping dropdowns. Do not create per-page forks. Current surfaces:

| Surface | File |
|---------|------|
| Home | `apps/web/src/app/app/(protected)/home/page.tsx` |
| Missions | `apps/web/src/app/app/(protected)/missions/page.tsx` |
| Activity | `apps/web/src/app/app/(protected)/tasks/TaskGrid.tsx` |
| Health | `apps/web/src/app/app/(protected)/health/HealthClient.tsx` |
