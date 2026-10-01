/**
 * The evidence object list that `get_task`, `get_pr` and `explain` carry
 * inline (docs/specs/byo-evidence-storage.md, "Read paths"). Pointers only: id,
 * kind, size and state. The text is read through `read_evidence`; the key lines
 * of a failure already travel in the compact `result.evidence` record.
 *
 * Best-effort by Invariant 5: a storage or database failure here costs the
 * list, never the answer it decorates.
 */
import { db } from '@buildd/core/db';
import { evidenceObjects } from '@buildd/core/db/schema';
import { and, desc, eq, or } from 'drizzle-orm';

export const INLINE_EVIDENCE_LIMIT = 20;

export interface InlineEvidenceObject {
  id: string;
  taskId: string;
  kind: string;
  bytes: number;
  uploadState: string;
  createdAt: string;
}

/** Objects written for `taskId` or, for a root task, its whole retry chain; newest first. */
export async function loadInlineEvidence(workspaceId: string, taskId: string): Promise<InlineEvidenceObject[]> {
  try {
    const rows = await db.query.evidenceObjects.findMany({
      where: and(
        eq(evidenceObjects.workspaceId, workspaceId),
        or(eq(evidenceObjects.taskId, taskId), eq(evidenceObjects.rootTaskId, taskId)),
      ),
      orderBy: [desc(evidenceObjects.createdAt)],
      limit: INLINE_EVIDENCE_LIMIT,
      columns: { id: true, taskId: true, kind: true, bytes: true, uploadState: true, createdAt: true },
    });
    return rows.map((r) => ({
      id: r.id,
      taskId: r.taskId,
      kind: r.kind,
      bytes: r.bytes,
      uploadState: r.uploadState,
      createdAt: new Date(r.createdAt).toISOString(),
    }));
  } catch (err) {
    console.error('[evidence-inline] list failed', err instanceof Error ? err.message : err);
    return [];
  }
}
