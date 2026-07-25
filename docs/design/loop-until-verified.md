# Condition-Driven Task Loops

**Status:** Proposed
**Related:** `docs/design/retry-continuity.md`,
`docs/design/worker-pr-automerge.md`, `packages/core/db/schema.ts`,
`packages/shared/src/types.ts`, `apps/web/src/app/api/workers/[id]/route.ts`,
`apps/web/src/app/api/workers/claim/route.ts`,
`apps/web/src/app/api/workers/claim/deps-gate.ts`,
`apps/web/src/app/api/github/webhook/route.ts`,
`apps/web/src/lib/stale-workers.ts`,
[PR #1408](https://github.com/buildd-ai/buildd/pull/1408)

## Problem

A worker can call `complete_task` while its objective is still mechanically
false: tests fail, a required structured value is absent, or the PR's checks
are not green. `context.verificationCommand` is currently advisory, so a
completion can become terminal even when its stated verification fails.
Planners must then notice the mismatch and create an ad hoc retry.

Treating this mismatch as a normal failure would repeat the false-failure bug
addressed by the worker `exitCause` taxonomy: an expected control-flow outcome
would consume failure retries, distort failure metrics, and lose continuity.
Unbounded automatic retries would be worse. The system needs an opt-in,
bounded loop whose condition is authoritative and whose iterations preserve the
same task and git branch.

## Current state

- Tasks have no loop columns. Retry metadata and `verificationCommand` live in
  `tasks.context`; worker outcomes live in `workers.exitCause`.
- `apps/web/src/app/api/workers/[id]/route.ts` is the authoritative worker
  terminal-update path. Budget-limited exits already requeue without becoming
  code failures.
- Retry continuity records `resumeBranch`, `lastCommitSha`, and structured
  `failureContext`; the runner resumes the previous branch.
- PR #1408 introduces persisted `tasks.startAt` floors and enforces them in the
  atomic claim query, so delayed dispatch cannot be bypassed by a Pusher event.
  This proposal treats that PR as a prerequisite rather than duplicating its
  deferred-start machinery.
- `apps/web/src/app/api/github/webhook/route.ts` persists PR lifecycle state from
  `pull_request` and `check_suite` events. The CI topology recon in
  `docs/design/worker-pr-automerge.md` found `check_suite.completed` to be the
  general worker-PR authority; mission heartbeats and stale cleanup are not.
- The dependency gate requires a dependency task to complete and its worker PR
  to merge. A closed, unmerged PR is not equivalent to a merged PR.

## Proposal

The crux is that the dispatcher inside the worker completion route is the
**only state-transition authority** for loop evaluation. It consumes runner
evidence and persisted webhook state, then atomically chooses satisfied,
requeued, or exhausted.
Cleanup cron may recover abandoned evaluations, but may never evaluate a
condition. If both paths could evaluate, duplicate webhook/cleanup deliveries
could increment the loop twice and dispatch two workers.

### 1. Data model

Add these nullable/defaulted fields to `tasks`:

```ts
type LoopConfig = {
  exitCondition:
    | { type: 'command'; command?: string }
    | { type: 'pr_checks_green' }
    | {
        type: 'structured_predicate';
        predicate?: {
          path: string; // JSON Pointer into TaskResult.structuredOutput
          operator: 'eq' | 'neq' | 'exists' | 'gt' | 'gte' | 'lt' | 'lte';
          value?: string | number | boolean | null;
        };
      };
  maxLoops?: number;       // normalized to 5
  backoffMinutes?: number; // normalized to 0
};

loopConfig: LoopConfig | null; // jsonb
loopIteration: number;         // integer, default 0, not null
loopState:
  | 'running'
  | 'condition_unmet'
  | 'exhausted'
  | 'satisfied'
  | null;                      // null when loopConfig is null
```

Validation rules:

- `maxLoops` is an integer from 1 through 50; omitted means 5.
- `backoffMinutes` is an integer from 0 through 10,080; omitted means 0.
- `command` is required and nonblank for `command`, unless the task context has
  a nonblank `verificationCommand`; conflicting values are rejected.
- `predicate` is required for `structured_predicate`. Its path and operator are
  declarative; arbitrary code is not accepted.
- `pr_checks_green` requires a worker PR before it can be satisfied.
- `loopConfig` is immutable after the first worker claim. Explicit task reset
  clears `loopIteration`, `loopState`, and loop history.

`loopIteration` counts completed condition evaluations, not failure attempts.
Before the first run it is `0`; the running chip displays attempt
`loopIteration + 1`. `maxLoops` therefore bounds both agent runs and condition
evaluations.

Each evaluation also appends a bounded entry to
`tasks.context.loopHistory`:

```ts
type LoopHistoryEntry = {
  iteration: number;
  workerId: string;
  evaluatedAt: string;
  conditionType: LoopConfig['exitCondition']['type'];
  satisfied: boolean;
  summary: string;
  evidence?: Record<string, unknown>;
};
```

The array cannot exceed normalized `maxLoops`; command stdout/stderr is
truncated and secrets are redacted before persistence. A dedicated column is
unnecessary because history is bounded, task-scoped diagnostic context.

### 2. Authoritative evaluation protocol

For looped tasks, the runner executes the configured command in the task
worktree after the agent finishes and includes signed-to-the-worker completion
evidence in its terminal request: command, exit code, duration, and truncated
output. The web service does not execute repository code. The completion route
rejects missing or mismatched command evidence instead of trusting an agent's
summary.

The completion route evaluates:

- `command`: exit code `0` is satisfied; any other code is unmet. With a loop,
  `verificationCommand` is promoted from advisory prompt context to the
  authoritative command. Without a loop it remains advisory.
- `structured_predicate`: apply the validated operator to
  `TaskResult.structuredOutput` using the JSON Pointer. Missing output is unmet,
  never an evaluation error.
- `pr_checks_green`: read the completing worker's `prNumber`,
  `prLifecycleStatus`, and head SHA state maintained by the pull-request and
  `check_suite` webhook paths. Only the current head with all known suites
  terminal and successful is satisfied. `pr_open`, `ci_running`, `ci_failed`,
  `conflict`, `closed`, missing PR data, or a stale head is unmet. Do not poll
  GitHub or infer green from task completion.

The webhook remains the CI fact producer, but never changes loop counters. If
checks are still running, the next loop is deferred using at least the configured
backoff so webhook state has time to settle.

### 3. State machine

All task, worker, history, and counter changes use one conditional database
update guarded by task id, current worker id, and `loopState = 'running'`.
Neon HTTP does not support interactive transactions, so losing evaluators
return the already-written result.

```text
claim iteration N
  -> task in_progress, loopState running
worker completion
  -> evaluate exactly once; write history entry N + 1
  -> condition met
       task completed, loopIteration N + 1, loopState satisfied
  -> condition unmet and N + 1 < maxLoops
       worker completed with exitCause condition_unmet
       task pending, loopIteration N + 1, loopState condition_unmet
       failureContext = structured condition output
       resume same branch; optional startAt backoff
  -> condition unmet and N + 1 = maxLoops
       worker completed with exitCause condition_unmet
       task failed, loopIteration N + 1, loopState exhausted
       result includes the complete bounded loop history
```

Extend `workers.exitCause` with `condition_unmet`. It is expected control flow:
it is not `code_failure`, does not consume retry attempts, does not trigger the
mission failure retrigger, and does not count in failure analytics. The task is
failed only at exhaustion; that terminal failure is attributed to the exhausted
loop, not retroactively to its workers.

On unmet, write a structured `context.failureContext` containing condition type,
summary, exit code or predicate observation, iteration, branch, and commit SHA.
Set `context.resumeBranch` and `context.lastCommitSha` from the worker. The next
claim uses the retry-continuity prompt and **the same remote branch**, preserving
the PR and accumulated commits. No child retry task is created.

When requeued, `loopState` remains `condition_unmet` while waiting and changes
to `running` only in the atomic claim. This distinguishes a healthy between-
iterations task from an active worker.

### 4. Scheduling and cleanup interactions

For an unmet condition, compute:

```text
loopFloor = evaluatedAt + backoffMinutes
effective startAt = max(existing future startAt, loopFloor, budget reset floor)
```

After prerequisite PR #1408 lands, both loop backoff and `budget_limited` use
the same `startAt` primitive.
They compose as floors; neither clears or shortens the other. A budget-limited
worker does not evaluate the loop, increment `loopIteration`, or add history.
It requeues the same iteration and preserves the later `startAt`.

Stale-worker cleanup operates only on an actual nonterminal worker. A task with
`loopState = 'condition_unmet'`, `status = 'pending'`, and a future `startAt`
has no stalled worker and must be excluded from stale-task failure/retry counts.
Cleanup may reset a task stuck in `running` after its worker is independently
classified stale, but it leaves the iteration unchanged so a replacement can
perform that iteration.

### 5. Dependency semantics

A dependency is released only when both are true:

1. the dependency task is `completed` with either no loop or
   `loopState = 'satisfied'`; and
2. every deliverable PR required by the existing dependency gate has
   `mergedAt` set.

`condition_unmet`, `running`, and `exhausted` never release dependants.
For tasks without a PR requirement, condition satisfaction is sufficient.
Force/bypass behavior remains the existing explicit user override; loop
processing does not set it.

### 6. UI contract

- Active and deferred looped tasks show `LOOPING · attempt N/M`, where
  `N = min(loopIteration + 1, maxLoops)`.
- A condition-unmet requeue keeps the chip visible and may add
  `resumes <relative time>` from `startAt`.
- Each history entry renders as a task timeline event with iteration, condition,
  met/unmet result, timestamp, worker, and a collapsed evidence excerpt.
- Task detail shows a Loop history section for all looped tasks, including
  satisfied and exhausted terminal tasks. Exhaustion is a failed state with
  “condition unmet after M attempts,” not M separate worker failures.
- Pusher task updates carry `loopIteration`, `loopState`, and normalized
  `maxLoops` so list and detail views agree without client-side inference.

### 7. Migration and rollout

1. Add the four task columns and extend shared/API types and
   `workers.exitCause`; generate and commit the Drizzle migration.
2. Add create/update validation. Existing APIs omit `loopConfig` by default.
3. Add runner command evidence, then the guarded completion evaluator.
4. Update claim, cleanup, mission retry accounting, dependency gates, events,
   and UI.
5. Enable loop creation only after all readers tolerate the new fields.

Migration defaults are `loopConfig = null`, `loopIteration = 0`, and
`loopState = null`. There is no backfill. Tasks without `loopConfig` bypass
every loop branch and behave exactly as today, including advisory
`verificationCommand`, retries, completion, dependency gating, and UI.

## Safety properties

- Opt-in only: a null `loopConfig` is a complete no-op.
- Bounded: at most 50 iterations, default 5.
- Exactly once: only the guarded completion path increments an iteration.
- Spend-aware: budget pauses do not consume iterations; all deferrals compose.
- Continuity-preserving: unmet conditions resume the same branch and PR.
- Auditable: every evaluation produces one bounded history entry.

## Open questions

None. Command authority, structured predicate vocabulary, CI source of truth,
counter semantics, deferral precedence, and dependency release are specified
above. Future predicate operators require a versioned schema extension.

## Non-goals

- In-session agent self-review loops; each iteration is a fresh worker session.
- Arbitrary scripts inside structured predicates.
- Replacing GitHub webhooks with polling.
- General DAG cycles or creating a child task per iteration.
- Changing merge policy, retry caps, or defaults for non-looped tasks.
