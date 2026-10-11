/**
 * Server-originated instructions to a running worker, on the same queue
 * `POST /api/workers/[id]/instruct` writes (`workers.pendingInstructions`) —
 * the one channel every runner reads at its next check-in and injects into the
 * session. Used by notices the platform raises on its own (base-advance,
 * live-sibling overlap), which have no human caller to authenticate.
 */
import { db } from '@buildd/core/db';
import { workers } from '@buildd/core/db/schema';
import { TERMINAL_WORKER_STATUSES } from '@buildd/shared';
import { and, eq, inArray, not, sql } from 'drizzle-orm';
import type { InstructionHistoryEntry } from '@/lib/worker-instructions';

/**
 * Append `text` to a worker's instruction queue in one statement.
 *
 * SQL-side append, not the instruct route's read-modify-write: the worker is
 * checking in every ~10s and a webhook can arrive mid-check-in. Skips a
 * terminal worker, and a queue that already holds `marker` (a notice for this
 * base the runner has not collected yet), so redeliveries and the
 * pull_request/push pair never stack two notices.
 *
 * The history entry is `pending` like any queued instruction and is settled by
 * the same delivery ack; a sensitive workspace stores the envelope only.
 */
export async function queueSystemInstruction(
  workerId: string,
  text: string,
  opts: { marker?: string; sensitive?: boolean } = {},
): Promise<boolean> {
  const entry: InstructionHistoryEntry = opts.sensitive
    ? { type: 'instruction', timestamp: Date.now(), deliveryState: 'pending' }
    : { type: 'instruction', message: text, timestamp: Date.now(), deliveryState: 'pending' };
  const rows = await db
    .update(workers)
    .set({
      pendingInstructions: sql`CASE WHEN COALESCE(${workers.pendingInstructions}, '') = '' THEN ${text}
        ELSE ${workers.pendingInstructions} || E'\n\n' || ${text} END`,
      instructionHistory: sql`COALESCE(${workers.instructionHistory}, '[]'::jsonb) || ${JSON.stringify([entry])}::jsonb`,
      updatedAt: new Date(),
    })
    .where(and(
      eq(workers.id, workerId),
      not(inArray(workers.status, [...TERMINAL_WORKER_STATUSES])),
      ...(opts.marker
        ? [sql`strpos(COALESCE(${workers.pendingInstructions}, ''), ${opts.marker}) = 0`]
        : []),
    ))
    .returning({ id: workers.id });
  return rows.length > 0;
}
