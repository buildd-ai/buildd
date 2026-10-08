/**
 * Core events: the one way the coordination loop tells optional modules that
 * something happened. This file is the contract (event types, subscriber
 * shape) and imports nothing, so modules can depend on it freely; the
 * emitter is `lib/core-emit.ts`.
 *
 * Core code (the worker PATCH, the GitHub webhook, PR reconciliation) calls
 * `emit(event)` at the point a fact becomes true. Modules (missions,
 * knowledge, chat, notifications, ...) react by subscribing. Core never
 * imports a module: the subscriber list comes from the composition root
 * (`apps/web/src/modules.ts`), the only file allowed to import every module.
 * See knowledge-base: buildd/design/headless-core-and-modules.md.
 *
 * Semantics. This is not a bus and stores nothing:
 *   - Subscribers run in-request, in the composition root's order, each awaited
 *     in turn. The first one starts synchronously, so `void emit(...)` from a
 *     request still schedules `after()` work inside that request.
 *   - Each subscriber is isolated: a throw is logged and paged, and the next
 *     subscriber still runs. `emit` itself never throws.
 *   - At most once. A subscriber that needs at-least-once owns its own floor
 *     (a reconcile cron), exactly as the inline calls did.
 *
 * The subscriptions ledger (`lib/subscriptions.ts` `recordEvent`) is one such
 * subscriber, owned by the notifications module, so every event that maps to
 * a ledger event is recorded with no emitter knowing the ledger exists.
 */

/**
 * Why core failed a task whose worker reported it completed: a
 * completion-policy slot's verdict (lib/completion-policy.ts), or the held
 * release resolving red. `label` is fixed copy, safe in a sensitive
 * workspace; `reason` is the slot's own detail and is not.
 */
export interface SlotFailure {
  slot: 'loop' | 'release';
  label: 'Loop attempts exhausted' | 'Release failed' | 'Release CI failed' | 'Release merge failed';
  reason: string;
}

/**
 * The outcome-analytics row (`@buildd/core/routing-analytics`
 * `recordTaskOutcome`) a held release's worker report would have written,
 * minus the outcome: the worker PATCH keeps it on `tasks.context` while the
 * release waits on CI, and the resolution records it with the real outcome.
 */
export interface HeldOutcomeAnalytics {
  accountId: string | null;
  actualModel: string | null;
  totalCostUsd: number | string | null;
  totalTurns: number | null;
  durationMs: number | null;
  wasRetried: boolean;
  exitCause: string | null;
  workerId: string;
}

/**
 * The task's outcome as people are told it. The type is the task's FINAL
 * status, as core decided it, never just the status the worker reported.
 * `via: 'worker'`: settled by the worker PATCH. `via: 'release'`: a release
 * held for CI, settled later by the release PR's CI (GitHub webhook); the
 * PATCH emitted no outcome while it was held.
 */
export interface WorkerTaskOutcome {
  via: 'worker' | 'release';
  taskId: string;
  workerId: string;
  workspaceId: string | null;
  missionId: string | null;
  /** Raw title. Subscribers decide what a sensitive workspace may see. */
  title: string;
  sensitive: boolean;
  teamId: string;
  workspaceName: string | null;
  /** The worker's error text, for failures. */
  error: string | null;
  /** Set on `task.failed` when a slot, not the worker, failed the task. */
  failure?: SlotFailure | null;
  /**
   * `via: 'release'` only: the analytics row the PATCH kept while the release
   * was held. Null for a task held before the PATCH kept one.
   */
  heldAnalytics?: HeldOutcomeAnalytics | null;
}

type WorkerOutcomeType = 'task.completed' | 'task.failed' | 'task.retrying';
/** One member per type, so `Extract<CoreEvent, { type: 'task.completed' }>` sees it. */
type WorkerOutcomeEvent = { [T in WorkerOutcomeType]: { type: T } & WorkerTaskOutcome }[WorkerOutcomeType];

