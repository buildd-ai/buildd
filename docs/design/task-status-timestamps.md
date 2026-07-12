# Task Status & Timestamp Semantics

> **Status:** Implemented — PR TBD

Defines how task status chips and timestamp strings are derived across all surfaces (Activity list rows, task detail page header, mission timeline rows). All logic lives in `apps/web/src/lib/task-timestamps.ts`; callers pass data and never compute display state themselves.

---

## Problem

Two separate issues compound each other on the Activity list and task detail page:

1. **Static timestamp for running tasks.** Rows show a single `updatedAt`-relative string (e.g. "1h ago") even when a worker is actively running. This conflates the *age of the task* with *how long the agent has been working* and *how recently it last emitted an event*. A healthy running worker and a hung one look identical.

2. **Status vocabulary mismatch.** The task detail page header shows chip "Assigned" (from `task.status`) while the worker card below shows "Running" (from `worker.status`). Two chips for one task, one authoritative.

---

## Status Derivation — Canonical Rule

One function (`deriveDisplayStatus`) produces the canonical display status from task + worker state. No per-surface logic is permitted.

```
displayStatus = running   when worker.status ∈ {running, starting}
displayStatus = waiting_input  when worker.status = waiting_input
displayStatus = task.status   otherwise (pending, completed, failed, cancelled, …)
```

**Corollary:** if a task has an active running worker, the task chip MUST read "Running", not "Assigned". The assignment state (`task.status = assigned`) is a DB artefact of the claim flow; the human-visible concept is "Running".

### Error badge composition

| Situation | Chip |
|---|---|
| Task running, no errors | `Running` |
| Task running, ≥1 error traces | `Running` + red `N error(s)` badge (existing pattern) |
| Task failed | `Failed` |
| Task running with recovered errors | Treat as "running" — badge communicates errors, not failure |

---

## Timestamp Semantics

Timestamp label is keyed by the **canonical display status**, not by `task.status`.

| Display Status | Label format | Reference time(s) |
|---|---|---|
| `running` | `running Xm · active Ym ago` | runtime: `worker.startedAt`; activity: `worker.updatedAt` |
| `waiting_input` | `needs input · Xm` | runtime: `worker.startedAt` |
| `pending` / `assigned` / `in_progress` (no active worker) | `queued Xh` | `task.createdAt` |
| `completed` | `Xh ago` | `task.updatedAt` |
| `failed` | `Xh ago` | `task.updatedAt` |

**Compact form for list rows:** `running Xm · active Ym ago` (use `m`/`h`/`d` abbreviations, no spaces before units).

**Detail page:** same labels, or expanded form if space allows.

### Staleness threshold

A worker is **stale** when:
- `worker.status = running`, AND
- `now − worker.updatedAt > STALENESS_THRESHOLD_MS` (currently **10 minutes**)

Stale workers get a **visual warning treatment** on the timestamp: amber color + warning icon. This is the hung-worker signal.

```typescript
export const STALENESS_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes
```

---

## Component Architecture

```
apps/web/src/lib/task-timestamps.ts   — pure util, no React
  deriveDisplayStatus(taskStatus, workerStatus?) → string
  deriveTimestampLabel({taskStatus, workerStatus, taskCreatedAt, taskUpdatedAt, workerStartedAt?, workerUpdatedAt?, now?}) → string
  isStaleWorker(workerStatus, workerUpdatedAt, now?) → boolean
  STALENESS_THRESHOLD_MS
```

All surfaces (Activity list rows, task detail header, mission timeline) import from this single module. No per-surface duplication.

---

## Data Requirements

To render timestamp semantics, the **Activity list server component** (`apps/web/src/app/app/(protected)/tasks/page.tsx`) must join active worker data:

| Field | Source |
|---|---|
| `workerStatus` | `workers.status` (running/starting/waiting\_input workers for these task IDs) |
| `workerStartedAt` | `workers.started_at` |
| `workerUpdatedAt` | `workers.updated_at` |
| `taskCreatedAt` | `tasks.created_at` |
| `taskUpdatedAt` | `tasks.updated_at` (existing `GridTask.updatedAt`) |

Query strategy: after fetching `recentTasks`, query `workers` filtered to `taskId IN (taskIds)` AND `status IN ('running', 'starting', 'waiting_input')`. Build a `Map<taskId, workerData>` and enrich `GridTask`.

---

## Surfaces

### Activity list row

```
[●] Design onboarding flow   [Running]
    buildd  ·  running 45m · active 2m ago

[●] Fix auth regression      [Running] ⚠ stale
    buildd  ·  running 1h 8m · active 13m ago
```

The "active Ym ago" segment turns amber when `isStaleWorker` returns true.

### Task detail page header

Status chip shows canonical `displayStatus`. Example:
- Task `assigned`, worker `running` → chip shows **Running**
- Task `assigned`, worker `waiting_input` → chip shows **Needs Input**
- Task `completed` → chip shows **Completed**

### Mission timeline rows

Same `deriveDisplayStatus` + `deriveTimestampLabel` — apply when rows are updated to use shared util.

---

## Relationship to review-gate-ux.md

`review-gate-ux.md §8.4` specifies a shared `<StatusChip>` component for blocked/gate states. The timestamp semantics here are **additive** — they extend the chip's secondary metadata (cause text, timestamp) without changing chip label logic. The two specs compose:

- `review-gate-ux.md §8.1` → chip label (Running / Blocked / Done / etc.)  
- This doc → timestamp string beside or below the chip

Implement timestamp semantics before or in parallel with `<StatusChip>` (BT-11 in review-gate-ux.md). They share `deriveDisplayStatus` as the canonical source.
