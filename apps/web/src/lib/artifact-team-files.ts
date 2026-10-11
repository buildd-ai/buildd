/**
 * A deleted team's stored files go with it (docs/specs/artifacts-and-sharing.md §11).
 * Deleting a team cascades its workspaces, their workers and every artifact row
 * under them, but a row's stored object (an upload, a screenshot, any artifact
 * with a storage key) is not a row: the cascade leaves it in the bucket with
 * nothing pointing at it, and no sweep could ever find it again.
 *
 * So the team delete runs in one batch (one transaction) with a detach: every
 * artifact of the team's workspaces that has a stored object is moved out of
 * the cascade's way first (workspace, worker, mission and initiative cleared,
 * made private and unshared, and marked `storageOrphan` with the team id).
 * A detached row has no workspace and is no chat attachment, so no reader can
 * reach it (the artifact routes 404 or 403 a workspace-less row). It is the
 * durable list of what to remove: the same request then deletes each row and
 * its object, and whatever a crash leaves behind the maintenance sweep takes.
 * If the team delete fails, the batch rolls back and nothing was detached.
 *
 * An object is removed only after its row is gone, and only when no other
 * artifact row still holds the same storage key.
 */
import { db } from '@buildd/core/db';
import { artifacts, specs, workers, workspaces } from '@buildd/core/db/schema';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { defaultUploadStorage, type UploadStorage } from '@/lib/artifact-upload';

const detached = sql`(${artifacts.workspaceId} IS NULL AND ${artifacts.workerId} IS NULL AND ${artifacts.metadata} ? 'storageOrphan')`;

/**
 * The detach, as one statement for a `db.batch([detachTeamStoredFiles(id), deleteTeam])`.
 * Spec bodies are never detached: a spec owns its body and goes with its workspace.
 */
export function detachTeamStoredFiles(teamId: string, now: Date = new Date()) {
  const teamWorkspaces = db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.teamId, teamId));
  const teamWorkers = db.select({ id: workers.id }).from(workers).where(inArray(workers.workspaceId, teamWorkspaces));
  return db.update(artifacts)
    .set({
      workspaceId: null,
      workerId: null,
      missionId: null,
      initiativeId: null,
      visibility: 'private',
      shareToken: null,
      metadata: sql`coalesce(${artifacts.metadata}, '{}'::jsonb) || ${JSON.stringify({ storageOrphan: { teamId, at: now.toISOString() } })}::jsonb`,
    })
    .where(and(
      sql`${artifacts.storageKey} IS NOT NULL`,
      sql`(${inArray(artifacts.workspaceId, teamWorkspaces)} OR ${inArray(artifacts.workerId, teamWorkers)})`,
      sql`NOT EXISTS (SELECT 1 FROM ${specs} WHERE ${specs.bodyArtifactId} = ${artifacts.id})`,
    ));
}

export interface TeamFileCleanup { removed: number; objectsRemoved: number }

/**
 * Remove detached rows and their stored objects, at most `limit` per call.
 * `teamId` narrows it to one deletion; without it it is the maintenance sweep.
 */
export async function removeDetachedTeamFiles(opts: { teamId?: string; limit?: number; storage?: UploadStorage } = {}): Promise<TeamFileCleanup> {
  const storage = opts.storage ?? defaultUploadStorage;
  const where = and(
    detached,
    opts.teamId ? sql`${artifacts.metadata} #>> '{storageOrphan,teamId}' = ${opts.teamId}` : undefined,
  );
  const rows = await db.select({ id: artifacts.id }).from(artifacts).where(where).limit(opts.limit ?? 200);
  let removed = 0, objectsRemoved = 0;
  for (const r of rows) {
    const gone = await db.delete(artifacts)
      .where(and(eq(artifacts.id, r.id), where))
      .returning({ storageKey: artifacts.storageKey });
    if (gone.length === 0) continue;
    removed++;
    const key = gone[0]!.storageKey;
    if (!key) continue;
    const shared = await db.select({ id: artifacts.id }).from(artifacts).where(eq(artifacts.storageKey, key)).limit(1);
    if (shared.length > 0) continue;
    await storage.remove(key).then(() => { objectsRemoved++; }, (err) => {
      console.error('[team-files] stored object not removed', err instanceof Error ? err.message : err);
    });
  }
  return { removed, objectsRemoved };
}

/**
 * After a team is deleted: remove its detached files in the same request, in
 * bounded batches. Never throws; anything left is the maintenance sweep's.
 */
export async function removeTeamStoredFiles(teamId: string, opts: { storage?: UploadStorage; batches?: number } = {}): Promise<TeamFileCleanup> {
  const total: TeamFileCleanup = { removed: 0, objectsRemoved: 0 };
  const limit = 200;
  try {
    for (let i = 0; i < (opts.batches ?? 10); i++) {
      const r = await removeDetachedTeamFiles({ teamId, limit, storage: opts.storage });
      total.removed += r.removed;
      total.objectsRemoved += r.objectsRemoved;
      if (r.removed < limit) break;
    }
  } catch (err) {
    console.error('[team-files] team cleanup stopped', err instanceof Error ? err.message : err);
  }
  return total;
}
