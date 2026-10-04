---
title: Task Dispatch Authority
status: active
owner: max
last_verified: 2026-10-04
summary: Every state change that may make a task runnable MUST leave a durable dispatch intent, delivered at least once through one authority, while the claim route stays the only scheduling decision.
domain: tasks
surfaces: [apps/web/src/lib/dispatch-authority.ts, apps/web/src/lib/dispatch-adapters.ts, packages/core/dispatch-outbox.ts, packages/core/drizzle/0231_task_dispatch_outbox_trigger.sql]
related: [webhook-dataflow, mission-task-lifecycle, path-claim-ownership, runner-liveness, external-cron-triggers]
keywords: [task_dispatch_outbox, wakeTask, task:assigned, dispatch-drain, not_before, start_at, outbox, wake, dispatchNewTask, dispatchRetriedTask, dispatch transport, handed_off, dispatch_transport, orphan reconcile, dispatchFallbackAt, callback rate limit]
verified_by: [apps/web/tests/db/dispatch-outbox.test.ts, apps/web/tests/db/reconciliation-disabled.test.ts, apps/web/tests/db/path-release.test.ts, apps/web/tests/db/dependency-wake.test.ts, apps/web/tests/db/retry-wake.test.ts, apps/web/tests/db/start-at-timer.test.ts, apps/web/src/lib/dispatch-authority.test.ts, apps/web/src/lib/task-dispatch-delivery.test.ts, scripts/dispatch-authority-guard.test.ts, apps/web/tests/db/dispatch-handoff.test.ts, apps/web/src/lib/dispatch-resolve.test.ts, apps/web/src/lib/dispatch-transport.test.ts, apps/web/src/app/api/dispatch/v1/resolve/route.test.ts, apps/web/src/app/api/dispatch/v1/receipts/route.test.ts, packages/core/__tests__/dispatch-envelope.test.ts, packages/core/__tests__/dispatch-handoff-render.test.ts, apps/web/tests/db/dispatch-reconcile.test.ts, apps/web/src/lib/dispatch-reconcile.test.ts, apps/web/src/lib/dispatch-callback-auth.test.ts]
supersedes: []
assertions:
  - id: wake-task-symbol
    type: symbol
    name: wakeTask
    path: apps/web/src/lib/dispatch-authority.ts
  - id: deliver-task-dispatch-symbol
    type: symbol
    name: deliverTaskDispatch
    path: apps/web/src/lib/dispatch-authority.ts
  - id: adapter-chains-symbol
    type: symbol
    name: ADAPTER_CHAINS
    path: apps/web/src/lib/dispatch-adapters.ts
  - id: enqueue-dispatch-sql-symbol
    type: symbol
    name: enqueueDispatchSql
    path: packages/core/dispatch-outbox.ts
  - id: with-dispatch-hint-symbol
    type: symbol
    name: withDispatchHint
    path: packages/core/dispatch-outbox.ts
  - id: claim-deferral-waiters-symbol
    type: symbol
    name: registerClaimDeferralWaiters
    path: packages/core/path-claim.ts
  - id: ready-dependents-symbol
    type: symbol
    name: enqueueReadyDependentsSql
    path: packages/core/dispatch-dependents.ts
  - id: reconciliation-disabled-tests
    type: test_file
    path: apps/web/tests/db/reconciliation-disabled.test.ts
  - id: dispatch-outbox-db-tests
    type: test_file
    path: apps/web/tests/db/dispatch-outbox.test.ts
  - id: dispatch-guard-tests
    type: test_file
    path: scripts/dispatch-authority-guard.test.ts
  - id: to-envelope-symbol
    type: symbol
    name: toEnvelope
    path: packages/core/dispatch-envelope.ts
  - id: publish-pending-dispatches-symbol
    type: symbol
    name: publishPendingDispatches
    path: apps/web/src/lib/dispatch-transport.ts
  - id: resolve-dispatch-symbol
    type: symbol
    name: resolveDispatch
    path: apps/web/src/lib/dispatch-resolve.ts
  - id: apply-receipts-sql-symbol
    type: symbol
    name: applyReceiptsSql
    path: packages/core/dispatch-handoff.ts
  - id: dispatch-handoff-db-tests
    type: test_file
    path: apps/web/tests/db/dispatch-handoff.test.ts
  - id: dispatch-resolve-parity-tests
    type: test_file
    path: apps/web/src/lib/dispatch-resolve.test.ts
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
   trigger. No code path can make a task pending without one, save the one
   explicit suppression below.
   The statement making the change can pass a transaction-local hint in the
   same `db.batch` (`withDispatchHint`, migration 0233): a `cause` or
   `metadata` that is on the row from birth (plan children; a task created for
   one local runner), or `suppress` for the claim route's rollback of its own
   claim, which is not new runnable state and would otherwise loop.
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
    that lifts the wall (`budget.available`, `credential.restored`,
    `capacity.freed` — a worker's own terminal transition, for the account's
    `maxConcurrentWorkers` wall a cloud container's claim can be refused for).
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
- AC-24: GIVEN a plan child, or a task created for one local runner, WHEN it
  is inserted THEN its intent carries the plan cause or the target from the
  insert's own transaction, so no drain can deliver it unlabelled; GIVEN the
  claim route rolls back its own claim THEN no intent is written
  (`apps/web/tests/db/dispatch-outbox.test.ts`).
- AC-22: WITH every reconciliation path disabled (no cron, no sweep, no
  backstop, no poll) WHEN a task is created, requeued, released from a path
  claim or has its last dependency resolve THEN the kick alone delivers its
  wake, and not before the blocker clears
  (`apps/web/tests/db/reconciliation-disabled.test.ts`).

---

## Dispatch transport (P0)

An optional second transport moves delivery to a standalone Dispatch
service. It is gated per workspace by `workspaces.dispatch_transport`:
`dispatch` (default), `in_app` (the per-workspace kill switch) or `shadow`.
Postgres stays the source of
truth for intent creation: the outbox row is still written with the state
change. Once Dispatch acks a row of a `dispatch` workspace, Dispatch owns its
delivery lifecycle (when to attempt, retry, collapse, give up). Buildd keeps
the policy: the route at publish time, and the final say at delivery through
signed callbacks. Wire contract: `@buildd/dispatch-contract`.

- **Publish.** `kickDispatch` and the floor tick call
  `publishPendingDispatches` before the in-app drain. It is a no-op unless
  `DISPATCH_URL` and `DISPATCH_PUBLISH_SECRET` are set. It takes pending,
  unacked work rows of `shadow`/`dispatch` workspaces (this task's first,
  then the oldest), stamps `published_at` (a row is not re-sent within
  `PUBLISH_BACKOFF_MS`), and POSTs one signed batch with a 2 s budget. The
  envelope is a pure function of the row (`toEnvelope`), so re-publishing is
  always safe.
- **Route.** `routeFor` uses the in-app chain's own policy: a targeted local
  runner gets only `runner-wake`; otherwise the webhook (`first`, resolve)
  when `webhookWants` would take the cause, GitHub Actions (`also`, resolve)
  for the legacy causes on a first attempt in a linked workspace, and
  `runner-wake` last. Non-work intents are never published. They have no
  adapter, and the in-app drain parks them as `no_adapter` as before.
- **Ack.** One statement per outcome. `accepted`/`duplicate`: a `dispatch`
  row becomes `handed_off` (only from `pending`). A `shadow` row only gains
  `handed_off_at`, and the in-app drain still delivers it. `merged{into}`:
  a `dispatch` row closes as `merged_into_pending` with `merged_into`.
  `rejected` stays pending and is logged.
- **Callbacks** (`/api/dispatch/v1/resolve`, `/api/dispatch/v1/relay`,
  `/api/dispatch/v1/receipts`) are signed with
  `DISPATCH_CALLBACK_SECRET`. Resolve runs the same decision functions as
  the in-app adapters (`claimabilitySkip`, `webhookEligible`,
  `githubActionsWanted`, `webhookPayloadFor`) and returns
  `deliver{payload, grant}`, `decline` or `skip`. A future `start_at` skips,
  as in-app does, because the trigger's `start_at:<ms>` row delivers it at
  that time. A webhook grant is the
  bearer token. A GitHub Actions grant is a repo-scoped installation token
  for `repository_dispatch`. Relay sends the runner wake through
  `sendRunnerWake`: `relay:pusher` when sent, `skipped` when Pusher is
  unconfigured, 502 when Pusher failed so Dispatch retries.
- **Receipts** project onto `handed_off` rows of `dispatch` workspaces:
  `delivered` and `merged` close the row as delivered, `failed` as failed,
  `attempted` moves `attempt_count`/`last_attempt_at` forward. `expired`
  closes as delivered via `expired`, because a wake nobody took is not a
  consumer rejecting wakes. Shadow rows are never changed by receipts.
- **Observability.** `dispatchOutboxHealth` adds `unacked` (pending work
  rows of `dispatch` workspaces with no ack for over a minute) and `orphaned`
  (`handed_off` rows an hour past due). `dispatchHistoryForTask` returns
  `transport` and `handed_off_at`.
- **Orphan reconcile** (`reconcileOrphans`, the hourly floor, after the
  publish sweep and before the drain). Candidates are `handed_off` dispatch
  rows due over `ORPHAN_MIN_AGE_MS` (10 min) ago. The floor asks the Worker
  `GET /v1/intents?scope=buildd:workspace:<id>&ids=…`, one call per workspace
  and at most 100 ids, signed with the publish key over pathname plus search
  as sent. Then, per row:
  - **unknown** to the Worker: re-published with the same envelope. Publish
    is idempotent on id, and the row stays `handed_off`. A `merged` answer
    is projected as a `merged` receipt. A `rejected` one is taken back.
  - **terminal** on the Worker (delivered, skipped, failed, merged,
    expired): the receipt that was lost is rebuilt from the lookup's
    `via`/`why`/`closedAt` (`terminalReceiptFor`) and applied through
    `applyReceiptsSql`, so it stays idempotent.
  - **queued/attempting:** left alone.
  - **taken back** for the in-app drain (`fallBackToInAppSql`): when the
    Worker is unreachable or answers non-2xx (that batch and every later one
    in the run), when the transport is unconfigured, when the workspace is
    no longer on `dispatch`, or when the row is past `ORPHAN_CEILING_MS`
    (1 h) and the Worker has not closed it. The flip sets `status='pending'`,
    `transport='in_app'`, `handed_off_at=NULL` and stamps
    `metadata.dispatchFallbackAt`. A marked row is never published again,
    the publish grace never holds it back, and it is not counted `unacked`.
    So the floor's drain delivers it in the same tick.
  - The run logs one `dispatch_reconcile` line (`checked`, `republished`,
    `projected`, `fellBack`, `left`, `workerErrors`), and the same counts
    appear in the floor result as `repair.reconciled`. The run has a 15 s
    budget; whatever it does not reach waits for the next hour.
- **Callback rate limit.** A verified callback is counted per key id across
  all three routes: `CALLBACK_RATE_LIMIT`, 100 per 10 s fixed window (about
  10 rps) in Redis. Over the limit the route answers 429 with `Retry-After`
  before any database read. The Worker treats a non-2xx as retryable. A
  resolve or relay attempt backs off and counts as an attempt. Receipts stay
  queued in the Worker. The count runs after the signature check, so a
  forger cannot spend a real key's budget. With Redis unconfigured or
  erroring it fails open, with a warning at most once a minute.

Invariants:

15. **No Worker, no change.** With the env unset, nothing is read for
    publishing, nothing is sent, and the drain claims exactly the rows it
    claimed before, with no publish grace, whatever a workspace's transport
    says. A workspace on `in_app` behaves the same with the env set.
16. **One queue per row.** A `handed_off` row is never claimed by the in-app
    drain. An unacked work row of a `dispatch` workspace is left to the
    publish path for `PUBLISH_GRACE_MS` and then taken by the drain as the
    fallback, so the drain is never a racer.
17. **Callbacks fail closed.** An empty `DISPATCH_CALLBACK_SECRET` ring
    answers 503. A missing, stale or wrong signature answers 401. A callback
    acts only on a row in Dispatch's custody (`handed_off`, or a `shadow` row
    with `handed_off_at` that is still pending) whose workspace matches the
    target id.
