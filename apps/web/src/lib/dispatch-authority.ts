/**
 * The dispatch authority: the one place that turns durable dispatch intent
 * (`task_dispatch_outbox`, packages/core/dispatch-outbox.ts) into runner
 * wake-ups. docs/specs/task-dispatch-authority.md is the contract.
 *
 * State changes create work; time does not. A mutation that may make a task
 * runnable writes an intent in its own transaction (the tasks trigger, or an
 * explicit enqueue in the same statement/batch), then calls `kickDispatch()`.
 * The kick drains due intents right after the response, so the normal path
 * never waits for a cron or a runner poll. The `dispatch-drain` cron is the
 * timer for future intents (a Redis-gated minute tick that touches Postgres
 * only when something is due) and the repair loop for kicks that never ran.
 *
 * A wake re-evaluates; it never assigns. Delivery sends the same nudge for
 * every substrate (webhook consumer, GitHub Actions, Pusher-connected runner)
 * and the claim route applies every gate — dependencies, path overlap,
 * provider capacity, Codex single-flight, budgets, startAt. Nothing here
 * duplicates those gates; the few filters below only decide which consumer
 * is worth a cold start.
 */

import { after } from 'next/server';
import { db } from '@buildd/core/db';
import { tasks, type WorkspaceWebhookConfig } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import {
  claimDueDispatches,
  enqueueDispatchSql,
  listFutureDispatches,
  markDispatchDelivered,
  markDispatchFailed,
  type ClaimedDispatch,
  type DispatchCause,
  type EnqueueDispatchInput,
} from '@buildd/core/dispatch-outbox';
import { channels, events, triggerEvent, triggerEventChecked } from '@/lib/pusher';
import { markDue, reseedDue } from '@/lib/redis';
import {
  buildTaskPayload,
  dispatchToWebhook,
  tryGitHubActionsDispatch,
  type DispatchTask,
  type DispatchWorkspace,
  type TaskDispatchEvent,
} from '@/lib/task-dispatch-delivery';
import { isTaskNotHeldOrLocal } from '@/app/api/workers/claim/held-gate';

/** The Redis due-queue (lib/cron-due-queue.ts) the dispatch-drain tick gates on. */
export const DISPATCH_DUE_QUEUE = 'dispatch';

/** Rows one drain takes. A kick is per-request; a backlog is the cron's to chew through. */
export const DRAIN_BATCH = 25;

// ── Delivery policy (pure) ─────────────────────────────────────────────────

/**
 * Most specific first. A coalesced row carries every cause that landed while
 * it was pending; the first match here decides the webhook event, because a
 * trigger-written `task.created` plus an app-written `plan_child.ready` is a
 * plan child, not a plain new task.
 */
const CAUSE_PRECEDENCE: DispatchCause[] = [
  'plan_child.ready',
  'review.fix_requested',
  'ci.retry',
  'conflict.retry',
  'task.reassigned',
  'manual.start',
  'dependency.satisfied',
  'path_claim.released',
  'budget.available',
  'credential.restored',
  'mission.released',
  'task.unblocked',
  'start_at.reached',
  'task.requeued',
  'task.created',
];

export function primaryCause(causes: readonly string[], fallback: DispatchCause): DispatchCause {
  for (const c of CAUSE_PRECEDENCE) if (causes.includes(c)) return c;
  return fallback;
}

interface CauseRoute {
  event: TaskDispatchEvent;
  /**
   * Whether a webhook with no `events` list receives it. True exactly for the
   * causes the pre-outbox `dispatchNewTask` / `dispatchUnblockedTask` reached
   * a webhook for, so merging the outbox sends an existing consumer nothing
   * new. A webhook that lists events gets every cause mapped to one it lists.
   */
  legacyDefault: boolean;
  /** GitHub Actions repository_dispatch, which only those same two paths started. */
  githubActions: boolean;
  /**
   * Legacy unblocked-path quirk: a webhook without `events` was never filtered
   * by runnerPreference on this path. Kept so the default stays a no-op.
   */
  legacyUnfilteredRunnerPreference: boolean;
}

export function routeForCause(cause: DispatchCause): CauseRoute {
  switch (cause) {
    case 'task.created':
    case 'review.fix_requested':
    case 'ci.retry':
    case 'conflict.retry':
      return { event: 'task.created', legacyDefault: true, githubActions: true, legacyUnfilteredRunnerPreference: false };
    case 'plan_child.ready':
      return { event: 'task.created', legacyDefault: false, githubActions: false, legacyUnfilteredRunnerPreference: false };
    case 'dependency.satisfied':
    case 'manual.start':
      return { event: cause === 'manual.start' ? 'task.retry' : 'task.unblocked', legacyDefault: true, githubActions: true, legacyUnfilteredRunnerPreference: true };
    case 'path_claim.released':
    case 'budget.available':
    case 'credential.restored':
    case 'mission.released':
    case 'task.unblocked':
    case 'start_at.reached':
      return { event: 'task.unblocked', legacyDefault: false, githubActions: false, legacyUnfilteredRunnerPreference: false };
    case 'task.requeued':
    case 'task.reassigned':
      return { event: 'task.retry', legacyDefault: false, githubActions: false, legacyUnfilteredRunnerPreference: false };
  }
}