export type CoreEvent =
  /**
   * The task's terminal status is on its row: not an auto-retry, not a loop
   * requeue, not a release still held for CI. The worker PATCH emits it when
   * the report settles the task; for a held release, the release PR's CI
   * resolution emits it (lib/task-outcome-event.ts). Once per settled report.
   */
  | { type: 'task.terminal'; taskId: string; workerId: string; workspaceId: string | null; sensitive: boolean }
  /**
   * A worker reported completed/failed/error and the task row is written.
   * Fires for auto-retries and loop iterations too. `status` is what the
   * worker REPORTED; `finalStatus` is the terminal status core decided (a
   * completion-policy slot or a contract guard may have failed a reported
   * completion), null when the report did not settle the task: requeued, or
   * `releaseHeld` (the release PR's CI settles it later and emits its
   * outcome then, `via: 'release'`).
   */
  | {
      type: 'worker.reported';
      taskId: string;
      workerId: string;
      workspaceId: string | null;
      missionId: string | null;
      status: 'completed' | 'failed' | 'error';
      finalStatus: 'completed' | 'failed' | null;
      releaseHeld: boolean;
      structuredOutput: unknown;
      verificationEvidence: unknown;
    }
  | WorkerOutcomeEvent
  /** A merged PR completed the task (GitHub webhook). */
  | { type: 'task.completed'; via: 'merge'; taskId: string; workerId: string; workspaceId: string | null }
  | { type: 'task.needs_input'; taskId: string; workerId: string; prompt: string | null | undefined }
  /** The worker row's terminal write landed (after the conflict check). */
  | {
      type: 'worker.finished';
      taskId: string;
      workerId: string;
      accountId: string;
      status: string;
      previousStatus: string | null;
      serverRefusal: boolean;
      summary: string | null;
      workspace: { dataClass?: string | null; gitConfig?: { dataClass?: string } | null } | null;
    }
  /**
   * POST /api/tasks committed a filing. `attached`: subject intake attached it
   * to an existing canonical task, which `taskId` then names, and nothing new
   * was inserted. Emitted after the commit; subscribers must not delay or
   * fail the request (fire-and-forget past the first await).
   */
  | {
      type: 'task.created';
      taskId: string;
      workspaceId: string;
      teamId: string;
      missionId: string | null;
      /** The task row's title. */
      title: string;
      /** The description as filed. */
      description: string | null;
      attached: boolean;
      /** The stored category, and whether the filer supplied it. */
      category: { stored: string | null; callerSet: boolean };
      dataClass: string | null;
      creator: {
        accountId: string | null;
        user: { id: string; email?: string | null; name?: string | null } | null;
        apiAccount: { id: string; name?: string | null } | null;
        workerId: string | null;
      };
    }
  /** A team row and its owner membership are written. */
  | { type: 'team.created'; teamId: string }
  /** A workspace row is written (POST /api/workspaces). `origin` is the request origin, for OAuth callbacks. */
  | { type: 'workspace.created'; workspaceId: string; teamId: string; origin: string }
  /**
   * A PR merged. `delivery` is present when the GitHub webhook delivered the
   * merge (every delivery, redeliveries included); reconciliation emits the
   * same fact without it.
   */
  | {
      type: 'pr.merged';
      repoFullName: string;
      prNumber: number;
      url: string | null | undefined;
      delivery?: {
        installationId: number | null;
        baseRef: string | null;
        baseSha: string | null;
        headSha: string;
        mergeCommitSha: string | null;
        title: string | null;
      };
    }
  /**
   * A task's own PR merged: every webhook delivery, redeliveries included,
   * after `workers.mergedAt` is stamped and before the task's status
   * transition. Subscribers must be idempotent.
   */
  | {
      type: 'task.pr_merge_delivered';
      taskId: string;
      workerId: string;
      workspaceId: string;
      missionId: string | null;
      baseRef: string | null;
    }
  /**
   * A task's PR merged, once per merge, after the task's status transition.
   * `via: 'worker'`: the PR's own worker row, first delivery (`workers.mergedAt`
   * was unset). `via: 'branch_match'`: no worker owns the PR; the task was
   * found by its branch name and this merge completed it.
   * `transition`: whether this merge flipped the task to completed, found it
   * already completed, or lost the race to the worker's own completion.
   * Effects of the merge itself, as opposed to the transition, hang off this.
   */
  | {
      type: 'task.pr_merged';
      via: 'worker' | 'branch_match';
      transition: 'flipped' | 'already_completed' | 'not_flipped';
      taskClass: string | null;
      taskId: string;
      workerId: string | null;
      workspaceId: string;
      missionId: string | null;
      /** tasks.release: 'true' | 'false' | 'inherit'. */
      release: string | null;
      repoFullName: string;
      baseRef: string | null;
      installationId: number | null;
    }
  /**
   * A pull_request.closed delivery arrived, merged or not, for any PR on a
   * linked repo: every delivery, redeliveries included. `workspaceId` is the
   * owning worker's, when a worker owns the PR. Subscribers must be idempotent.
   */
  | {
      type: 'pr.close_delivered';
      repoFullName: string;
      prNumber: number;
      merged: boolean;
      baseRef: string | null;
      installationId: number | null;
      workspaceId: string | null;
    }
  /**
   * A worker-owned PR closed, merged or not: every delivery. `mergeIsNew`: this
   * delivery is the first to report the merge (`workers.mergedAt` was unset);
   * false on a redelivery and on a close without merge.
   */
  | {
      type: 'pr.closed';
      workspaceId: string;
      prNumber: number;
      merged: boolean;
      mergeIsNew: boolean;
      workerId: string;
      taskId: string | null;
      headSha: string;
      repoFullName: string;
      installationId: number | null;
    }
  /**
   * A GitHub review was submitted (any state: approved, changes_requested,
   * commented) on a PR. `owner` is the worker that owns the PR, when one does.
   * Every delivery; subscribers must be idempotent or say why not.
   */
  | { type: 'pr.review_submitted'; repoFullName: string; prNumber: number; review: GitHubReviewFact; owner: PrOwnerFact | null }
  /** An inline review comment was created on a PR (`pull_request_review_comment`). */
  | { type: 'pr.review_comment_created'; repoFullName: string; prNumber: number; comment: GitHubReviewCommentFact; owner: PrOwnerFact | null }
  /** A worker-owned PR's base moved (`edited`), after any repair: `toBase` is where it settled. */
  | { type: 'pr.base_changed'; workspaceId: string; prNumber: number; fromBase: string; toBase: string }
  /**
   * A mission's PR needs a person: held for human review, blocked from
   * auto-merge, or moved off the mission's integration branch.
   */
  | {
      type: 'pr.needs_human';
      missionId: string;
      title: string;
      prUrl: string;
      prNumber: number;
      headSha: string;
      reason: 'auto_merge_blocked' | 'awaiting_review' | 'base_retargeted';
      message: string;
    }
  /** A GitHub Actions workflow run completed (any workflow, any repo linked to an installation). */
  | { type: 'workflow_run.completed'; run: WorkflowRunFact; installationId: number | null }
  /** A check suite completed red on a PR. Every delivery, once per PR in the suite. */
  | { type: 'pr.ci_failed'; repoFullName: string; prNumber: number; headSha: string; installationId: number }
  /** Every check suite on a worker PR's head passed (the PR's lifecycle is now ci_green). Every delivery. */
  | { type: 'pr.ci_passed'; repoFullName: string; prNumber: number; headSha: string; installationId: number }
  /**
   * A push (`synchronize`) to an open PR a buildd worker owns: every delivery,
   * redeliveries included. `worker` is the newest row owning the PR (a retry
   * continues on the same PR). Subscribers must be idempotent.
   */
  | {
      type: 'pr.synchronized';
      installationId: number;
      repoFullName: string;
      pr: { number: number; headSha: string; htmlUrl: string; baseRef: string | null; body: string | null; draft: boolean };
      worker: { id: string; workspaceId: string; taskId: string | null; branch: string };
    }
  /**
   * A buildd worker's PR became visible for review: opened ready, or taken out
   * of draft. Every delivery, redeliveries included. Subscribers must be
   * idempotent.
   */
  | {
      type: 'pr.review_ready';
      installationId: number;
      repoFullName: string;
      pr: { number: number; headRef: string; additions: number | null; deletions: number | null };
      worker: { id: string; workspaceId: string; taskId: string };
    };

