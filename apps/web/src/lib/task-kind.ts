/**
 * The monotone `tasks.kind` write.
 *
 * `kind` is written AT MOST ONCE, by whichever of filer → worker → PR-open
 * reaches it first with a non-null value, and is never overwritten by any of
 * them afterwards (docs/specs/mission-legibility.md Rule K2-20). There is no
 * automated code path that changes a non-null `kind`.
 *
 * That invariant is what lets three independent late signals compose without a
 * clobber rule between them, and it is why the PR-open signal is a WRITE rather
 * than a fourth render-time tier: a derivation would make the database and the
 * screen disagree, and every non-UI consumer — usage stats, exports, the model
 * router on a retry — would still read NULL.
 */

import { db } from '@buildd/core/db';
import { tasks } from '@buildd/core/db/schema';
import { and, eq, isNull } from 'drizzle-orm';
import type { WorkKind } from './task-presentation';

/** The closed vocabulary, mirroring `tasks.kind` and TASK_KINDS in POST /api/tasks. */
export const TASK_KINDS = [
  'coordination', 'engineering', 'research', 'writing', 'design', 'analysis', 'observation',
] as const;

export function isTaskKind(value: unknown): value is WorkKind {
  return typeof value === 'string' && (TASK_KINDS as readonly string[]).includes(value);
}

/**
 * Set `tasks.kind` only if it is still NULL.
 *
 * A single atomic guarded UPDATE, following the optimistic-lock pattern this
 * codebase uses in place of interactive transactions (the neon-http driver has
 * no `db.transaction`). Reporting a kind for an already-classified task is a
 * NO-OP, not an error — a worker that volunteers one should never be punished
 * for losing a race it was not told it was in.
 *
 * Returns true when this call is the one that wrote the value.
 *
 * Never throws. Every caller is a side channel on a path whose real contract is
 * something else — a PR that has already been opened on GitHub, a progress
 * report the runner is waiting on — and a legibility column must not be able to
 * fail either of those. Same property `recordGateEvent` holds for the same
 * reason.
 */
export async function stampTaskKindIfAbsent(
  taskId: string | null | undefined,
  kind: WorkKind,
): Promise<boolean> {
  if (!taskId) return false;
  try {
    const updated = await db
      .update(tasks)
      .set({ kind, updatedAt: new Date() })
      .where(and(eq(tasks.id, taskId), isNull(tasks.kind)))
      .returning({ id: tasks.id });
    return updated.length > 0;
  } catch (err) {
    console.error(`[task-kind] failed to stamp kind='${kind}' on task ${taskId}:`, err);
    return false;
  }
}
