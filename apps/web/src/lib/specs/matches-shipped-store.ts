import { db } from '@buildd/core/db';
import { specRevisions, tasks } from '@buildd/core/db/schema';
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { specCriteria } from '@buildd/spec-contract/requirements';
import { mergedDeliveryCommits } from '@/lib/workflow/delivery-view';
import { criterionHashes } from './criteria';
import { pinnedReadOf, readPinnedSpecRevisions } from './pin';
import { taskVerdictRows } from './outcome';
import { matchesShipped, type ShippedStanding } from './matches-shipped';

/**
 * What shipped, per waiting spec (Living Spec b7fc9316 R-34): the tasks
 * pinned to the spec, pinned or provisional, whose PR merged, and the
 * verdicts recorded for them (the same rows `manage_specs outcome` folds),
 * judged against the head's criteria by ./matches-shipped.ts.
 *
 * Read-only and best effort: a failed read leaves the spec out of the map, so
 * its row carries no label rather than a wrong one.
 */
export async function shippedStandings(
  heads: ReadonlyArray<{ specId: string; headRevision: number }>,
): Promise<Map<string, ShippedStanding>> {
  const out = new Map<string, ShippedStanding>();
  if (!heads.length) return out;
  try {
    const ids = [...new Set(heads.map((h) => h.specId))];
    const pinned = await db.select({ id: tasks.id, specId: sql<string>`${tasks.context}->'specSource'->>'specId'` }).from(tasks)
      .where(inArray(sql`${tasks.context}->'specSource'->>'specId'`, ids));
    if (!pinned.length) return out;
    const taskSpec = new Map(pinned.map((t) => [t.id, t.specId]));
    const merged = (await mergedDeliveryCommits(pinned.map((t) => t.id))).filter((m) => m.mergeCommitSha);
    if (!merged.length) return out;

    const mergedTaskIds = merged.map((m) => m.ownerTaskId);
    const [verdicts, headRows] = await Promise.all([
      taskVerdictRows(mergedTaskIds),
      db.select({ id: specRevisions.id, specId: specRevisions.specId, revision: specRevisions.revision, contentHash: specRevisions.contentHash })
        .from(specRevisions)
        .where(or(...heads.map((h) => and(eq(specRevisions.specId, h.specId), eq(specRevisions.revision, h.headRevision))))),
    ]);
    const bodies = await readPinnedSpecRevisions(headRows.map((r) => ({ specId: r.specId, specRevisionId: r.id, contentHash: r.contentHash })));

    for (const r of headRows) {
      const read = pinnedReadOf(bodies, { specId: r.specId, specRevisionId: r.id, contentHash: r.contentHash });
      if (!read?.ok) continue;
      const hashes = criterionHashes(read.body);
      const criteria = specCriteria(read.body).flatMap((c) => (hashes.has(c.id) ? [{ id: c.id, textHash: hashes.get(c.id)! }] : []));
      const merges = merged.filter((m) => taskSpec.get(m.ownerTaskId) === r.specId).map((m) => ({ taskId: m.ownerTaskId, mergeSha: m.mergeCommitSha! }));
      if (!merges.length) continue;
      out.set(r.specId, matchesShipped({ criteria, merges, verdicts: verdicts.filter((v) => merges.some((m) => m.taskId === v.taskId)) as never }));
    }
  } catch (err) {
    console.error('[spec-shipped] could not read what shipped:', err);
  }
  return out;
}