/** The worker that owns a PR, as the webhook resolved it. */
export interface PrOwnerFact {
  workerId: string;
  taskId: string | null;
  workspaceId: string | null;
  missionId: string | null;
}

/** A GitHub `review` payload object, as delivered. */
export interface GitHubReviewFact {
  id?: number | string | null;
  state?: string | null;
  body?: string | null;
  user?: { login?: string | null } | null;
  [key: string]: unknown;
}

/** A GitHub review `comment` payload object, as delivered. */
export interface GitHubReviewCommentFact {
  id?: number | string | null;
  body?: string | null;
  path?: string | null;
  [key: string]: unknown;
}

/** The fields of a GitHub `workflow_run` payload the platform reads. */
export interface WorkflowRunFact {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  html_url: string;
  head_branch: string | null;
  head_sha: string;
  event?: string;
  path?: string;
  head_commit?: { id?: string; message?: string } | null;
  repository: { full_name: string };
}

export type CoreEventType = CoreEvent['type'];
export type EventOf<K extends CoreEventType> = Extract<CoreEvent, { type: K }>;

export interface Subscriber<K extends CoreEventType = CoreEventType> {
  /** Owning module, for logs and the composition-root test. */
  module: string;
  /** Stable step name. Failures page under it. */
  label: string;
  on: K;
  run: (event: EventOf<K>) => Promise<void> | void;
}

/** A subscriber to any one event type: what lists hold. */
export type AnySubscriber = { [K in CoreEventType]: Subscriber<K> }[CoreEventType];

/** Typed constructor, so `run` sees the narrowed event. */
export function subscriber<K extends CoreEventType>(
  module: string, on: K, label: string, run: (event: EventOf<K>) => Promise<void> | void,
): Subscriber<K> {
  return { module, on, label, run };
}
