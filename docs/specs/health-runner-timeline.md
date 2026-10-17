---
title: Health Runner Timeline
status: active
owner: max
last_verified: 2026-10-17
summary: Health › Runners MUST draw only runs actually going as open-ended, end every other bar at its run's end, and re-render when a worker in its workspaces changes.
domain: surfaces
surfaces: [apps/web/src/lib/fleet-view.ts, apps/web/src/lib/home-fleet.ts, apps/web/src/components/fleet/runner-lanes.tsx, apps/web/src/app/app/(protected)/health/_lib/render-health.tsx]
related: [agent-question-protocol, worker-reclamation, runner-heartbeat]
keywords: [runners and capacity, runner lanes, slot lanes, has a question, phantom duration, open-ended bar, loadRunnersFleet, buildFleetSnapshot]
verified_by: [apps/web/src/lib/fleet-view.test.ts, apps/web/src/lib/sessionless-worker-settle.test.ts, apps/web/src/components/fleet/runner-lanes.test.tsx]
assertions:
  - id: question-session-ended
    type: symbol
    name: questionSessionEnded
    path: packages/shared/src/status.ts
  - id: snapshot-uses-session-rule
    type: symbol_reachable
    symbol: questionSessionEnded
    entry: apps/web/src/lib/fleet-view.ts
  - id: run-end-reason
    type: symbol
    name: runEndReason
    path: apps/web/src/lib/fleet-view-end-reason.ts
  - id: settle-on-cancel
    type: symbol_reachable
    symbol: settleSessionlessWorkersOfTask
    entry: apps/web/src/lib/task-cancel.ts
  - id: runners-page-refreshes
    type: symbol_reachable
    symbol: HomeAutoRefresh
    entry: apps/web/src/app/app/(protected)/health/_lib/render-health.tsx
  - id: fleet-view-tests
    type: test_file
    path: apps/web/src/lib/fleet-view.test.ts
  - id: settle-tests
    type: test_file
    path: apps/web/src/lib/sessionless-worker-settle.test.ts
---

# Health Runner Timeline

## Projection: worker rows to lane bars

**Capability statement**: The Runners & capacity timeline is a projection of
`workers` rows, never a store of its own. A bar is open-ended (`end: null`, drawn
to now, counted live, shown in a slot) only while its run actually holds a
slot; every other run ends where its worker did.

**Invariants**:
- A bar is open-ended exactly when its worker is live and is not a question
  whose session ended (`questionSessionEnded`, `packages/shared/src/status.ts`):
  the same rule the claim route's account cap and `workerHoldsRunnerSlot` use,
  so the timeline and capacity cannot disagree.
- A session-ended question's bar ends at the worker's last write
  (`completedAt`, else `updatedAt`), keeps the waiting tone and reads "Has a
  question"; it does not occupy its slot's live worker or the `live` count. The
  ask itself is on Needs you.
- A worker settled because its task was cancelled or deleted reads "Cancelled
  while waiting for an answer"; one closed by the orphan sweep reads "Question
  closed: the task had ended" (`runEndReason`). Neither reads "Has a question".
- The worker row is history and is kept: a cancelled or deleted task's run stays
  on the timeline, bounded, with its outcome. Rows are not hidden to make a bar
  go away; the canonical state is corrected instead
  (agent-question-protocol AC-53).
- The idle-while-queued shading (`loadQueueHistory`) uses the same end rule for
  its busy intervals.

**Acceptance criteria**:
- AC-1: GIVEN a `waiting_input` worker with the `needs_input:` marker started
  24h ago WHEN the snapshot is built THEN its bar's `end` is its `updatedAt`,
  `live` is 0 and no slot carries it as `worker`.
- AC-2: GIVEN a `waiting_input` worker without the marker (a question inside a
  live session) WHEN the snapshot is built THEN its bar's `end` is null and
  `live` is 1.
- AC-3: GIVEN a worker settled on cancel (`failed`, `exitCause:
  'task_cancelled'`) WHEN its bar is built THEN its outcome is "Cancelled while
  waiting for an answer", never "Has a question" or "Failed".
- AC-4: GIVEN a worker whose task was deleted (`task_id` NULL) WHEN the lanes
  load THEN the row is still drawn, bounded, not dropped.

**Code surface**:
- `buildFleetSnapshot` in `apps/web/src/lib/fleet-view.ts`
- `loadRunnersFleet`, `loadQueueHistory`, `loadFleetSnapshot` in `apps/web/src/lib/home-fleet.ts`
- `runEndReason` in `apps/web/src/lib/fleet-view-end-reason.ts`
- `RunnerLanes` in `apps/web/src/components/fleet/runner-lanes.tsx`

---

## Freshness

**Capability statement**: An open Health › Runners page re-renders when a
worker in its workspaces starts, ends or is settled, not only on reload.

**Invariants**:
- The runners page mounts `HomeAutoRefresh` over the workspaces the lanes read
  (`laneWorkspaceIds`): `worker:failed`, `worker:completed`, `task:*` events
  and status-changing `worker:progress` events trigger a throttled
  `router.refresh()`. Settling a worker publishes `worker:failed` on its
  workspace channel.
- A hidden tab does not refresh; it hands the miss to the shell's freshness
  coordinator, which catches up on return.
- The `?state=` sample fixture does not subscribe.

**Acceptance criteria**:
- AC-5: GIVEN the runners page open WHEN a worker in one of its workspaces is
  settled THEN a `worker:failed` event on that workspace's channel causes one
  throttled re-render.
- AC-6: GIVEN the tab is hidden WHEN such an event arrives THEN no re-render
  happens until the tab returns.
- AC-7: GIVEN the sample fixture (`?state=`) WHEN the page renders THEN no
  channel is subscribed.

**Code surface**:
- `renderHealthPage` in `apps/web/src/app/app/(protected)/health/_lib/render-health.tsx`
- `HomeAutoRefresh` in `apps/web/src/app/app/(protected)/home/HomeAutoRefresh.tsx`
- `settleSessionlessWorkersOfTask` in `apps/web/src/lib/sessionless-worker-settle.ts`

**Out of scope**: The bar geometry and labels (`SlotLanes`), the run detail
panel's copy, and what Needs you shows for a question
(agent-question-protocol).
