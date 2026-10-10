import { db } from '@buildd/core/db';
import { artifactRevisions, artifacts } from '@buildd/core/db/schema';
import { and, eq, isNull, lt, sql } from 'drizzle-orm';
import { deleteObject, headObject, sha256Object } from '@/lib/storage';

/**
 * An uploaded file is ready only once its bytes are verified. The presigned
 * URL (POST /api/artifacts/upload-url) creates the row as `pending`; finalize
 * checks the stored object's size against the size the URL was signed for,
 * hashes it, writes the hash onto its revision (the one change the revision
 * immutability trigger allows), and marks it `ready`. A size or hash mismatch
 * marks it `failed`.
 *
 * Callers that never finalize (an agent that PUT with curl, the runner's
 * screenshot upload) still work: a read finalizes lazily, and the sweep
 * finalizes anything uploaded and deletes only what never arrived.
 */

export interface UploadStorage {
  head(key: string): Promise<{ sizeBytes: number; contentType: string | null } | null>;
  sha256(key: string): Promise<{ sha256: string; sizeBytes: number }>;
  remove(key: string): Promise<void>;
}
export const defaultUploadStorage: UploadStorage = { head: headObject, sha256: sha256Object, remove: deleteObject };

export type FinalizeResult =
  | { state: 'ready'; sha256: string | null; sizeBytes: number | null }
  | { state: 'pending'; reason: 'not_uploaded' }
  | { state: 'failed'; reason: string }
  | { state: 'missing' };

/** Pending uploads older than this are finalized or removed by the sweep. */
export const STALE_UPLOAD_MS = 24 * 60 * 60 * 1000;
/** The sweep leaves an upload this young to its uploader. */
export const SWEEP_GRACE_MS = 60 * 1000;

async function markFailed(id: string, reason: string): Promise<FinalizeResult> {
  await db.update(artifacts)
    .set({ uploadState: 'failed', metadata: sql`coalesce(${artifacts.metadata}, '{}'::jsonb) || ${JSON.stringify({ uploadError: reason })}::jsonb` })
    .where(and(eq(artifacts.id, id), eq(artifacts.uploadState, 'pending')));
  return { state: 'failed', reason };
}

export async function finalizeArtifactUpload(
  artifactId: string,
  opts: { expectedSha256?: string | null; storage?: UploadStorage } = {},
): Promise<FinalizeResult> {
  const storage = opts.storage ?? defaultUploadStorage;
  const [row] = await db
    .select({ id: artifacts.id, storageKey: artifacts.storageKey, uploadState: artifacts.uploadState, currentRevision: artifacts.currentRevision, metadata: artifacts.metadata })
    .from(artifacts)
    .where(eq(artifacts.id, artifactId))
    .limit(1);
  if (!row) return { state: 'missing' };

  const revisionHash = async () => {
    const [rev] = await db
      .select({ contentHash: artifactRevisions.contentHash, sizeBytes: artifactRevisions.sizeBytes })
      .from(artifactRevisions)
      .where(and(eq(artifactRevisions.artifactId, row.id), eq(artifactRevisions.revision, row.currentRevision)))
      .limit(1);
    return { sha256: rev?.contentHash ?? null, sizeBytes: rev?.sizeBytes ?? null };
  };
  if (row.uploadState === 'failed') return { state: 'failed', reason: String((row.metadata as { uploadError?: unknown } | null)?.uploadError ?? 'failed') };
  if (row.uploadState !== 'pending' || !row.storageKey) return { state: 'ready', ...(await revisionHash()) };

  const head = await storage.head(row.storageKey);
  if (!head) return { state: 'pending', reason: 'not_uploaded' };
  const signedFor = Number((row.metadata as { sizeBytes?: unknown } | null)?.sizeBytes);
  if (Number.isFinite(signedFor) && head.sizeBytes !== signedFor) {
    return markFailed(row.id, `size_mismatch: signed for ${signedFor} bytes, stored ${head.sizeBytes}`);
  }
  const { sha256, sizeBytes } = await storage.sha256(row.storageKey);
  if (opts.expectedSha256 && opts.expectedSha256.toLowerCase() !== sha256) {
    return markFailed(row.id, 'sha256_mismatch: the stored bytes do not match the hash the uploader sent');
  }
  // Fill the revision's hash once (the immutability trigger allows NULL -> value only).
  await db.update(artifactRevisions)
    .set({ contentHash: sha256, sizeBytes })
    .where(and(eq(artifactRevisions.artifactId, row.id), eq(artifactRevisions.revision, row.currentRevision), isNull(artifactRevisions.contentHash)));
  await db.update(artifacts)
    .set({ uploadState: 'ready' })
    .where(and(eq(artifacts.id, row.id), eq(artifacts.uploadState, 'pending')));
  return { state: 'ready', sha256, sizeBytes };
}

/**
 * Finalize uploads their uploader never finalized, and remove what never
 * arrived: a pending row past STALE_UPLOAD_MS whose object is missing, or any
 * failed row past it (and its object). An uploaded, matching object is kept.
 */
export async function sweepStaleUploads(now: Date = new Date(), storage: UploadStorage = defaultUploadStorage, limit = 100): Promise<{ finalized: number; removed: number; waiting: number }> {
  const rows = await db
    .select({ id: artifacts.id, storageKey: artifacts.storageKey, uploadState: artifacts.uploadState, createdAt: artifacts.createdAt })
    .from(artifacts)
    .where(and(
      sql`${artifacts.uploadState} in ('pending', 'failed')`,
      lt(artifacts.createdAt, new Date(now.getTime() - SWEEP_GRACE_MS)),
    ))
    .limit(limit);
  let finalized = 0, removed = 0, waiting = 0;
  for (const r of rows) {
    const result = r.uploadState === 'pending' ? await finalizeArtifactUpload(r.id, { storage }) : { state: 'failed' as const };
    if (result.state === 'ready') { finalized++; continue; }
    if (now.getTime() - r.createdAt.getTime() < STALE_UPLOAD_MS) { waiting++; continue; }
    if (r.storageKey) await storage.remove(r.storageKey).catch(() => {});
    await db.delete(artifacts).where(and(eq(artifacts.id, r.id), sql`${artifacts.uploadState} in ('pending', 'failed')`));
    removed++;
  }
  return { finalized, removed, waiting };
}
