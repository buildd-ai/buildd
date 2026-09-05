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
 * Both writes are single statements that read `context` inside their own SET
 * expression. A read-modify-write would reinstate the same loss by another
 * route: two producers, or a producer and the recipient's own check-in, each
 * replace the whole jsonb column from a copy taken before the other wrote.
 * `deliveredTo` at apps/web/src/app/api/workers/[id]/route.ts and the context
 * merges in auto-merge.ts / conflict-retry.ts / pr-review-request.ts use the
 * same pattern; neon-http has no interactive transaction to fall back on.
 *
 * Producers: `send_worker_message` (MCP, agent-initiated), the §6d passive
 * overlap notifier, and `releaseAndNotify` (path_released).
 */

import { eq, sql, type SQL } from 'drizzle-orm';
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

/**
 * SQL for "append this message, keep only the newest WORKER_MESSAGE_CAP".
 *
 * Exported so it can be asserted directly: with a mocked db there is no
 * resulting array to inspect, only the statement.
 */
export function buildEnqueueContextSql(message: WorkerMessage): SQL {
  const appended = sql`(COALESCE(${tasks.context} -> 'pendingWorkerMessages', '[]'::jsonb) || ${JSON.stringify([message])}::jsonb)`;
  return sql`jsonb_set(
    COALESCE(${tasks.context}, '{}'::jsonb),
    '{pendingWorkerMessages}',
    COALESCE((
      SELECT jsonb_agg(elem ORDER BY ord)
      FROM jsonb_array_elements(${appended}) WITH ORDINALITY AS queued(elem, ord)
      WHERE ord > jsonb_array_length(${appended}) - ${WORKER_MESSAGE_CAP}
    ), '[]'::jsonb)
  )`;
}

/** SQL for "drop these ids from the queue, leave everything else alone". */
export function buildClearContextSql(deliveredIds: string[]): SQL {
  const ids = sql`${JSON.stringify(deliveredIds)}::jsonb`;
  return sql`jsonb_set(
    COALESCE(${tasks.context}, '{}'::jsonb),
    '{pendingWorkerMessages}',
    COALESCE((
      SELECT jsonb_agg(elem ORDER BY ord)
      FROM jsonb_array_elements(COALESCE(${tasks.context} -> 'pendingWorkerMessages', '[]'::jsonb)) WITH ORDINALITY AS queued(elem, ord)
      WHERE elem ->> 'id' IS NULL OR NOT (${ids} ? (elem ->> 'id'))
    ), '[]'::jsonb)
  )`;
}

/**
 * Append a message to a recipient task's queue, capped at WORKER_MESSAGE_CAP.
 * Returns false when the task no longer exists (nothing is written).
 *
 * A terminal recipient is written deliberately, and does NOT mirror
 * `send_worker_message`'s terminal guard: retries reuse the same task row and
 * inherit its context, so a queued `path_released` ("your base moved") is
 * still correct for the next worker on that task. The MCP guard exists to tell
 * a waiting *sender* to escalate; this path has no sender to inform.
 */
export async function enqueueWorkerMessage(
  toTaskId: string,
  message: WorkerMessage,
): Promise<boolean> {
  const rows = await db
    .update(tasks)
    .set({ context: buildEnqueueContextSql(message) })
    .where(eq(tasks.id, toTaskId))
    .returning({ id: tasks.id });

  return rows.length > 0;
}

/**
 * Remove acked messages from a task's queue. Ids that are not queued are
 * ignored, and messages that arrived after the response was served survive —
 * the filter runs against the column, not against what the caller last read.
 * Returns whether a statement was issued.
 */
export async function clearWorkerMessages(
  taskId: string,
  deliveredIds: string[],
): Promise<boolean> {
  if (deliveredIds.length === 0) return false;

  const rows = await db
    .update(tasks)
    .set({ context: buildClearContextSql(deliveredIds) })
    .where(eq(tasks.id, taskId))
    .returning({ id: tasks.id });

  return rows.length > 0;
}
