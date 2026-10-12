import { db } from '@buildd/core/db';
import { specRevisions, specs, workers } from '@buildd/core/db/schema';
import { and, eq, sql } from 'drizzle-orm';
import { isUuid } from '@/lib/uuid';
import { readPinnedSpecRevision } from './pin';
import { specCriteria } from './requirements';
import { scopeOf } from './scope';

/**
 * Pinning at claim (task 5c0a3f4c). Filing pins the approved revision
 * (lib/specs/pin.ts); work is held to the revision in force when it starts,
 * so the first claim re-pins to whatever is approved then. After that the pin
 * never moves: a task any worker has claimed before, a retry attempt (it
 * carries its parent's pin), a pin already taken at a claim, and a revision
 * the filer named all keep theirs.
 *
 * Returns the new `specSource` for the claim to write with its own context
 * update, so this never writes and costs one indexed read for a task that
 * names a spec, none for one that does not. `null` means keep the context as
 * it is; `reason` says why, for the claim log.
 */
export type ClaimPin = { specSource: Record<string, unknown> | null; reason: string | null };

const asRecord = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

export async function repinSpecAtClaim(task: {
  id: string;
  workspaceId: string;
  context: unknown;
  taskClass?: string | null;
}): Promise<ClaimPin> {
  const src = asRecord(asRecord(task.context)?.specSource);
  const specId = src?.specId;
  if (!src || typeof specId !== 'string') return { specSource: null, reason: null };
  if (!isUuid(specId)) return { specSource: null, reason: 'specSource.specId is not a spec id' };
  if (task.taskClass === 'attempt') return { specSource: null, reason: 'a retry attempt keeps the pin it was filed with' };
  if (src.pinnedAt === 'claim') return { specSource: null, reason: 'pinned at an earlier claim' };
  if (src.explicit === true) return { specSource: null, reason: 'the filer named this revision' };

  const [row] = await db
    .select({
      workspaceId: specs.workspaceId,
      approvedRevision: specs.approvedRevision,
      revId: specRevisions.id,
      revision: specRevisions.revision,
      contentHash: specRevisions.contentHash,
      started: sql<boolean>`exists (select 1 from ${workers} where ${workers.taskId} = ${task.id})`,
    })
    .from(specs)
    .leftJoin(specRevisions, and(eq(specRevisions.specId, specs.id), eq(specRevisions.revision, specs.approvedRevision)))
    .where(eq(specs.id, specId))
    .limit(1);

  if (!row || row.workspaceId !== task.workspaceId) return { specSource: null, reason: 'spec not found in this workspace' };
  if (row.started) return { specSource: null, reason: 'work already started on this pin' };
  if (row.approvedRevision === null || !row.revId || !row.contentHash) {
    return { specSource: null, reason: 'the spec has no approved revision yet; the task keeps what it was filed with' };
  }
  if (row.revId === src.specRevisionId && row.contentHash === src.contentHash) {
    return { specSource: null, reason: 'already pinned to the approved revision' };
  }
  // A task scoped to some criteria moves only when the new revision still has
  // every one of them; otherwise it keeps the revision those ids came from.
  const scope = scopeOf(src);
  if (scope) {
    const read = await readPinnedSpecRevision({ specId, specRevisionId: row.revId, contentHash: row.contentHash });
    const ids = read.ok ? new Set(specCriteria(read.body).map((c) => c.id)) : null;
    const missing = ids ? scope.filter((id) => !ids.has(id)) : scope;
    if (missing.length > 0) {
      return { specSource: null, reason: `approved revision ${row.revision} ${read.ok ? `no longer has ${missing.join(', ')}` : 'could not be read'}; the task keeps revision ${String(src.revision)}` };
    }
  }
  return {
    specSource: {
      ...src,
      specRevisionId: row.revId,
      revision: row.revision,
      contentHash: row.contentHash,
      pinnedAt: 'claim',
      ...(typeof src.revision === 'number' ? { repinnedFrom: src.revision } : {}),
    },
    reason: `re-pinned to approved revision ${row.revision}`,
  };
}
