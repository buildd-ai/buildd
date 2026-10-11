import { db } from '@buildd/core/db';
import { artifactLinks, artifactRevisions, artifacts, specs } from '@buildd/core/db/schema';
import { and, eq, isNull, lt, sql } from 'drizzle-orm';
import { deleteObject, headObject, sha256Object } from '@/lib/storage';

/**
 * An uploaded file is ready only once its bytes are verified. The presigned
 * URL (POST /api/artifacts/upload-url) creates the row as `pending`; finalize
 * checks the stored object's size against the size the URL was signed for,
 * hashes it, writes the hash onto its revision (the one change the revision
 * immutability trigger allows), and marks it `ready`. A size, content-type
 * or hash mismatch marks it `failed`. The URL signs only content-length, so
 * the content type is checked here rather than at the PUT.
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

/** `Text/Plain; charset=utf-8` -> `text/plain`: storage may normalize case and parameters. */
function mediaType(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.split(';')[0]!.trim().toLowerCase();
  return t || null;
}

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
  const signedType = mediaType((row.metadata as { mimeType?: unknown } | null)?.mimeType);
  const storedType = mediaType(head.contentType);
  if (signedType && storedType && signedType !== storedType) {
    return markFailed(row.id, `content_type_mismatch: signed for ${signedType}, stored ${storedType}`);
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
 * A row something still refers to (a typed link, or a spec whose body it is)
 * is never deleted: it is skipped, and its object stays.
 *
 * A chat upload (lib/artifact-chat-files.ts) is sent by linking it to its
 * message, so one still unlinked past STALE_UPLOAD_MS was never sent: it goes
 * whatever its state, ready included.
 */
export async function sweepStaleUploads(now: Date = new Date(), storage: UploadStorage = defaultUploadStorage, limit = 100): Promise<{ finalized: number; removed: number; waiting: number }> {
  // Checked again in the DELETE itself: a link made after selection still saves the row.
  const unreferenced = and(
    sql`NOT EXISTS (SELECT 1 FROM ${artifactLinks} WHERE ${artifactLinks.artifactId} = ${artifacts.id})`,
    sql`NOT EXISTS (SELECT 1 FROM ${specs} WHERE ${specs.bodyArtifactId} = ${artifacts.id})`,
  );
  const unsentChatUpload = sql`(${artifacts.uploadState} = 'ready' AND ${artifacts.workspaceId} IS NULL AND ${artifacts.metadata} #>> '{chatAttachment,source}' = 'upload')`;
  const sweepable = sql`(${artifacts.uploadState} in ('pending', 'failed') OR ${unsentChatUpload})`;
  const rows = await db
    .select({ id: artifacts.id, storageKey: artifacts.storageKey, uploadState: artifacts.uploadState, createdAt: artifacts.createdAt })
    .from(artifacts)
    .where(and(
      sweepable,
      lt(artifacts.createdAt, new Date(now.getTime() - SWEEP_GRACE_MS)),
      unreferenced,
    ))
    .limit(limit);
  let finalized = 0, removed = 0, waiting = 0;
  for (const r of rows) {
    const stale = now.getTime() - r.createdAt.getTime() >= STALE_UPLOAD_MS;
    if (r.uploadState === 'ready') {
      // An unsent chat upload: nothing to finalize, it only waits out its time.
      if (!stale) { waiting++; continue; }
    } else {
      const result = r.uploadState === 'pending' ? await finalizeArtifactUpload(r.id, { storage }) : { state: 'failed' as const };
      if (result.state === 'ready') { finalized++; continue; }
      if (!stale) { waiting++; continue; }
    }
    const gone = await db.delete(artifacts)
      .where(and(eq(artifacts.id, r.id), sweepable, unreferenced))
      .returning({ id: artifacts.id });
    if (gone.length === 0) continue;
    if (r.storageKey) await storage.remove(r.storageKey).catch(() => {});
    removed++;
  }
  return { finalized, removed, waiting };
}
