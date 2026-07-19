# Plan: Remove Objectives — Port Features to Mission Detail

## Context

The `/app/objectives/[id]` route is an orphaned page with no navigation links. It was the original mission configuration UI before missions got their own detail page. Both routes hit the same API (`/api/missions/[id]`) and the same DB table (`missions`). The objectives page has ~14 files with significant unique features that missions lack. This plan ports the valuable features and deletes objectives.

**Related PR:** #576 (`feat/unified-activity-view`) already unified navigation and added Activity tab. This is the next step.

---

## iOS / Web Alignment Analysis

### Current State

| Feature | Web (missions) | iOS | Objectives (to delete) |
|---------|---------------|-----|----------------------|
| **Navigation tabs** | Home, Missions, Activity, Team, You | Missions, Create, Tasks, Settings | N/A |
| **Tab naming** | "Activity" (clipboard icon) | "Tasks" (list.bullet icon) | N/A |
| **Mission detail** | Title, description, timeline, settings, task list | Title, description, heartbeat, progress, actions, task groups | Full config panel |
| **Heartbeat** | Not shown | Full: schedule, stale indicator, checklist | Full: editor, active hours, timeline, status badge |
| **Action buttons** | Status toggle + Evaluate now | Pause/Resume + Run | Pause/Resume/Complete/Archive + Run + Schedule edit + Delete |
| **Config** | None | None | Skills, recipe, model, output schema, workspace |
| **Schedule** | Cron shown readonly | Cron shown readonly | Interactive wizard with presets |
| **Priority** | Not exposed | Not exposed | 3-level visual selector |
| **Quick create** | Quick task on mission detail | Dedicated Create tab (missions) | N/A |
| **Task interaction** | Slide-over panel (PR #576) | NavigationLink to TaskDetailView | N/A |

### Gaps to Close

1. **Tab naming**: iOS says "Tasks", web says "Activity" — align to **Activity** on both
2. **Heartbeat support**: iOS has it, web missions don't — port from objectives
3. **Action buttons**: iOS has Pause/Resume/Run, web only has toggle + evaluate — port from objectives
4. **Config panel**: Neither platform has it — port from objectives as collapsible section
5. **Schedule management**: Neither platform can edit schedules inline — port ScheduleWizard
6. **Navigation wrappers**: iOS `MissionDetailNavigationView` and `TaskDetailNavigationView` are placeholder `Text()` views — need real implementations

### iOS Changes Needed (separate PR to buildd-ios)

1. Rename "Tasks" tab to "Activity" (ContentView.swift tab label)
2. Wire up `MissionDetailNavigationView` to fetch mission and render `MissionDetailView`
3. Wire up `TaskDetailNavigationView` to fetch task and render `TaskDetailView`
4. Add config section to MissionDetailView (skills, model, recipe — matches web port)
5. Add schedule editing to MissionDetailView (matches web ScheduleWizard port)

---

## Objectives Feature Audit

### Port to Mission Detail (9 features)

| Component | Lines | Purpose | Port Strategy |
|-----------|-------|---------|---------------|
| **ScheduleWizard.tsx** | 217 | Cron builder with presets + validation | Add to MissionSettings as expandable section |
| **MissionConfig.tsx** | 423 | Skills, recipe, model, output schema, workspace | New collapsible "Configuration" section below settings |
| **MissionActions.tsx** | 191 | Run/Pause/Resume/Complete/Archive/Delete + schedule edit | Merge into MissionSettings action bar (replace limited controls) |
| **PrioritySelector.tsx** | 67 | 3-level priority (Low/Med/High) | Add to mission header near status badge |
| **HeartbeatChecklistEditor.tsx** | 100 | Markdown checklist for heartbeat missions | Conditional section in mission detail (when `isHeartbeat`) |
| **ActiveHoursConfig.tsx** | 127 | Time window + timezone for heartbeat | Below checklist editor (when `isHeartbeat`) |
| **HeartbeatStatusBadge.tsx** | 61 | Heartbeat health indicator | In mission header (when `isHeartbeat`) |
| **HeartbeatTimeline.tsx** | 121 | Last 20 heartbeat results with status colors | Below task timeline (when `isHeartbeat`) |
| **schedule-wizard-helpers.ts** | 130 | Presets, validation, payload builders | Move to `lib/` or inline |

### Already Equivalent — Drop

| Component | Lines | Mission Equivalent |
|-----------|-------|--------------------|
| **EditableTitle.tsx** | 68 | `MissionInlineEdit.tsx` |
| **EditableDescription.tsx** | 103 | `MissionInlineEdit.tsx` |

### Helpers to Relocate

| File | Lines | Used By |
|------|-------|---------|
| **heartbeat-helpers.ts** | 111 | HeartbeatChecklistEditor, ActiveHoursConfig, page.tsx |
| **config-helpers.ts** | 91 | MissionConfig |
| **schedule-wizard-helpers.ts** | 130 | ScheduleWizard, PrioritySelector |

Move to `apps/web/src/lib/` since they'll be used by mission detail components.

---

## Implementation Plan

### Phase 1: Move Helpers (low risk, no UI change)

1. Move `heartbeat-helpers.ts` → `apps/web/src/lib/heartbeat-helpers.ts`
2. Move `config-helpers.ts` → `apps/web/src/lib/config-helpers.ts`
3. Move `schedule-wizard-helpers.ts` → `apps/web/src/lib/schedule-wizard-helpers.ts`
4. Update imports in objectives page (temporary — deleted in Phase 4)

### Phase 2: Port Heartbeat Features

**Goal:** Mission detail shows heartbeat UI when `isHeartbeat` is true.

**2.1** Add heartbeat data to mission detail page query:
- `page.tsx` already fetches mission — ensure `isHeartbeat`, `heartbeatChecklist`, `activeHoursStart`, `activeHoursEnd`, `activeHoursTimezone` are included
- Fetch latest heartbeat tasks for timeline (last 20, ordered by createdAt desc)

**2.2** Move heartbeat components to mission detail:
- Copy `HeartbeatStatusBadge.tsx` → `missions/[id]/HeartbeatStatusBadge.tsx`
- Copy `HeartbeatChecklistEditor.tsx` → `missions/[id]/HeartbeatChecklistEditor.tsx`
- Copy `ActiveHoursConfig.tsx` → `missions/[id]/ActiveHoursConfig.tsx`
- Copy `HeartbeatTimeline.tsx` → `missions/[id]/HeartbeatTimeline.tsx`
- Update imports to use new helper locations

**2.3** Add heartbeat section to mission detail page:
- After header, before task timeline: render heartbeat status badge in header row
- Conditional "Heartbeat" section with checklist editor + active hours config
- Heartbeat timeline below task timeline

### Phase 3: Port Configuration & Actions

**3.1** Upgrade MissionSettings with better action controls:
- Add "Run Now" button (from MissionActions)
- Add Pause/Resume/Complete/Archive status transitions
- Add inline schedule editor (from MissionActions cron editing)
- Add Delete with confirmation modal
- Keep existing monitoring toggle and quick task form

**3.2** Add ScheduleWizard:
- Render below MissionSettings when mission has no schedule
- Shows cron presets, custom input, validation, next-runs preview
- Reuse existing component, update imports

**3.3** Add MissionConfig as collapsible section:
- New `MissionConfig.tsx` in `missions/[id]/`
- Collapsible "Advanced Configuration" section
- Skills management, recipe selection, model dropdown, output schema editor, workspace picker
- Only show when mission is not terminal (completed/archived)

**3.4** Add PrioritySelector:
- Render in mission header area, next to status badge
- 3-level selector: Low (0), Medium (5), High (10)

### Phase 4: Delete Objectives

**4.1** Verify no external imports:
```bash
grep -r "objectives" apps/web/src/ --include="*.ts" --include="*.tsx" | grep -v "objectives/[id]"
```

**4.2** Delete entire directory:
```
rm -rf apps/web/src/app/app/(protected)/objectives/
```

Files deleted (~17):
- `page.tsx` (main page, ~350 lines)
- `EditableTitle.tsx`, `EditableDescription.tsx`
- `HeartbeatChecklistEditor.tsx`, `ActiveHoursConfig.tsx`
- `HeartbeatStatusBadge.tsx`, `HeartbeatTimeline.tsx`
- `MissionActions.tsx`, `MissionConfig.tsx`
- `PrioritySelector.tsx`, `ScheduleWizard.tsx`
- `heartbeat-helpers.ts`, `config-helpers.ts`, `schedule-wizard-helpers.ts`
- Any test files
- `layout.tsx` (if exists)

**4.3** Clean up any references:
- Remove any links to `/app/objectives/` in codebase
- Remove from any nav components (should be none — already orphaned)

---

## Sequencing & PRs

```
PR 1: Helpers + Heartbeat (Phases 1 + 2)
  Low risk. Adds heartbeat UI to mission detail.
  Objectives still works (updated imports).

PR 2: Config + Actions (Phase 3)
  Medium risk. Replaces MissionSettings internals.
  Port remaining features. Objectives now fully redundant.

PR 3: Delete Objectives (Phase 4)
  Cleanup. Delete orphaned directory.
  Can ship same day as PR 2.
```

Alternative: ship as single PR if confident in testing.

---

## Verification

1. **Type check:** `cd apps/web && npx tsc --noEmit`
2. **Tests:** `bun test apps/web/src/app/api/` — ensure no import breakage
3. **Manual QA:**
   - Mission detail (non-heartbeat): shows upgraded action bar, config section, priority selector
   - Mission detail (heartbeat): shows heartbeat badge, checklist editor, active hours, timeline
   - ScheduleWizard appears for missions without schedule
   - Config changes save correctly (skills, model, recipe, schema)
   - Run Now creates task and refreshes
   - Status transitions work (pause → resume → complete → archive)
   - No 404s from deleted objectives routes
   - iOS app still works (no API changes, only UI port)

## Risk Assessment

| Risk | Impact | Mitigation |
|------|--------|------------|
| MissionConfig complexity (423 lines) | Bugs in config saving | Port as-is, test each field |
| Mission detail page becomes long | UX clutter | Collapsible sections, heartbeat conditional |
| Heartbeat edge cases | Stale/overdue detection | Port heartbeat-helpers verbatim, they're battle-tested |
| iOS divergence widens temporarily | Inconsistent experience | Document iOS follow-up tasks, ship web first |
