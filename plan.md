# Plan: Surface "Needs Input" questions in the web dashboard sidebar

## Goal
When a worker is waiting for user input (AskUserQuestion), show it directly in the sidebar task list — similar to local-ui's waiting banner — so you can see the question without clicking into the task.

## Current State
- **Local-UI**: Shows a prominent orange "waiting banner" with truncated question text + "needs input" badge
- **Web sidebar**: Only shows task title + status dot (spinning blue, pulsing amber, gray, etc.)
- **Data flow gap**: Local-UI detects `AskUserQuestion` and sets `waitingFor` locally, but does NOT sync it to the server. The PATCH endpoint doesn't accept `waitingFor`. The sidebar doesn't track it.

## Changes

### 1. Backend: Accept `waitingFor` in PATCH endpoint
**File:** `apps/web/src/app/api/workers/[id]/route.ts`
- Add `waitingFor` to the destructured body fields (line 86)
- Store it in the DB when provided (the `waiting_for` column already exists in schema)
- Clear `waitingFor` when worker status changes away from `waiting_input`

### 2. Local-UI: Report waiting status to server
**File:** `apps/local-ui/src/buildd.ts`
- Add `waitingFor` to the `updateWorker` type signature

**File:** `apps/local-ui/src/workers.ts`
- In `syncToServer()` (line 350): include workers with `'waiting'` status
- When syncing a waiting worker, send `status: 'waiting_input'` + `waitingFor` data
- When worker resumes from waiting (`sendMessage`), sync status back to `running` + clear `waitingFor`

### 3. Web sidebar: Show "needs input" state
**File:** `apps/web/src/app/app/(protected)/tasks/WorkspaceSidebar.tsx`

- Extend the `Task` interface to include optional `waitingFor?: { prompt: string }`
- In `handleWorkerUpdate`: detect `waiting_input` status, extract `waitingFor` from worker data, store it on the task, map to new task display status `'waiting_input'`
- Add new status indicator in `getStatusIndicator()`: purple/amber pulsing dot (or similar) for `waiting_input`
- Below the task title, show truncated question text (muted, small) when `waitingFor` is present
- Give `waiting_input` the highest sort priority (above `running`) so it floats to the top

### 4. Initial page load: Include waiting worker data
**File:** `apps/web/src/app/app/(protected)/tasks/layout.tsx`
- After fetching tasks, do a lightweight query for workers with `waitingFor IS NOT NULL` and status `waiting_input`
- Merge `waitingFor` data onto the matching tasks before passing to the sidebar

## Visual Design (matching local-ui style)
```
▼ my-workspace
   ⚡ Fix login bug               ← normal running task (blue spinner)
   🟣 Add dark mode               ← waiting_input (purple indicator)
      "Which theme library?"       ← truncated question (muted text, small)
   ○ Refactor auth                ← pending (gray dot)
```

## Files touched
1. `apps/web/src/app/api/workers/[id]/route.ts` — accept `waitingFor`
2. `apps/local-ui/src/buildd.ts` — add `waitingFor` to type
3. `apps/local-ui/src/workers.ts` — sync waiting state to server
4. `apps/web/src/app/app/(protected)/tasks/WorkspaceSidebar.tsx` — show needs-input UI
5. `apps/web/src/app/app/(protected)/tasks/layout.tsx` — initial load with worker data
