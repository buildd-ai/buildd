/**
 * Worker→worker message queue.
 *
 * Messages live in `tasks.context.pendingWorkerMessages` (jsonb, no dedicated
 * table) and are served to the recipient agent by PATCH /api/workers/[id],
 * which returns them as `pendingMessages[]`. The MCP `update_progress` handler
 * renders them into the tool result and confirms delivery by id.
 *
 * The invariant this module exists to hold: **a message leaves the queue only
 * when a consumer acks its id.** It used to be drained on any progress PATCH
 * that carried touched paths, so every message the passive overlap notifier
 * produced was destroyed before an agent could read it. Serving the same
 * message twice is cheap; losing it is not.
 *
 * Producers: `send_worker_message` (MCP, agent-initiated), the §6d passive
 * overlap notifier, and `releaseAndNotify` (path_released).
 */

import { eq } from 'drizzle-orm';
import { db } from './db';
import { tasks } from './db/schema';

export {
  WORKER_MESSAGE_CAP,
  buildWorkerMessage,
  formatWorkerMessages,
} from './worker-message-format';
export type {
  WorkerMessage,
  WorkerMessageType,
  WorkerMessageInput,
} from './worker-message-format';

import { WORKER_MESSAGE_CAP, type WorkerMessage } from './worker-message-format';

function readQueue(context: unknown): WorkerMessage[] {
  const ctx = (context ?? {}) as Record<string, unknown>;
  return Array.isArray(ctx.pendingWorkerMessages)
    ? (ctx.pendingWorkerMessages as WorkerMessage[])
    : [];
}

/**
 * Append a message to a recipient task's queue, capped at WORKER_MESSAGE_CAP.
 * Returns false when the task no longer exists (nothing is written).
 */
export async function enqueueWorkerMessage(
  toTaskId: string,
  message: WorkerMessage,
): Promise<boolean> {
  const task = await db.query.tasks.findFirst({
    where: eq(tasks.id, toTaskId),
    columns: { context: true },
  });
  if (!task) return false;

  const context = (task.context ?? {}) as Record<string, unknown>;
  const queued = [...readQueue(context), message];
  const capped = queued.length > WORKER_MESSAGE_CAP
    ? queued.slice(-WORKER_MESSAGE_CAP)
    : queued;

  await db
    .update(tasks)
    .set({ context: { ...context, pendingWorkerMessages: capped } })
    .where(eq(tasks.id, toTaskId));

  return true;
}

/**
 * Remove acked messages from a task's queue. Ids that are not queued are
 * ignored, and a call that would change nothing writes nothing — an ack for a
 * stale id must never empty the queue behind a message that arrived since.
 * Returns the number of messages removed.
 */
export async function clearWorkerMessages(
  taskId: string,
  deliveredIds: string[],
): Promise<number> {
  if (deliveredIds.length === 0) return 0;

  const task = await db.query.tasks.findFirst({
    where: eq(tasks.id, taskId),
    columns: { context: true },
  });
  if (!task) return 0;

  const context = (task.context ?? {}) as Record<string, unknown>;
  const queued = readQueue(context);
  const retained = queued.filter(m => !deliveredIds.includes(m?.id));
  const removed = queued.length - retained.length;
  if (removed === 0) return 0;

  await db
    .update(tasks)
    .set({ context: { ...context, pendingWorkerMessages: retained } })
    .where(eq(tasks.id, taskId));

  return removed;
}

/**
 * Render queued messages for an agent-facing tool result. Each message states
 * what it is and what the agent is expected to do about it — a message the
 * agent cannot act on is noise, and noise is what made this channel worth
 * ignoring.
 */
