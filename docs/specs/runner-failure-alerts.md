---
title: Runner Failure Alerts
status: active
owner: max
last_verified: 2026-10-15
summary: Systemic runner failures MUST alert operations only when enabled and MUST never block claiming work.
domain: runners
surfaces: [packages/core/runner-health.ts]
related: [runner-heartbeat, worker-reclamation]
verified_by: [packages/core/__tests__/runner-health.test.ts]
assertions:
  - id: record-runner-outcome
    type: symbol
    name: recordRunnerOutcome
    path: packages/core/runner-health.ts
  - id: guard-1
    type: test_file
    path: packages/core/__tests__/runner-health.test.ts
---
# Runner Failure Alerts

**Capability statement**: Systemic runner failures MUST alert operations only when enabled and MUST never block claiming work.

## Systemic Failure Detection

**Invariants**:
- `recordRunnerOutcome` tracks a consecutive-failure streak in `system_cache`
  key `runner-health:consecutive-failures` (atomic jsonb counter).
- A completed task resets the streak to 0.
- When the streak reaches `RUNNER_HEALTH_FAILURE_THRESHOLD` (default 3), a
  single critical ops alert is fired via `reportOps` with `dedupeKey:
  'runner-health'` — subsequent failures within the dedup window do NOT repeat
  the page.
- The entire subsystem is a no-op when `OPS_ALERTS_ENABLED` is falsy.

**Acceptance criteria**:
- AC-14: GIVEN `OPS_ALERTS_ENABLED = 'true'` WHEN 3 consecutive tasks fail
  THEN `reportOps` is called with `severity: 'critical'` and `source:
  'runner-health'`.
- AC-15: GIVEN a completed task WHEN `recordRunnerOutcome('completed')` runs
  THEN `system_cache` streak resets to 0.
- AC-16: GIVEN `OPS_ALERTS_ENABLED` unset WHEN `recordRunnerOutcome('failed')`
  is called THEN it returns immediately without any DB write.

**Code surface**:
- `packages/core/runner-health.ts` — `recordRunnerOutcome()`
- `STREAK_KEY = 'runner-health:consecutive-failures'`
- `packages/core/report-ops.ts` — `reportOps()`

**Out of scope**: The Pusher-based `WORKER_COMMAND: 'recover'` recovery path
(`attemptStaleRecovery`), which is best-effort and not yet called from a
reliable cron. The runner's own internal health checks (out of process).

**Out of scope**: The sibling contracts linked in the frontmatter.