/** Whether the webhook should be tried for this task and cause. Pure; `notHeldOrLocal` is pre-resolved. */
export function webhookWants(
  config: WorkspaceWebhookConfig | null | undefined,
  task: { runnerPreference?: string | null; startAt?: Date | string | null },
  route: CauseRoute,
  notHeldOrLocal: boolean,
  nowMs: number = Date.now(),
): boolean {
  if (!config?.enabled || !config.url) return false;
  const optedIn = Array.isArray(config.events);
  const subscribed = optedIn ? config.events!.includes(route.event) : route.legacyDefault;
  if (!subscribed) return false;
  const prefOk = (!optedIn && route.legacyUnfilteredRunnerPreference)
    || !config.runnerPreference
    || config.runnerPreference === 'any'
    || config.runnerPreference === (task.runnerPreference || 'any');
  if (!prefOk) return false;
  // A push consumer pays a cold start to learn the claim says "not yet".
  const deferred = task.startAt != null && new Date(task.startAt).getTime() > nowMs;
  if (deferred) return false;
  return notHeldOrLocal;
}

// ── Enqueue + kick ─────────────────────────────────────────────────────────

/**
 * Record intent for state that is already committed. Prefer batching
 * `enqueueDispatchSql` with the mutation itself; this exists for the few
 * paths whose "runnable" transition is a read (a dependency resolving after
 * the parent's own write), where a lost enqueue is re-found by reconciliation.
 * Kicks delivery either way.
 */
export async function enqueueTaskDispatch(input: EnqueueDispatchInput): Promise<void> {
  await db.execute(enqueueDispatchSql(input));
  kickDispatch();
}

/**
 * The wake for a mutation that has already committed: record why (coalescing
 * into the trigger's row when the task just became pending) and kick
 * delivery. This is the one call a state-changing path makes after its write.
 *
 * For a task that became pending in that write, the trigger already made the
 * wake durable; this only adds the specific cause and delivery hints. For a
 * task that was already pending (an unblock), batch `enqueueDispatchSql`
 * with the mutation instead where the mutation is a write, so the intent
 * cannot be lost between the two.
 */
export async function wakeTask(
  taskId: string,
  cause: DispatchCause,
  opts: { notBefore?: Date; targetLocalUiUrl?: string | null } = {},
): Promise<void> {
  try {
    await enqueueTaskDispatch({
      taskId,
      cause,
      notBefore: opts.notBefore,
      metadata: opts.targetLocalUiUrl ? { targetLocalUiUrl: opts.targetLocalUiUrl } : undefined,
    });
  } catch (err) {
    // The trigger row (if any) still stands; a missing cause costs precision, not the wake.
    console.error(`[dispatch] wakeTask enqueue failed for task ${taskId} (${cause}):`, err);
    kickDispatch();
  }
}

/** `wakeTask` for many tasks with one cause (a mission released, a parent's children). */
export async function wakeTasks(taskIds: readonly string[], cause: DispatchCause): Promise<void> {
  if (taskIds.length === 0) return;
  const results = await Promise.allSettled(taskIds.map(id => db.execute(enqueueDispatchSql({ taskId: id, cause }))));
  const failed = results.filter(r => r.status === 'rejected').length;
  if (failed) console.error(`[dispatch] wakeTasks: ${failed}/${taskIds.length} enqueues failed (${cause})`);
  kickDispatch();
}

/** Dashboard-only realtime event for a new task. Not a wake: runners ignore it. */
export async function announceTaskCreated(task: DispatchTask, workspace: DispatchWorkspace): Promise<void> {
  await triggerEvent(channels.workspace(task.workspaceId), events.TASK_CREATED, { task: buildTaskPayload(task, workspace) });
}

/**
 * Deliver whatever is due, after the current response when there is one.
 * Never throws and never blocks the caller: the intent is already durable, so
 * a kick that fails costs latency (the next tick), not the wake.
 */
export function kickDispatch(): void {
  const run = () => drainDispatchOutbox()
    .then(() => scheduleTimer())
    .catch(err => console.error('[dispatch] kick drain failed:', err));
  try {
    after(run);
  } catch {
    // Outside a request scope (scripts, tests): run now, detached.
    void run();
  }
}

/** Publish future due times to the Redis timer index so the gated tick fires on time. */
async function scheduleTimer(): Promise<void> {
  try {
    const future = await listFutureDispatches(50);
    await Promise.all(future.map(f => markDue(DISPATCH_DUE_QUEUE, f.id, f.notBefore.getTime())));
  } catch (err) {
    console.error('[dispatch] timer publish failed:', err);
  }
}

/** Floor tick: rebuild the Redis timer index from the table. */
export async function reseedDispatchTimer(): Promise<void> {
  const future = await listFutureDispatches(500);
  await reseedDue(DISPATCH_DUE_QUEUE, future.map(f => ({ member: f.id, dueAtMs: f.notBefore.getTime() })));
}

