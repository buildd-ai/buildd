import { db } from '@buildd/core/db';
import { specOutcomeVerdicts, specVerdictSources } from '@buildd/core/db/schema';
import { and, eq, sql } from 'drizzle-orm';
import { determiningVerdict, verdictSourceOfEvidence } from '@buildd/spec-contract/outcome';

/**
 * Keep spec_verdict_sources in step with spec_outcome_verdicts: after a verdict
 * is recorded, name the signal that now decides its criterion (a test result
 * outranks a review, see determiningVerdict) and how many review verdicts that
 * test outranks. The verdict log stays the source of truth and the folds read
 * it directly, so this is best-effort bookkeeping: a failure is logged and
 * never fails the verdict that was just recorded.
 */
export async function settleVerdictSource(verdictId: string): Promise<void> {
  try {
    const [rec] = await db.select({
      workspaceId: specOutcomeVerdicts.workspaceId, taskId: specOutcomeVerdicts.taskId, missionId: specOutcomeVerdicts.missionId,
      specRevisionId: specOutcomeVerdicts.specRevisionId, criterionId: specOutcomeVerdicts.criterionId, textHash: specOutcomeVerdicts.criterionTextHash,
    }).from(specOutcomeVerdicts).where(eq(specOutcomeVerdicts.id, verdictId)).limit(1);
    if (!rec) return;
    const input = rec;
    const task = input.taskId ?? null;
    const mission = input.missionId ?? null;
    const subject = task ? eq(specOutcomeVerdicts.taskId, task) : eq(specOutcomeVerdicts.missionId, mission as string);
    const all = await db.select({
      id: specOutcomeVerdicts.id, verdict: specOutcomeVerdicts.verdict, at: specOutcomeVerdicts.createdAt,
      textHash: specOutcomeVerdicts.criterionTextHash, evidence: specOutcomeVerdicts.evidence,
    }).from(specOutcomeVerdicts)
      .where(and(subject, eq(specOutcomeVerdicts.specRevisionId, input.specRevisionId), eq(specOutcomeVerdicts.criterionId, input.criterionId)));
    // Same rule as the folds: a verdict on another wording does not count.
    const rows = all
      .filter((r) => !r.textHash || r.textHash === input.textHash)
      .map((r) => ({ ...r, source: verdictSourceOfEvidence(r.evidence) }));
    const decided = determiningVerdict(rows);
    if (!decided) return;
    const overriddenReviews = decided.source === 'test' ? rows.filter((r) => r.source === 'review').length : 0;
    const values = {
      workspaceId: input.workspaceId, taskId: task, missionId: mission, specRevisionId: input.specRevisionId, criterionId: input.criterionId,
      source: decided.source, verdictId: decided.id, verdict: decided.verdict, overriddenReviews,
    };
    const set = { source: decided.source, verdictId: decided.id, verdict: decided.verdict, overriddenReviews, decidedAt: sql`now()` };
    if (task) {
      await db.insert(specVerdictSources).values(values).onConflictDoUpdate({
        target: [specVerdictSources.taskId, specVerdictSources.specRevisionId, specVerdictSources.criterionId],
        targetWhere: sql`task_id IS NOT NULL`, set,
      });
    } else {
      await db.insert(specVerdictSources).values(values).onConflictDoUpdate({
        target: [specVerdictSources.missionId, specVerdictSources.specRevisionId, specVerdictSources.criterionId],
        targetWhere: sql`mission_id IS NOT NULL`, set,
      });
    }
  } catch (err) {
    console.error('[verdict-source] could not settle the deciding source', err instanceof Error ? err.message : err);
  }
}
