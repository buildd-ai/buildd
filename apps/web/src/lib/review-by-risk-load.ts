import { db } from '@buildd/core/db';
import { tasks } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import type { AcStanding } from '@/lib/review-by-risk';

/**
 * The acceptance checks a task's PR answers for, and how each stands at
 * `headSha`, for review by risk's R-1 test condition. Read through the same
 * governed-outcome fold the spec outcome uses (lib/specs/outcome.ts), so the
 * merge rail and `manage_specs outcome` cannot disagree about a criterion.
 *
 * - `pinned: false`: no task, or a task with no spec pin (R-3: no test condition).
 * - `pinned: true`: the AC-n ids in scope of the pinned revision (provisional
 *   pins included, R-2) and their standings.
 * - `error`: pinned, but the pinned revision could not be read. The caller
 *   fails closed: an unreadable pin cannot show its checks were tested.
 */
export type AcceptanceChecksAtHead =
  | { pinned: false }
  | { pinned: true; acIds: string[]; standings: AcStanding[] }
  | { pinned: true; error: string };

export async function loadAcceptanceChecksAtHead(taskId: string | null | undefined, headSha: string): Promise<AcceptanceChecksAtHead> {
  if (!taskId) return { pinned: false };
  const [task] = await db.select({ id: tasks.id, context: tasks.context }).from(tasks).where(eq(tasks.id, taskId)).limit(1);
  const pin = (task?.context as { specSource?: unknown } | null | undefined)?.specSource;
  if (!task || !pin || typeof pin !== 'object' || typeof (pin as { specId?: unknown }).specId !== 'string') return { pinned: false };
  const { governedOutcomesFor } = await import('@/lib/specs/outcome');
  const outcome = (await governedOutcomesFor([{ id: task.id, context: task.context }], new Map([[task.id, headSha]]))).get(task.id);
  if (!outcome) return { pinned: true, error: 'the pinned spec revision could not be read' };
  const acs = outcome.criteria.filter((c) => /^AC-/.test(c.criterionId));
  return {
    pinned: true,
    acIds: acs.map((c) => c.criterionId),
    standings: acs.map((c) => ({ criterionId: c.criterionId, verdict: c.verdict, source: c.source, headSha: c.headSha })),
  };
}