// ── Drain + deliver ────────────────────────────────────────────────────────

export interface DrainResult {
  claimed: number;
  delivered: number;
  skipped: number;
  failed: number;
}

/**
 * Take due intents and deliver each. At-least-once: a crash between claim
 * and mark leaves the row `delivering` until its lease lapses, then it is
 * delivered again — harmless, because the claim route is the exactly-once step.
 */
export async function drainDispatchOutbox(opts: { limit?: number } = {}): Promise<DrainResult> {
  const claimed = await claimDueDispatches(opts.limit ?? DRAIN_BATCH);
  const result: DrainResult = { claimed: claimed.length, delivered: 0, skipped: 0, failed: 0 };
  await Promise.all(claimed.map(async row => {
    try {
      const via = await deliverTaskDispatch(row);
      await markDispatchDelivered(row.id, via);
      if (via.startsWith('skipped:')) result.skipped++; else result.delivered++;
    } catch (err) {
      result.failed++;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[dispatch] delivery failed for task ${row.taskId} (attempt ${row.attemptCount}):`, msg);
      await markDispatchFailed(row.id, row.attemptCount, msg).catch(e =>
        console.error('[dispatch] markDispatchFailed failed:', e));
    }
  }));
  if (result.failed > 0) await scheduleTimer();
  if (claimed.length > 0) {
    console.log(JSON.stringify({ event: 'dispatch_drain', ...result }));
  }
  return result;
}

type DeliveryTask = DispatchTask & { status: string; startAt: Date | null };

async function loadForDelivery(taskId: string): Promise<{ task: DeliveryTask; workspace: DispatchWorkspace } | null> {
  const row = await db.query.tasks.findFirst({
    where: eq(tasks.id, taskId),
    columns: {
      id: true, title: true, description: true, workspaceId: true, mode: true, priority: true,
      missionId: true, backend: true, roleSlug: true, runnerPreference: true, status: true, startAt: true,
    },
    with: {
      workspace: {
        columns: { id: true, name: true, repo: true, webhookConfig: true, githubInstallationId: true, githubRepoId: true },
      },
    },
  });
  if (!row) return null;
  const { workspace, ...task } = row as typeof row & { workspace: DispatchWorkspace };
  return { task: task as DeliveryTask, workspace: workspace ?? {} };
}

/**
 * Send one wake. Returns how it went out ('webhook' | 'pusher' |
 * 'pusher:unconfigured' | 'skipped:<why>'); throws when nothing could be
 * delivered, so the row is retried with backoff.
 *
 * Order matches the pre-outbox chain: a targeted local runner, else the
 * workspace webhook (the only exclusive consumer), else GitHub Actions
 * (supplementary) and the Pusher broadcast every connected runner hears.
 */
export async function deliverTaskDispatch(row: ClaimedDispatch): Promise<string> {
  const loaded = await loadForDelivery(row.taskId);
  if (!loaded) return 'skipped:task_gone';
  const { task, workspace } = loaded;
  // Not runnable any more (claimed, cancelled, held back). The claim route
  // would refuse it; spending a wake on it only adds noise.
  if (task.status !== 'pending') return `skipped:status_${task.status}`;
  if (task.startAt && new Date(task.startAt).getTime() > Date.now()) return 'skipped:start_at_future';

  const cause = primaryCause(row.causes, row.cause);
  const route = routeForCause(cause);
  const taskPayload = {
    ...buildTaskPayload(task, workspace),
    dispatch: { id: row.id, cause },
  };

  const targetLocalUiUrl = typeof row.metadata?.targetLocalUiUrl === 'string' ? row.metadata.targetLocalUiUrl : null;
  if (targetLocalUiUrl) {
    const sent = await triggerEventChecked(channels.workspace(task.workspaceId), events.TASK_ASSIGNED, { task: taskPayload, targetLocalUiUrl });
    if (sent === 'failed') throw new Error('pusher targeted assignment failed');
    return sent === 'sent' ? 'pusher:targeted' : 'pusher:unconfigured';
  }

  const webhookConfig = workspace.webhookConfig as WorkspaceWebhookConfig | null | undefined;
  // The held gate is a query; ask it only once the pure policy says yes.
  if (
    webhookConfig
    && webhookWants(webhookConfig, task, route, true)
    && await isTaskNotHeldOrLocal(task.id).catch(() => false)
    && await dispatchToWebhook(webhookConfig, task, route.event, undefined, { cause, dispatchId: row.id })
  ) {
    return 'webhook';
  }

  if (route.githubActions) {
    tryGitHubActionsDispatch(workspace, task).catch(() => {});
  }

  const sent = await triggerEventChecked(channels.workspace(task.workspaceId), events.TASK_ASSIGNED, { task: taskPayload, targetLocalUiUrl: null });
  if (sent === 'failed') throw new Error('pusher broadcast failed');
  return sent === 'sent' ? 'pusher' : 'pusher:unconfigured';
}
