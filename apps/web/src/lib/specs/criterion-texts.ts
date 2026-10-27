import { db } from '@buildd/core/db';
import { specs } from '@buildd/core/db/schema';
import { and, eq, inArray } from 'drizzle-orm';
import { recordsByRevision } from './criteria';
import { isUuid } from '@/lib/uuid';
import { criterionTextKey } from './criterion-key';

/**
 * The words of each criterion of the given spec revisions, keyed by
 * `criterionTextKey`, in the spec's order. Scoped to one workspace; a spec
 * outside it, or a revision with no readable body, reads as no texts (its
 * criteria are then counted but not named, never shown by id).
 */
export async function loadCriterionTexts(workspaceId: string, pins: readonly { specId: string; revision: number }[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const ids = [...new Set(pins.map(p => p.specId).filter(isUuid))];
  if (ids.length === 0) return out;
  const rows = await db.select({ id: specs.id, bodyArtifactId: specs.bodyArtifactId }).from(specs)
    .where(and(inArray(specs.id, ids), eq(specs.workspaceId, workspaceId)));
  await Promise.all(rows.map(async spec => {
    const revisions = [...new Set(pins.filter(p => p.specId === spec.id).map(p => p.revision))];
    const byRevision = await recordsByRevision(spec, { revisions });
    for (const recs of byRevision.values()) for (const r of recs) out.set(criterionTextKey(spec.id, r.criterionId), r.text);
  }));
  return out;
}
