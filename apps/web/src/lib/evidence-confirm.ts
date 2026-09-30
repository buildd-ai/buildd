/**
 * Confirming a runner's evidence upload (docs/specs/byo-evidence-storage.md,
 * "Postgres pointers", "Failure behaviour").
 *
 * The upload route inserts a row with `upload_state = pending` and hands the
 * runner a presigned PUT. Nothing in that PUT reaches the server, so the row
 * stays `pending` until someone checks the bucket. This is that check, and the
 * only place a `pending` row changes:
 *
 *   - the object exists with exactly the signed size → `stored` (bytes = its
 *     ContentLength), and the read routes and indexer will serve it;
 *   - the object is missing, or its size differs from the signed size → `failed`;
 *   - the row's backend no longer exists → `unreadable`;
 *   - the bucket cannot be checked right now → left `pending` for a later try.
 *
 * Callers: `POST /api/workers/[id]/evidence/[evidenceId]/confirm` (the runner,
 * right after a 2xx PUT) and the evidence indexer's reaper, for rows whose
 * confirm never came. The write only moves a row that is still `pending`, so the
 * two can race harmlessly. Never throws.
 */
import { HeadObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { and, eq } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { evidenceObjects } from '@buildd/core/db/schema';
import { EvidenceReadError, evidenceObjectLocation, type EvidenceObjectRow } from './evidence-read';

export type EvidenceUploadState = EvidenceObjectRow['uploadState'];

export interface EvidenceConfirmResult {
  uploadState: EvidenceUploadState;
  bytes: number;
  /** True when this call moved the row out of `pending`. */
  changed: boolean;
  reason?: string;
}

export interface ConfirmDeps {
  /** Test seam: the client and bucket for the row's backend. */
  locate?: (row: EvidenceObjectRow) => Promise<{ client: Pick<S3Client, 'send'>; bucket: string }>;
}

function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } } | null;
  return e?.$metadata?.httpStatusCode === 404 || e?.name === 'NotFound' || e?.name === 'NoSuchKey';
}

async function settle(
  row: EvidenceObjectRow,
  uploadState: 'stored' | 'failed' | 'unreadable',
  bytes: number,
  reason?: string,
): Promise<EvidenceConfirmResult> {
  const withReason = <T extends EvidenceConfirmResult>(r: T): T => (reason ? { ...r, reason } : r);
  try {
    const moved = await db.update(evidenceObjects)
      .set({
        uploadState,
        bytes,
        // An object that is not in the bucket has nothing to index.
        ...(uploadState === 'stored' ? {} : { indexState: 'skipped' as const }),
        updatedAt: new Date(),
      })
      .where(and(eq(evidenceObjects.id, row.id), eq(evidenceObjects.uploadState, 'pending')))
      .returning({ uploadState: evidenceObjects.uploadState, bytes: evidenceObjects.bytes });
    if (moved.length > 0) return withReason({ uploadState, bytes, changed: true });

    // Someone else settled it first; report what they decided.
    const now = await db.query.evidenceObjects.findFirst({
      where: eq(evidenceObjects.id, row.id),
      columns: { uploadState: true, bytes: true },
    });
    if (!now) return { uploadState: row.uploadState, bytes: row.bytes, changed: false, reason: 'the evidence row no longer exists' };
    return { uploadState: now.uploadState, bytes: now.bytes, changed: false };
  } catch (err) {
    return {
      uploadState: row.uploadState,
      bytes: row.bytes,
      changed: false,
      reason: `could not record the result: ${err instanceof Error ? err.message : 'unknown error'}`.slice(0, 300),
    };
  }
}

export async function confirmEvidenceUpload(row: EvidenceObjectRow, deps: ConfirmDeps = {}): Promise<EvidenceConfirmResult> {
  if (row.uploadState !== 'pending') {
    return { uploadState: row.uploadState, bytes: row.bytes, changed: false };
  }

  let location: { client: Pick<S3Client, 'send'>; bucket: string };
  try {
    location = await (deps.locate ?? evidenceObjectLocation)(row);
  } catch (err) {
    if (err instanceof EvidenceReadError && err.status === 410) {
      return settle(row, 'unreadable', row.bytes, err.message);
    }
    return { uploadState: 'pending', bytes: row.bytes, changed: false, reason: 'the storage backend cannot be reached' };
  }

  let size: number;
  try {
    const head = await location.client.send(new HeadObjectCommand({ Bucket: location.bucket, Key: row.objectKey }));
    size = Number((head as { ContentLength?: unknown }).ContentLength);
  } catch (err) {
    if (isNotFound(err)) return settle(row, 'failed', row.bytes, 'the object was never uploaded');
    return { uploadState: 'pending', bytes: row.bytes, changed: false, reason: 'the storage backend could not be checked' };
  }

  // The signature binds the length, so a different size is not this upload.
  if (!Number.isSafeInteger(size) || size !== row.bytes) {
    return settle(row, 'failed', row.bytes, `the stored object is ${Number.isFinite(size) ? size : 'of unknown size'} bytes, not the signed ${row.bytes}`);
  }
  return settle(row, 'stored', size);
}
