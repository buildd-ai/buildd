/**
 * The evidence object list that `get_task`, `get_pr` and `explain` carry
 * inline (docs/specs/byo-evidence-storage.md, "Read paths"). Pointers only: id,
 * kind, size and state. The text is read through `read_evidence`; the key lines
 * of a failure already travel in the compact `result.evidence` record.
 *
 * Best-effort by Invariant 5: a storage or database failure here costs the
 * list, never the answer it decorates.
 *
 * Reach is the caller's job: every caller has already decided the actor can
 * read this task's workspace. Each non-empty list writes one `[evidence-read]`
 * audit line, as the read routes do.
 */
import { db } from '@buildd/core/db';
import { evidenceObjects } from '@buildd/core/db/schema';
import { and, desc, eq, or } from 'drizzle-orm';
import { auditEvidenceRead, type EvidenceActor } from '@/lib/evidence-audit';

export const INLINE_EVIDENCE_LIMIT = 20;

export interface InlineEvidenceObject {
  id: string;
  taskId: string;
  kind: string;
  bytes: number;
  uploadState: string;
  createdAt: string;
}

export interface InlineEvidenceContext {
  surface: 'get_task' | 'get_pr' | 'explain';
  actor: EvidenceActor;
}

/**
 * Objects written for `taskId` plus, when `taskId` is a root, its descendants';
 * newest first. A retry child does not see its root's runs.
 */
export async function loadInlineEvidence(
  workspaceId: string,
  taskId: string,
  ctx: InlineEvidenceContext,
): Promise<InlineEvidenceObject[]> {
  let list: InlineEvidenceObject[];
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
    // The predicate matches on task lineage, so task_id is set on every row
    // (the one-owner CHECK); the filter only narrows the type.
    list = rows.flatMap((r) => (r.taskId ? [{
      id: r.id,
      taskId: r.taskId,
      kind: r.kind,
      bytes: r.bytes,
      uploadState: r.uploadState,
      createdAt: new Date(r.createdAt).toISOString(),
    }] : []));
  } catch (err) {
    console.error('[evidence-inline] list failed', err instanceof Error ? err.message : err);
    return [];
  }
  if (list.length > 0) {
    auditEvidenceRead({
      surface: ctx.surface,
      op: 'list',
      workspaceId,
      taskId,
      evidenceIds: list.map((o) => o.id),
      actor: ctx.actor,
    });
  }
  return list;
}
