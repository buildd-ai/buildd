---
title: PR Lifecycle Reconciliation
status: active
owner: max
last_verified: 2026-09-01
summary: The PR lifecycle status shown on every surface MUST reflect live GitHub CI state within one read cycle, with terminal states (merged/closed) never overwritten by later CI events.
domain: tasks
surfaces: [apps/web/src/lib/pr-state-refresh.ts, apps/web/src/lib/pr-presentation.ts, apps/web/src/app/api/github/webhook/route.ts, apps/web/src/components/TaskCard.tsx]
related: [runner-liveness, mission-task-lifecycle]
keywords: [ci, prLifecycleStatus, ci_green, ci_failed, ci_running, webhook, reconcile]
verified_by: [apps/web/src/lib/pr-state-refresh.test.ts, apps/web/src/lib/pr-presentation.test.ts, apps/web/src/app/api/github/webhook/route.test.ts]
supersedes: []
---

## Invariants

### I-1: All CI states render as CI badges

Every `prLifecycleStatus` value in the CI set (`ci_running`, `ci_failed`, `ci_green`) MUST have an entry in every `PR_LIFECYCLE` map. No CI state may fall through to the `Open` fallback. Code surfaces: `pr-presentation.ts#PR_LIFECYCLE` and `TaskCard.tsx#PR_LIFECYCLE`.

### I-2: Terminal state wins

`merged` and `closed` are terminal. Any webhook event writing a CI state (`ci_running`, `ci_failed`, `ci_green`) MUST check `prLifecycleStatus` first and skip the write if the current value is terminal. This prevents late-arriving `check_suite.failure` webhooks from overwriting an already-merged PR's badge.

### I-3: Live CI reconciliation

`pr-state-refresh.ts` MUST fetch live CI state (via `fetchCiLifecycleStatus` → `/commits/{sha}/check-suites`) for every open-PR worker whose `prLifecycleStatus` is in `{ci_running, ci_failed, ci_green}` and whose `prLastCheckedAt` is stale (≥5 min). The resolved value is written only when it differs from the stored value.

### I-4: Terminal task guard

`handleCheckSuiteFailure` in `webhook/route.ts` MUST skip CI retry dispatch for any task whose `status` is in `{completed, failed, cancelled}`. Failing CI on a terminal task's PR MUST notify the mission feed if a `missionId` is set, then continue — no retry child task is created.

## CI state vocabulary

| Value | Meaning |
|---|---|
| `pr_open` | PR opened; CI not yet started |
| `ci_running` | At least one check suite in progress |
| `ci_failed` | All suites completed; at least one failed |
| `ci_green` | All suites completed; all passed (success/skipped/neutral) |
| `merged` | Terminal: PR merged |
| `closed` | Terminal: PR closed without merge |
| `conflict` | Reserved: merge conflict detected |

## Reconciliation surfaces

Two surfaces reconcile stale `prLifecycleStatus`:

| Surface | File | Trigger | Corrects |
|---|---|---|---|
| Read-through refresh | `pr-state-refresh.ts` | Per-render, 5-min cache | merge, close, CI state transitions |
| Daily cron | `pr-reconcile.ts` + `/api/cron/pr-reconcile` | Daily | merge, close only |

The read-through refresh is the primary real-time correction path.
