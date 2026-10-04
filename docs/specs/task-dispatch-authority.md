---
title: Task Dispatch Authority
status: active
owner: max
last_verified: 2026-10-03
summary: Every state change that may make a task runnable MUST leave a durable dispatch intent, delivered at least once through one authority, while the claim route stays the only scheduling decision.
domain: tasks
surfaces: [apps/web/src/lib/dispatch-authority.ts, apps/web/src/lib/dispatch-adapters.ts, packages/core/dispatch-outbox.ts, packages/core/drizzle/0231_task_dispatch_outbox_trigger.sql]
related: [webhook-dataflow, mission-task-lifecycle, path-claim-ownership, runner-liveness, external-cron-triggers]
keywords: [task_dispatch_outbox, wakeTask, task:assigned, dispatch-drain, not_before, start_at, outbox, wake, dispatchNewTask, dispatchRetriedTask]
verified_by: [apps/web/tests/db/dispatch-outbox.test.ts, apps/web/tests/db/reconciliation-disabled.test.ts, apps/web/tests/db/path-release.test.ts, apps/web/tests/db/dependency-wake.test.ts, apps/web/tests/db/retry-wake.test.ts, apps/web/tests/db/start-at-timer.test.ts, apps/web/src/lib/dispatch-authority.test.ts, apps/web/src/lib/task-dispatch-delivery.test.ts, scripts/dispatch-authority-guard.test.ts]
supersedes: []
---
# Task Dispatch Authority

**Capability statement**: When a write may make a task runnable, the system
MUST record why in `task_dispatch_outbox` as part of that write, and the
dispatch authority MUST turn that intent into a wake for the task's consumers
(workspace webhook, GitHub Actions, Pusher-connected runners). A wake means
"re-evaluate this task now". It never assigns the task: the claim route decides.

State changes create work; time does not. Cron repairs; it does not drive
normal execution.

---

## Invariants

1. **Trigger for pending.** Every transition into `pending` (insert, a status
   change into `pending`, a `start_at` change while `pending`) writes an outbox
   row in the same transaction, via the `task_dispatch_outbox_on_pending`
   trigger. No code path can make a task pending without one.
2. **Explicit enqueue for unblocks.** A transition that keeps a task `pending`
   but makes it runnable (a dependency resolving, a path claim releasing, a
   mission released, a budget or credential restored) MUST enqueue in the same
   statement or `db.batch` as the mutation (`enqueueDispatchSql`,
   `outboxInsertSelectSql`), or call `wakeTask` once the write has committed.
3. **Closed cause vocabulary.** Every row carries a cause from
   `DISPATCH_CAUSES`. Pending rows for one task and one due time coalesce:
   later causes append to `causes`, the earliest due time is kept, and
   `primaryCause` picks the most specific cause for delivery.
4. **At-least-once delivery, exactly-once claim.** `claimDueDispatchesSql`
   takes a row once per lease (`DELIVERY_LEASE_MS`). A consumer that dies
   mid-delivery leaves the row to be retaken. A failed delivery backs off
   (`retryDelayMs`) and parks as `failed` after `MAX_DELIVERY_ATTEMPTS`. A
   duplicate wake is harmless because the claim is the exactly-once step.
5. **The claim route is the only scheduling authority.** Delivery applies no
   claim gate (dependencies, path overlap, provider capacity, Codex
   single-flight, budgets). Its filters only decide which consumer is worth a
   cold start, and a skipped row is marked delivered, never re-assigned.
6. **One sender.** The dispatch authority's runner adapters
   (`dispatch-adapters.ts`) are the only code that sends the
   `TASK_ASSIGNED` Pusher event. Call sites call `wakeTask(taskId, cause)`, and
   the dashboard-only `TASK_CREATED` event goes through `announceTaskCreated`.
   Runners listen for the event; they do not send it.
7. **Durable scheduled wakes.** A future `start_at` becomes the row's
   `not_before`, keyed on the due time so an immediate wake does not absorb it.
   The drain publishes future due times to the Redis due-queue
   (`DISPATCH_DUE_QUEUE`), and the dispatch-drain cron tick touches Postgres
   only when something is due. A task is not delivered before its `start_at`.