18. **Grants are never persisted.** A grant is returned in the resolve
    response only. Buildd mints at most one per `(id, attempt, target)` per 5
    minutes (Redis `SET NX`, failing open with a log when Redis is
    unavailable) and never writes one to the database or a log.
19. **Receipts are idempotent.** Re-applying a batch changes nothing.
20. **A handed-off row always reaches a terminal state.** The floor projects
    the Worker's terminal state, re-publishes what it lost, or takes the row
    back for the in-app drain. A row taken back is the drain's for good.
    Taking a row back can duplicate a wake only for a Worker attempt already
    past its resolve/relay callback. Later callbacks find the row out of
    custody and skip, and late receipts change nothing. The claim route
    keeps a duplicate wake to one run.
21. **A callback key cannot keep Neon awake.** Over `CALLBACK_RATE_LIMIT`
    per key id, a callback answers 429 without touching the database.

Acceptance criteria (real SQL in `apps/web/tests/db/dispatch-handoff.test.ts`,
policy in `apps/web/src/lib/dispatch-resolve.test.ts`):

- AC-25: GIVEN a `dispatch` workspace WHEN a publish is accepted THEN the row
  is `handed_off` with `transport = 'dispatch'`. GIVEN a `shadow` workspace
  THEN only `handed_off_at` is set and the row stays pending. GIVEN `merged`
  THEN the row is delivered via `merged_into_pending` with `merged_into`.
