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

/** The task's outcome as people are told it, reported by its worker. */
export interface WorkerTaskOutcome {
  via: 'worker';
  taskId: string;
  workerId: string;
  workspaceId: string | null;
  /** Raw title. Subscribers decide what a sensitive workspace may see. */
  title: string;
  sensitive: boolean;
  teamId: string;
  workspaceName: string | null;
  /** The worker's error text, for failures. */
  error: string | null;
}

type WorkerOutcomeType = 'task.completed' | 'task.failed' | 'task.retrying';
/** One member per type, so `Extract<CoreEvent, { type: 'task.completed' }>` sees it. */
type WorkerOutcomeEvent = { [T in WorkerOutcomeType]: { type: T } & WorkerTaskOutcome }[WorkerOutcomeType];

export type CoreEvent =
  /**
   * The worker's report is on the task row and the outcome is settled: not an
   * auto-retry, not a loop requeue.
   */
  | { type: 'task.terminal'; taskId: string; workerId: string; workspaceId: string | null; sensitive: boolean }
  /**
   * A worker reported completed/failed/error and the task row is written.
   * Fires for auto-retries and loop iterations too.
   */
  | {
      type: 'worker.reported';
      taskId: string;
      workerId: string;
      workspaceId: string | null;
      missionId: string | null;
      status: 'completed' | 'failed' | 'error';
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
   * A task's own PR merged, and this is the first delivery that says so
   * (`workers.mergedAt` was unset). Effects of the merge itself, as opposed to
   * the task's status transition, hang off this, so they run once per merge.
   */
  | {
      type: 'task.pr_merged';
      taskId: string;
      workerId: string;
      workspaceId: string;
      missionId: string | null;
      /** tasks.release: 'true' | 'false' | 'inherit'. */
      release: string | null;
      repoFullName: string;
      baseRef: string | null;
      installationId: number | null;
    }
  /** A GitHub Actions workflow run completed (any workflow, any repo linked to an installation). */
  | { type: 'workflow_run.completed'; run: WorkflowRunFact; installationId: number | null }
  | { type: 'pr.ci_failed'; repoFullName: string; prNumber: number; headSha: string };

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