8. **Kick, don't wait.** `wakeTask` and `kickDispatch` drain due rows right
   after the response (`after()`), or detached outside a request scope. Neither
   throws to its caller: the intent is already durable, so a failed kick only
   delays delivery to the next tick.
9. **Webhook/Pusher parity.** Every cause produces a wake on every substrate.
   A webhook that takes the task is the exclusive consumer. If it declines,
   fails or times out, the Pusher broadcast goes out. A webhook with no
   `events` list receives only the causes it received before the outbox
   existed (`routeForCause(...).legacyDefault`). One with a list receives
   exactly the events it lists.
10. **Runner substrate is orthogonal to backend.** The wake payload names the
    task's `backend` and its delivery `dispatch` (outbox id and cause). Which
    runner hears it depends on the workspace's consumers, never on the
    backend.
11. **Provider capacity is not runner slots.** Delivery does not consult
    provider walls, concurrency or budgets. A wake for a walled backend is
    refused by the claim route, and the re-wake comes from the state change
    that lifts the wall (`budget.available`, `credential.restored`).
12. **Reconciliation is a backstop.** The `dispatch-drain` floor tick (start_at
    backfill, the dependency backstop, timer reseed, outbox health), the
    path-claims sweep and stale-worker requeue repair missed state. They never
    drive normal execution, and a wake they send goes through the same outbox.
13. **Durable dispatch does not imply autonomous execution.** A dispatch means
    "this work should now be reconsidered or delivered", not "start an agent".
    The dispatcher hands each due intent — stable id, primary cause, cause
    trail, delivery hints, the task it names — to an ordered chain of
    destination adapters and owns no destination policy itself. Delivery
    target and execution mode are policy in the adapters, above the
    substrate. Today's chain wakes autonomous runners; another destination
    (an interactive session, an external work system) is a new adapter, and
    its business semantics stay inside it.
14. **Typed intents.** Every row carries an `intent` (`DISPATCH_INTENTS`:
    `work_execution`, `human_action`, `notification`, `incident`,
    `external_work`) that selects its adapter chain (`ADAPTER_CHAINS`). Buildd's
    policy decides what should happen and writes the intent; dispatch only
    delivers it. Only `work_execution` reaches runners, and only it is written
    by the trigger. Other kinds are namespaced in `dedupe_key`, so they never
    coalesce with a runner wake. A kind with no registered adapter is parked
    as `failed` at once (`no_adapter:<intent>`), never silently closed.
    Promoting work into an external tracker is that adapter's policy; the
    dispatcher never mirrors internal tasks or small human actions into one.

---

## Delivery policy

`deliverTaskDispatch` re-reads the task and offers the intent to
`TASK_WAKE_ADAPTERS` (`apps/web/src/lib/dispatch-adapters.ts`) in order. An
adapter delivers (ends the chain), skips (closes the intent, nothing sent) or
declines (passes it on); a throw leaves it for retry, and a chain nobody takes
closes as `skipped:no_destination`. The runner chain today:

1. Task gone → `skipped:task_gone`. Not `pending` → `skipped:status_<status>`.
   Future `start_at` → `skipped:start_at_future`.
2. A `targetLocalUiUrl` hint (manual start on a chosen runner) → only a
   targeted `TASK_ASSIGNED`. No webhook, no GitHub Actions.
3. Workspace webhook, when `webhookWants` passes: enabled with a url,
   subscribed (see invariant 9), `runnerPreference` matches, `start_at` not
   in the future, and `isTaskNotHeldOrLocal`. The held gate is asked only
   after the other checks pass, and a gate error keeps the task off the
   webhook. The body is `buildWebhookPayload` plus `cause` and `dispatchId`.
4. GitHub Actions repository_dispatch, only for `routeForCause(...).githubActions`
   causes, as a supplement.
5. Pusher `TASK_ASSIGNED` broadcast with `targetLocalUiUrl: null`.

Pusher `failed` throws, so the row retries. Pusher `unconfigured` counts as
delivered (`pusher:unconfigured`).