- AC-26: A `handed_off` row is never claimed by the in-app drain. An unacked
  `dispatch` row younger than the grace is skipped and an older one is
  claimed. `in_app` and `shadow` rows, and non-work intents, are claimed as
  before.
- AC-27: For every AC-10…AC-18 case, the Dispatch route plus resolve and relay
  reach the same outcome as `deliverTaskDispatch`. The documented
  difference is GitHub Actions after an eligible webhook's failed POST
  (in-app fires it, Dispatch does not).
- AC-28: Callbacks answer 503 with no secret, and 401 on a missing, wrong,
  stale, path-mismatched or body-tampered signature.
- AC-29: Re-applying a receipt batch is a no-op. Shadow rows and unknown ids
  are untouched.
- AC-30: `dispatchOutboxHealth` counts `unacked` and `orphaned`, and
  `dispatchHistoryForTask` returns `transport` and `handed_off_at`.
- AC-31: Orphan candidates are `handed_off` dispatch rows due over 10 min
  ago, flagged past 1 h. Shadow, pending and closed rows are never
  candidates (`apps/web/tests/db/dispatch-reconcile.test.ts`).
- AC-32: GIVEN the Worker does not know a candidate THEN it is re-published,
  or taken back past the ceiling. GIVEN it is terminal THEN its receipt is
  projected, and re-applying it is a no-op. GIVEN it is queued or attempting
  THEN it is left, or taken back past the ceiling. GIVEN the Worker is
  unreachable THEN that batch and every later one are taken back with no
  further calls (`apps/web/src/lib/dispatch-reconcile.test.ts`).
