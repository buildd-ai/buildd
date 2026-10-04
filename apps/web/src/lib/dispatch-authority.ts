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
 * A wake means "reconsider this task now", never "assign it", and durable
 * dispatch does not imply autonomous execution. Delivery hands each due
 * intent to destination adapters (lib/dispatch-adapters.ts); which
 * destination receives it, and in what execution mode, is policy there, not
 * here. Today's adapters wake runners, and the claim route applies every gate
 * — dependencies, path overlap, provider capacity, Codex single-flight,
 * budgets, startAt. Nothing here duplicates those gates.
 */

import { after } from 'next/server';
import { db } from '@buildd/core/db';
import { tasks } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import {
  claimDueDispatches,
  enqueueDispatchSql,
  listFutureDispatches,
  markDispatchDelivered,
  markDispatchFailed,
  MAX_DELIVERY_ATTEMPTS,
  type ClaimedDispatch,
  type DispatchIntent,
  type DispatchCause,
  type EnqueueDispatchInput,
} from '@buildd/core/dispatch-outbox';
import { channels, events, triggerEvent } from '@/lib/pusher';
import { clearDue, markDue, reseedDue } from '@/lib/redis';
import { buildTaskPayload, type DispatchTask, type DispatchWorkspace } from '@/lib/task-dispatch-delivery';
import { ADAPTER_CHAINS, type DispatchAdapter, type DispatchContext } from '@/lib/dispatch-adapters';

/** The Redis due-queue (lib/cron-due-queue.ts) the dispatch-drain tick gates on. */
export const DISPATCH_DUE_QUEUE = 'dispatch';

/** Rows one drain takes. A kick is per-request; a backlog is the cron's to chew through. */
export const DRAIN_BATCH = 25;

// ── Cause precedence ───────────────────────────────────────────────────────

/**
 * Most specific first. A coalesced row carries every cause that landed while
 * it was pending; adapters route on the first match here, because a
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
  // The kick runs after the response; if the function dies first, nothing
  // else knows an immediate wake is waiting except the hourly floor. A due
  // marker a little in the future lets the gated minute tick find it; a kick
  // that drains clears its own marker, so the happy path costs no tick.
  const marker = `kick:${input.taskId}:${Date.now()}`;
  await markDue(DISPATCH_DUE_QUEUE, marker, Date.now() + KICK_GRACE_MS);
  kickDispatch(marker);
}

/** How long a kick has to drain before the gated tick treats it as lost. */
export const KICK_GRACE_MS = 30_000;

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

/**
 * Record a non-work intent Buildd's policy has decided on — a human action,
 * a notification, an incident, external work — and kick delivery. The intent
 * is durable before this returns; whether anything is delivered depends on
 * an adapter being registered for its kind (ADAPTER_CHAINS). Work execution
 * uses `wakeTask`.
 */
export async function dispatchIntent(input: {
  taskId: string;
  intent: Exclude<DispatchIntent, 'work_execution'>;
  cause?: DispatchCause;
  notBefore?: Date;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await enqueueTaskDispatch({ ...input, cause: input.cause ?? 'policy.requested' });
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
export function kickDispatch(marker?: string): void {
  const run = () => drainDispatchOutbox()
    .then(() => (marker ? clearDue(DISPATCH_DUE_QUEUE, marker) : undefined))
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
      // An unroutable kind will not become routable by waiting.
      const attempts = err instanceof NoDispatchAdapterError ? MAX_DELIVERY_ATTEMPTS : row.attemptCount;
      await markDispatchFailed(row.id, attempts, msg).catch(e =>
        console.error('[dispatch] markDispatchFailed failed:', e));
    }
  }));
  if (result.failed > 0) await scheduleTimer();
  if (claimed.length > 0) {
    console.log(JSON.stringify({ event: 'dispatch_drain', ...result }));
  }
  return result;
}


async function loadForDelivery(taskId: string): Promise<{ task: DispatchContext['task']; workspace: DispatchWorkspace } | null> {
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
  return { task: task as DispatchContext['task'], workspace: workspace ?? {} };
}

/** No adapter is registered for an intent's kind. Parked at once, not retried: retrying cannot help. */
export class NoDispatchAdapterError extends Error {
  constructor(readonly intent: string) {
    super(`no_adapter:${intent}`);
  }
}

/**
 * Offer one due intent to the adapter chain for its kind, in order, and
 * report how it went ('webhook' | 'pusher' | 'skipped:<why>' …). The first
 * adapter that delivers or skips ends the chain; a declined offer passes to
 * the next; a throw leaves the row for a retry with backoff.
 *
 * This loop knows nothing about what a destination does with the intent.
 * Buildd's policy decided what should happen when it wrote the intent; the
 * dispatcher only delivers it. `chain` overrides the registry (tests, and a
 * caller proving a new destination).
 */
export async function deliverTaskDispatch(
  row: ClaimedDispatch,
  chain: readonly DispatchAdapter[] | undefined = ADAPTER_CHAINS[row.intent ?? 'work_execution'],
): Promise<string> {
  const intent = row.intent ?? 'work_execution';
  if (!chain || chain.length === 0) throw new NoDispatchAdapterError(intent);
  const loaded = await loadForDelivery(row.taskId);
  if (!loaded) return 'skipped:task_gone';
  const ctx: DispatchContext = {
    dispatchId: row.id,
    intent,
    cause: primaryCause(row.causes, row.cause),
    causes: row.causes,
    metadata: row.metadata,
    task: loaded.task,
    workspace: loaded.workspace,
  };
  for (const adapter of chain) {
    const outcome = await adapter.offer(ctx);
    if (outcome.kind === 'delivered') return outcome.via;
    if (outcome.kind === 'skipped') return `skipped:${outcome.why}`;
  }
  return 'skipped:no_destination';
}