| Cause | Webhook event | Legacy webhook (no `events`) | GitHub Actions |
|---|---|---|---|
| task.created, review.fix_requested, ci.retry, conflict.retry | task.created | yes | yes |
| plan_child.ready | task.created | no | no |
| dependency.satisfied | task.unblocked | yes, runnerPreference unfiltered | yes |
| manual.start | task.retry | yes, runnerPreference unfiltered | yes |
| path_claim.released, budget.available, credential.restored, mission.released, task.unblocked, start_at.reached | task.unblocked | no | no |
| task.requeued, task.reassigned | task.retry | no | no |

The "unfiltered" quirk is how the pre-outbox unblock path behaved for a
legacy webhook. It is kept so an existing consumer sees no change.

---

## Acceptance criteria

Real-SQL criteria are asserted in `apps/web/tests/db/dispatch-outbox.test.ts`
(run with `bun run test:db`); delivery policy in
`apps/web/src/lib/dispatch-authority.test.ts`.

- AC-1: WHEN a task is inserted as `pending` THEN exactly one immediate outbox
  row with cause `task.created` exists for it. (db: "creating a pending task
  writes one immediate intent…")
- AC-2: WHEN a task is inserted in another status THEN no row exists until it
  becomes `pending`. (db: "a task created in another status…")
- AC-3: GIVEN an undelivered wake WHEN the task is requeued THEN the requeue
  coalesces into the existing row. GIVEN a delivered wake THEN it gets its own
  row. (db: "a requeue while…", "a requeue after…")
- AC-4: WHEN a pending task is updated without a status or `start_at` change
  THEN no row is written. (db: "an unrelated update…")
- AC-5: WHEN `start_at` is set in the future THEN the row's `not_before`
  equals it, the row is not claimable before then, and it is claimable once due
  with no reconciliation pass. (db: "scheduled wakes (startAt)")
- AC-6: WHEN `start_at` moves THEN a new scheduled row is written, and an
  immediate wake does not absorb it. (db: "moving startAt…")
- AC-7: WHEN an app cause is enqueued for a task with a pending trigger row
  THEN it appends to that row's `causes`. WHEN the task does not exist THEN
  nothing is inserted and nothing throws. (db: "explicit enqueue")
- AC-8: WHEN two drains run concurrently THEN they take disjoint rows. A
  delivered row is never taken again. A row left `delivering` past its lease
  is retaken. (db: "claim: at-least-once…")
- AC-9: WHEN delivery fails THEN the row backs off and retries, parks as
  `failed` after the attempt limit, and folds into a newer pending row rather
  than violating the dedupe index. (db: "a failed delivery…")
- AC-10: GIVEN a webhook with no `events` list WHEN any cause is delivered
  THEN the webhook is POSTed only for task.created, review.fix_requested,
  ci.retry, conflict.retry, dependency.satisfied and manual.start, and every
  other cause goes out over the Pusher broadcast. (unit: "a legacy webhook…")
- AC-11: GIVEN a webhook that lists events WHEN a cause routes to an event it
  lists THEN the webhook is POSTed with that event. WHEN it does not THEN
  nothing is POSTed and Pusher broadcasts. (unit: "an opted-in webhook…")
- AC-12: GIVEN `webhookConfig.runnerPreference = 'service'` and a task with
  `runnerPreference = 'user'` THEN no cause reaches the webhook, except
  dependency.satisfied and manual.start on a webhook with no `events` list.
- AC-13: GIVEN a held task, a held or local-executor mission, or a held gate
  that throws THEN the webhook is not POSTed and Pusher broadcasts. GIVEN the
  webhook is ruled out by policy THEN the held gate is not queried.
- AC-14: GIVEN the webhook returns non-2xx or times out THEN the Pusher
  broadcast is sent and the row is marked delivered via `pusher`.
- AC-15: GIVEN a delivery hint `targetLocalUiUrl` THEN exactly one targeted
  `TASK_ASSIGNED` is sent, with no webhook and no GitHub Actions run.
- AC-16: WHEN Pusher reports `failed` THEN delivery throws and the drain calls
  `markDispatchFailed` with the row's attempt count. WHEN Pusher is
  unconfigured THEN the row counts as delivered.
- AC-17: WHEN a wake is delivered THEN the Pusher task payload carries
  `dispatch: { id, cause }` and no description, and the webhook body carries
  `cause` and `dispatchId`.
- AC-18: GIVEN the task is no longer `pending` THEN delivery returns
  `skipped:status_<status>` and sends nothing.
- AC-19: WHEN `kickDispatch` runs outside a request scope THEN it drains
  immediately, and inside one it defers to `after()`. In neither case does it
  throw.
- AC-20: WHEN any non-test source file other than the runner adapters (and
  the event-name definition) names the `TASK_ASSIGNED` event THEN
  `scripts/dispatch-authority-guard.test.ts` fails.
- AC-21: GIVEN an adapter chain with a non-runner destination WHEN an intent
  is delivered THEN that destination receives the stable context and no
  runner, webhook or GitHub Actions dispatch fires; "only pending tasks" is
  enforced by the runner chain's `runnerClaimability`, not by the dispatcher
  (`apps/web/src/lib/dispatch-authority.test.ts`).
- AC-23: GIVEN an intent other than `work_execution` WHEN it is delivered
  THEN no runner, webhook or GitHub Actions dispatch fires; with no adapter
  registered for its kind it is parked as failed in one attempt; a
  `human_action` and a runner wake for the same task stay separate rows
  (`apps/web/src/lib/dispatch-authority.test.ts`,
  `apps/web/tests/db/dispatch-outbox.test.ts`).
- AC-22: WITH every reconciliation path disabled (no cron, no sweep, no
  backstop, no poll) WHEN a task is created, requeued, released from a path
  claim or has its last dependency resolve THEN the kick alone delivers its
  wake, and not before the blocker clears
  (`apps/web/tests/db/reconciliation-disabled.test.ts`).

---

## Code surface

- Outbox storage and SQL: `packages/core/dispatch-outbox.ts` —
  `DISPATCH_CAUSES`, `enqueueDispatchSql`, `outboxInsertSelectSql`,
  `claimDueDispatchesSql`, `markDispatchFailed`; table `taskDispatchOutbox` in
  `packages/core/db/schema.ts`.
- Trigger: `packages/core/drizzle/0231_task_dispatch_outbox_trigger.sql`.
- Authority: `apps/web/src/lib/dispatch-authority.ts` — `wakeTask`,
  `wakeTasks`, `announceTaskCreated`, `kickDispatch`, `drainDispatchOutbox`,
  `deliverTaskDispatch`, `primaryCause`.
- Destination adapters: `apps/web/src/lib/dispatch-adapters.ts` —
  `ADAPTER_CHAINS`, `TASK_WAKE_ADAPTERS`, `routeForCause`, `webhookWants`.
  Non-work intents are recorded with `dispatchIntent` (dispatch-authority.ts).
- Timer and repair cron: `apps/web/src/app/api/cron/dispatch-drain/route.ts`,
  `apps/web/src/lib/dispatch-repair.ts`.
- Path release and claim-time waiters: `packages/core/path-claim.ts` —
  `registerClaimDeferralWaiters`, `releaseClaims`, `narrowPathClaims`.
- Dependents: `packages/core/dispatch-dependents.ts` —
  `enqueueReadyDependentsSql`, `findPendingTasksWithResolvedDepsAndNoWake`.
- Delivery primitives: `apps/web/src/lib/task-dispatch-delivery.ts` —
  `buildWebhookPayload`, `dispatchToWebhook`, `buildTaskPayload`,
  `dispatchResumedTask` (a worker resume, not a task wake).
- Held gate: `apps/web/src/app/api/workers/claim/held-gate.ts` —
  `isTaskNotHeldOrLocal`.
- Claim route: `apps/web/src/app/api/workers/claim/route.ts`.
- Timer index: `apps/web/src/lib/cron-due-queue.ts`, `DISPATCH_DUE_QUEUE`.

---

## Out of scope

- Which task a runner gets, and whether it may run: the claim route and its
  gates.
- Worker-level resumes (`task.resume`), which wake a live worker and do not go
  through the outbox. See webhook-dataflow.
- Dashboard realtime events (TASK_UPDATED, TASK_UNBLOCKED, path claim
  releases). They are UI and agent signals, not wakes.
