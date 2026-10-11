import { db } from '@buildd/core/db';
import { artifactRevisions, artifacts } from '@buildd/core/db/schema';
import { and, eq, type SQL } from 'drizzle-orm';

/**
 * Artifact body history. The artifacts_record_revision trigger appends an
 * immutable artifact_revisions row for every body change and owns
 * `artifacts.current_revision`; this module only reads that history and writes
 * a body under a compare-and-swap so a stale writer cannot overwrite unseen.
 */

export interface ArtifactRevision {
  revision: number;
  content: string | null;
  storageKey: string | null;
  contentHash: string | null;
  sizeBytes: number | null;
  author: string | null;
  createdAt: Date;
}

export async function getArtifactRevision(artifactId: string, revision: number): Promise<ArtifactRevision | null> {
  const [row] = await db
    .select({
      revision: artifactRevisions.revision,
      content: artifactRevisions.content,
      storageKey: artifactRevisions.storageKey,
      contentHash: artifactRevisions.contentHash,
      sizeBytes: artifactRevisions.sizeBytes,
      author: artifactRevisions.author,
      createdAt: artifactRevisions.createdAt,
    })
    .from(artifactRevisions)
    .where(and(eq(artifactRevisions.artifactId, artifactId), eq(artifactRevisions.revision, revision)))
    .limit(1);
  return row ?? null;
}

export type WriteArtifactBodyResult =
  | { ok: true; revision: number; unchanged: boolean; artifact: typeof artifacts.$inferSelect }
  | { ok: false; conflict: true; currentRevision: number }
  | { ok: false; conflict: false };

/**
 * Write an artifact's body (plus any other columns in `also`) in one statement.
 * With `expectedRevision`, the write lands only if the body is still at that
 * revision; otherwise the caller gets the current one to re-read and retry.
 * Without it the write still lands as a new recorded revision, never in place.
 */
export async function writeArtifactBody(
  artifactId: string,
  body: { content: string | null; expectedRevision?: number; author?: string | null },
  also: Record<string, unknown | SQL> = {},
): Promise<WriteArtifactBodyResult> {
  const where = body.expectedRevision === undefined
    ? eq(artifacts.id, artifactId)
    : and(eq(artifacts.id, artifactId), eq(artifacts.currentRevision, body.expectedRevision));
  const [row] = await db
    .update(artifacts)
    .set({ ...also, content: body.content, contentAuthor: body.author ?? null, updatedAt: new Date() })
    .where(where)
    .returning();
  if (row) {
    return { ok: true, revision: row.currentRevision, unchanged: row.currentRevision === body.expectedRevision, artifact: row };
  }
  const [current] = await db
    .select({ currentRevision: artifacts.currentRevision })
    .from(artifacts)
    .where(eq(artifacts.id, artifactId))
    .limit(1);
  return current ? { ok: false, conflict: true, currentRevision: current.currentRevision } : { ok: false, conflict: false };
}
