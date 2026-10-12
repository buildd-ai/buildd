import { db } from '@buildd/core/db';
import { specs } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import type { LivingSpecView } from '@/components/SpecSourceBlock';
import { isUuid } from '@/lib/uuid';
import { readGovernedOutcome, type OutcomeView } from './outcome';
import { scopeOf } from './scope';

/**
 * The Living Spec a task is pinned to, for the task page: its title, the
 * revision approved now, and the governed outcome over the criteria the task
 * answers for. Server-side; the page has already checked the viewer reaches
 * the task. A spec that cannot be read leaves only the pin shown.
 */
export async function loadLivingSpecView(taskId: string, specId: string, pin: unknown): Promise<LivingSpecView | null> {
  if (!isUuid(specId)) return null;
  try {
    const [spec] = await db.select({ title: specs.title, approvedRevision: specs.approvedRevision }).from(specs).where(eq(specs.id, specId)).limit(1);
    if (!spec) return null;
    const read = await readGovernedOutcome(null, taskId);
    return {
      title: spec.title,
      approvedRevision: spec.approvedRevision,
      scoped: scopeOf(pin as Record<string, unknown> | null) !== null,
      outcome: read.ok
        ? {
          outcome: read.outcome.outcome,
          reason: read.outcome.reason,
          criteria: (read.outcome.criteria as ReadonlyArray<OutcomeView['criteria'][number]>).map((c) => ({ criterionId: c.criterionId, text: c.text, verdict: c.verdict, stale: c.stale })),
        }
        : null,
    };
  } catch (err) {
    console.warn(`[task-page] living spec view for task ${taskId} failed:`, err);
    return null;
  }
}

/** The page's entry: the view for a task whose context names a Living Spec, else null without a query. */
export function livingSpecLoad(taskId: string, context: unknown): Promise<LivingSpecView | null> {
  const pin = (context as { specSource?: unknown } | null)?.specSource;
  const specId = pin && typeof pin === 'object' ? (pin as { specId?: unknown }).specId : undefined;
  return typeof specId === 'string' ? loadLivingSpecView(taskId, specId, pin) : Promise.resolve(null);
}
