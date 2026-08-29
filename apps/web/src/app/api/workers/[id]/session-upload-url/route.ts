import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { workers } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { authenticateApiKey } from '@/lib/api-auth';
import { isStorageConfigured, generateConstrainedUploadUrl, objectExists } from '@/lib/storage';
import {
  MAX_SESSION_ARTIFACT_BYTES,
  SESSION_ARTIFACT_FILES,
  isSessionArtifactKind,
  sessionArtifactKey,
} from '@/lib/session-artifact-keys';

/**
 * POST /api/workers/[id]/session-upload-url
 *
 * Issues a presigned PUT so a runner can ship a session transcript / session log
 * straight to object storage. Diagnostics only — never a task-failure path.
 *
 * Security model:
 *  1. The runner holds no storage credentials; it authenticates with its existing
 *     buildd API key and receives a short-lived signature. Bytes never transit here.
 *  2. The object key is derived server-side from the authenticated worker row.
 *     Any `key` / `storageKey` in the request body is ignored outright.
 *  3. Authorization precedes signing: the caller's account must own the worker and
 *     share its team. That single indexed SELECT is the ONLY Neon traffic this
 *     feature adds — no new table, no per-message rows, no index row (the key is
 *     deterministic from workers.id, which Neon already stores).
 *  4. The byte ceiling is bound into the signature (see generateConstrainedUploadUrl),
 *     not merely checked here.
 *  5. Sensitive workspaces are refused at signing time, so shipping transcripts is
 *     never the runner's decision to make.
 *  6. Keys are write-once: an existing object is never re-signed.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  const account = await authenticateApiKey(apiKey);

  if (!account) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (!isStorageConfigured()) {
    return NextResponse.json({ error: 'Storage not configured' }, { status: 503 });
  }

  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  // NOTE: body.key / body.storageKey are deliberately NOT read. The key is ours.
  const { kind, sizeBytes } = body as { kind?: unknown; sizeBytes?: unknown };

  if (!isSessionArtifactKind(kind)) {
    return NextResponse.json(
      { error: `kind must be one of: transcript, session-log` },
      { status: 400 }
    );
  }

  if (typeof sizeBytes !== 'number' || !Number.isInteger(sizeBytes) || sizeBytes <= 0) {
    return NextResponse.json({ error: 'sizeBytes must be a positive integer' }, { status: 400 });
  }

  if (sizeBytes > MAX_SESSION_ARTIFACT_BYTES) {
    return NextResponse.json(
      { error: `Session artifact exceeds ${MAX_SESSION_ARTIFACT_BYTES} byte limit`, maxBytes: MAX_SESSION_ARTIFACT_BYTES },
      { status: 413 }
    );
  }

  // The one unavoidable lookup: authorization + data class + team, in a single
  // relational query (one round trip, workers.id is the primary key).
  const worker = await db.query.workers.findFirst({
    where: eq(workers.id, id),
    columns: { id: true, accountId: true, workspaceId: true },
    with: { workspace: { columns: { teamId: true, dataClass: true } } },
  });

  if (!worker) {
    return NextResponse.json({ error: 'Worker not found' }, { status: 404 });
  }

  if (!worker.accountId || worker.accountId !== account.id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const workspace = worker.workspace;
  if (!worker.workspaceId || !workspace?.teamId || workspace.teamId !== account.teamId) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  // Data class: transcripts are the highest-risk payload in the system. Sensitive
  // workspace content must not leave the runner at all.
  if (workspace.dataClass === 'sensitive') {
    return NextResponse.json(
      { error: 'Session diagnostics upload is not permitted for sensitive workspaces' },
      { status: 403 }
    );
  }

  const storageKey = sessionArtifactKey({
    teamId: workspace.teamId,
    workspaceId: worker.workspaceId,
    workerId: worker.id,
    kind,
  });

  // Write-once. A compromised runner must not be able to rewrite history for a
  // worker it already reported on. Fail closed if we cannot prove absence.
  try {
    if (await objectExists(storageKey)) {
      return NextResponse.json(
        { error: 'Session diagnostics already uploaded for this worker', storageKey },
        { status: 409 }
      );
    }
  } catch {
    return NextResponse.json({ error: 'Storage unavailable' }, { status: 503 });
  }

  const { contentType } = SESSION_ARTIFACT_FILES[kind];
  const uploadUrl = await generateConstrainedUploadUrl(storageKey, contentType, sizeBytes);

  return NextResponse.json({
    uploadUrl,
    storageKey,
    contentType,
    contentLength: sizeBytes,
    maxBytes: MAX_SESSION_ARTIFACT_BYTES,
  });
}