- AC-33: A row taken back is claimed by the next drain even inside the
  publish grace. It is never re-published, never counted `unacked`, out of
  custody, and untouched by a late receipt. A row a receipt closed first is
  not taken back.
- AC-34: A verified callback over the per-key limit answers 429 with
  `Retry-After` and projects nothing. A forged one is refused before the
  counter. Redis unavailable fails open
  (`apps/web/src/lib/dispatch-callback-auth.test.ts`). The Worker keeps
  receipts queued on a 429 (`apps/dispatch/src/engine.test.ts`).

---

## Code surface

- Outbox storage and SQL: `packages/core/dispatch-outbox.ts` —
  `DISPATCH_CAUSES`, `enqueueDispatchSql`, `outboxInsertSelectSql`,
  `claimDueDispatchesSql`, `markDispatchFailed`; table `taskDispatchOutbox` in
  `packages/core/db/schema.ts`.
- Trigger: `packages/core/drizzle/0231_task_dispatch_outbox_trigger.sql`.
- Authority: `apps/web/src/lib/dispatch-authority.ts` — `wakeTask`,
  `wakeTasks`, `announceTaskCreated`, `kickDispatch`, `drainDispatchOutbox`,
  `deliverTaskDispatch`. `primaryCause` lives in
  `packages/core/dispatch-outbox.ts`, re-exported here.
- Dispatch transport: `packages/core/dispatch-envelope.ts` (`toEnvelope`,
  target ids), `packages/core/dispatch-handoff.ts` (publish selection, acks,
  custody, `applyReceiptsSql`), `apps/web/src/lib/dispatch-transport.ts`
  (`routeFor`, `publishPendingDispatches`, `republishDispatches`,
  `lookupIntents`), `apps/web/src/lib/dispatch-reconcile.ts`
  (`reconcileOrphans`, `planReconcile`),
  `apps/web/src/lib/dispatch-resolve.ts` (`resolveDispatch`,
  `relayDispatch`), `apps/web/src/lib/dispatch-callback-auth.ts`, routes
  under `apps/web/src/app/api/dispatch/v1/`, wire contract
  `packages/dispatch-contract/`.
- Destination adapters: `apps/web/src/lib/dispatch-adapters.ts` —
  `ADAPTER_CHAINS`, `TASK_WAKE_ADAPTERS`, `routeForCause`, `webhookWants`.
  Non-work intents are recorded with `dispatchIntent` (dispatch-authority.ts).
- Timer and repair cron: `apps/web/src/app/api/cron/dispatch-drain/route.ts`,
  `apps/web/src/lib/dispatch-repair.ts`.
- Path release and claim-time waiters: `packages/core/path-claim.ts` —
  `registerClaimDeferralWaiters`, `releaseClaims`, `narrowPathClaims`.
- Dependents: `packages/core/dispatch-dependents.ts` —
  `enqueueReadyDependentsSql`, `findPendingTasksWithResolvedDepsAndNoWake`,
  both evaluating the claim route's own `depsGate()` (passed in), never a copy.
- Trigger hints: `packages/core/drizzle/0233_task_dispatch_trigger_hints.sql`,
  `withDispatchHint` / `dispatchHintSql` in dispatch-outbox.ts.
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
