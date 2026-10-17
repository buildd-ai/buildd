---
title: Runner Liveness
status: superseded
owner: max
last_verified: 2026-10-15
summary: The coordination layer MUST detect a runner or worker that has gone silent, reclaim or permanently fail its task, and alert ops on systematic failure without ever blocking the claim path.
domain: runners
surfaces: [apps/web/src/lib/stale-workers.ts, apps/web/src/lib/lost-claim.ts, apps/runner/src/claim-handoff.ts, apps/web/src/app/api/workers/heartbeat/route.ts, apps/web/src/app/api/version/route.ts, packages/core/runner-health.ts]
related: [runner-heartbeat, worker-reclamation, runner-failure-alerts]
keywords: [worker_heartbeats, heartbeat_stale_ms, cleanupstaleworkers, waiting_input timeout, buildd_runner_poll_min, viewertoken, runner_commit, runner_version, deployed build sha, current_commit, disk_commit, commit_drift, update_available, update_available_since, tracked_branch, uptodatewithdeployed, list_runners]
assertions:
  - id: heartbeat-route
    type: route
    method: POST
    path: /api/workers/heartbeat
    file: apps/web/src/app/api/workers/heartbeat/route.ts
  - id: cleanup-stale-workers
    type: symbol
    name: cleanupStaleWorkers
    path: apps/web/src/lib/stale-workers.ts
  - id: cleanup-stuck-waiting-input
    type: symbol
    name: cleanupStuckWaitingInput
    path: apps/web/src/lib/stale-workers.ts
  - id: release-unacknowledged-claims
    type: symbol
    name: releaseUnacknowledgedClaims
    path: apps/web/src/lib/lost-claim.ts
  - id: record-runner-outcome
    type: symbol
    name: recordRunnerOutcome
    path: packages/core/runner-health.ts
  - id: version-route
    type: route
    method: GET
    path: /api/version
    file: apps/web/src/app/api/version/route.ts
  - id: active-workers-route
    type: route
    method: GET
    path: /api/workers/active
    file: apps/web/src/app/api/workers/active/route.ts
supersedes: []
superseded_by: runner-heartbeat
---
# Contract map

The contract is split by capability. Existing criterion ids are preserved in
their owning child; links to this former aggregate resolve through this map.

- [runner-heartbeat](runner-heartbeat.md)
- [worker-reclamation](worker-reclamation.md)
- [runner-failure-alerts](runner-failure-alerts.md)
