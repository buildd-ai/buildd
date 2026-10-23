/**
 * Activity's verification claims, read server-side (spec 9430a28f R-6): the
 * governed outcome of each pinned task in view, through the same reader the
 * spec page's Delivery and verification section uses (`governedOutcomesFor`),
 * with the PR head from the delivery views the loader already read. A task
 * whose pin does not resolve gets no claim; nothing is inferred from its PR.
 */
import { db } from '@buildd/core/db';
import { specs } from '@buildd/core/db/schema';
import { inArray } from 'drizzle-orm';
import { governedOutcomesFor, taskVerdictRows } from './specs/outcome';
import { verificationClaim, type VerificationClaim } from './activity-verification';

export interface PinnedRoot { id: string; specSource: unknown }

export async function readVerificationClaims(
  roots: readonly PinnedRoot[],
  views: ReadonlyMap<string, { headSha?: string | null }>,
): Promise<Map<string, VerificationClaim>> {
  const out = new Map<string, VerificationClaim>();
  if (roots.length === 0) return out;
  const ids = roots.map(r => r.id);
  const verdicts = await taskVerdictRows(ids);
  const heads = new Map(ids.map(id => [id, views.get(id)?.headSha ?? null]));
  const outcomes = await governedOutcomesFor(roots.map(r => ({ id: r.id, context: { specSource: r.specSource } })), heads, verdicts);
  const specIds = [...new Set([...outcomes.values()].map(o => o.specId))];
  if (specIds.length === 0) return out;
  const specRows = await db.select({ id: specs.id, title: specs.title, approvedRevision: specs.approvedRevision }).from(specs).where(inArray(specs.id, specIds));
  const specById = new Map(specRows.map(s => [s.id, s]));
  for (const [taskId, o] of outcomes) {
    const spec = specById.get(o.specId);
    if (!spec) continue;
    // When the newest verdict on this pin was recorded: History's verification step.
    const times = verdicts.filter(v => v.taskId === taskId && v.specRevisionId === o.specRevisionId).map(v => new Date(v.at).getTime());
    out.set(taskId, verificationClaim(
      { specId: o.specId, revision: o.revision, outcome: o.outcome, currentHeadSha: o.currentHeadSha, criteria: o.criteria },
      { title: spec.title, approvedRevision: spec.approvedRevision ?? null },
      times.length > 0 ? Math.max(...times) : null,
    ));
  }
  return out;
}
