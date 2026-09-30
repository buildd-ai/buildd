/**
 * Per-sender rate limit for `send_worker_message`: at most
 * WORKER_MSG_MAX_PER_WINDOW messages per recipient task per minute, counted in
 * the SENDER task's `context.workerMsgRateLimit` (no dedicated table).
 *
 * Check and increment are one statement. The handler used to read the whole
 * context, bump the counter in JS and write the whole object back — so two
 * concurrent sends both passed the check, and either write could wipe a key
 * another writer (a queued worker message, a merge-status flag) had just set.
 * Here the counter is updated inside its own SET expression against the row's
 * current value, and the limit is the WHERE clause: zero rows back means the
 * send is refused. neon-http has no interactive transaction to fall back on.
 */
import { and, eq, sql, type SQL } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { tasks } from '@buildd/core/db/schema';

export const WORKER_MSG_RATE_WINDOW_MS = 60_000;
export const WORKER_MSG_MAX_PER_WINDOW = 5;

function rateExpr(): SQL {
  return sql`COALESCE(${tasks.context} -> 'workerMsgRateLimit', '{}'::jsonb)`;
}

function windowExpired(nowMs: number): SQL {
  return sql`(${nowMs}::bigint - COALESCE((${rateExpr()} ->> 'windowStart')::bigint, 0) > ${WORKER_MSG_RATE_WINDOW_MS})`;
}

function currentCount(recipientTaskId: string): SQL {
  return sql`COALESCE((${rateExpr()} -> 'counts' ->> ${recipientTaskId}::text)::int, 0)`;
}

/**
 * SET expression: a fresh window holding one message to this recipient, or
 * the current window with this recipient's counter incremented. Every other
 * context key is left alone. Exported so tests can render it.
 */
export function buildWorkerMsgRateLimitSetSql(recipientTaskId: string, nowMs: number): SQL {
  return sql`jsonb_set(
    COALESCE(${tasks.context}, '{}'::jsonb),
    '{workerMsgRateLimit}',
    CASE WHEN ${windowExpired(nowMs)}
      THEN jsonb_build_object('windowStart', ${nowMs}::bigint, 'counts', jsonb_build_object(${recipientTaskId}::text, 1))
      ELSE ${rateExpr()} || jsonb_build_object(
        'counts',
        COALESCE(${rateExpr()} -> 'counts', '{}'::jsonb)
          || jsonb_build_object(${recipientTaskId}::text, ${currentCount(recipientTaskId)} + 1)
      )
    END
  )`;
}

/** WHERE predicate: the window has expired, or this recipient is under the cap. */
export function buildWorkerMsgRateLimitAllowedSql(recipientTaskId: string, nowMs: number): SQL {
  return sql`(${windowExpired(nowMs)} OR ${currentCount(recipientTaskId)} < ${WORKER_MSG_MAX_PER_WINDOW})`;
}

/**
 * Atomically consume one send from the sender's budget for this recipient.
 * Returns false when the sender is at the cap (nothing is written).
 */
export async function consumeWorkerMsgRateLimit(
  senderTaskId: string,
  recipientTaskId: string,
  nowMs: number = Date.now(),
): Promise<boolean> {
  const rows = await db
    .update(tasks)
    .set({ context: buildWorkerMsgRateLimitSetSql(recipientTaskId, nowMs) })
    .where(and(eq(tasks.id, senderTaskId), buildWorkerMsgRateLimitAllowedSql(recipientTaskId, nowMs)))
    .returning({ id: tasks.id });
  return rows.length > 0;
}

/** Seconds until the sender's current window ends, from a context read earlier. */
export function workerMsgRetryAfterSeconds(senderContext: unknown, nowMs: number = Date.now()): number {
  const rate = (senderContext as { workerMsgRateLimit?: { windowStart?: number } } | null)?.workerMsgRateLimit;
  const windowStart = typeof rate?.windowStart === 'number' ? rate.windowStart : nowMs;
  return Math.max(1, Math.ceil((windowStart + WORKER_MSG_RATE_WINDOW_MS - nowMs) / 1000));
}
