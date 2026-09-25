import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { workers, artifacts, workspaces, tasks, missions } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { authenticateApiKey } from '@/lib/api-auth';
import { isStorageConfigured, generateSizedUploadUrl } from '@/lib/storage';
import { buildArtifactKey } from '@/lib/storage-keys';
import { ARTIFACT_TYPES, ArtifactType, isArtifactType } from '@buildd/shared';
import { appBaseUrl } from '@/lib/app-url';

/**
 * Ceiling for a single artifact upload, enforced in the signature.
 *
 * 50MB is the limit this endpoint has always advertised, so nothing that works
 * today stops working; the change is that the value is now bound into the
 * presigned PUT instead of only being compared against a self-reported number.
 * Artifacts are agent deliverables — reports, logs, screenshots, small data
 * exports — and R2 egress is billed, so the ceiling stays where the product
 * contract already put it rather than being raised speculatively.
 */
export const MAX_ARTIFACT_UPLOAD_BYTES = 50 * 1024 * 1024; // 50MB

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// POST /api/artifacts/upload-url - Get a presigned upload URL and create artifact record
export async function POST(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  const account = await authenticateApiKey(apiKey);

  if (!account) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (!isStorageConfigured()) {
    return NextResponse.json({ error: 'Storage not configured' }, { status: 503 });
  }

  const body = await req.json();
  const { workerId, filename, mimeType, sizeBytes, title, type, metadata, missionId } = body as {
    workerId: string;
    missionId?: string | null;
    filename: string;
    mimeType: string;
    sizeBytes: number;
    title?: string;
    type?: string;
    metadata?: Record<string, unknown>;
  };

  if (!workerId || !filename || !mimeType || sizeBytes === undefined || sizeBytes === null) {
    return NextResponse.json(
      { error: 'workerId, filename, mimeType, and sizeBytes are required' },
      { status: 400 }
    );
  }

  // The declared size is signed into the upload grant, so it has to be a real
  // byte count before we can sign anything with it.
  if (typeof sizeBytes !== 'number' || !Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) {
    return NextResponse.json(
      { error: 'sizeBytes must be a positive integer' },
      { status: 400 }
    );
  }

  if (type !== undefined && type !== null && type !== '' && !isArtifactType(type)) {
    return NextResponse.json(
      { error: `Invalid type. Must be one of: ${ARTIFACT_TYPES.join(', ')}` },
      { status: 400 }
    );
  }

  if (sizeBytes > MAX_ARTIFACT_UPLOAD_BYTES) {
    return NextResponse.json(
      { error: `File exceeds ${MAX_ARTIFACT_UPLOAD_BYTES / (1024 * 1024)}MB limit` },
      { status: 413 }
    );
  }

  const worker = await db.query.workers.findFirst({
    where: eq(workers.id, workerId),
  });

  if (!worker) {
    return NextResponse.json({ error: 'Worker not found' }, { status: 404 });
  }

  if (worker.accountId !== account.id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  // Sensitive workspaces: block R2 uploads entirely (content must not leave the runner)
  if (worker.workspaceId) {
    const wsRow = await db.query.workspaces.findFirst({
      where: eq(workspaces.id, worker.workspaceId),
      columns: { dataClass: true },
    });
    if (wsRow?.dataClass === 'sensitive') {
      return NextResponse.json(
        { error: 'Content upload is not permitted for sensitive workspaces' },
        { status: 403 }
      );
    }
  }

  // The workspace id is the tenant segment of the key; without one there is no
  // prefix to scope the upload to.
  if (!worker.workspaceId) {
    return NextResponse.json(
      { error: 'Worker is not associated with a workspace' },
      { status: 400 }
    );
  }

  // Mission scoping, so a mission page can find the artifact (e.g. a visual
  // audit's screenshots). Default: the worker's own task's mission, decided
  // here rather than trusted from the client. An explicit value must be a
  // mission in the worker's workspace and, when the task has a mission, that
  // same one: a worker can't file artifacts into someone else's mission.
  if (missionId !== undefined && missionId !== null && (typeof missionId !== 'string' || !UUID_RE.test(missionId))) {
    return NextResponse.json({ error: 'missionId must be a uuid' }, { status: 400 });
  }
  const linkedTask = worker.taskId
    ? await db.query.tasks.findFirst({
        where: eq(tasks.id, worker.taskId),
        columns: { missionId: true, roleSlug: true },
      })
    : null;
  if (missionId) {
    const mission = await db.query.missions.findFirst({
      where: eq(missions.id, missionId),
      columns: { id: true, workspaceId: true },
    });
    if (!mission) {
      return NextResponse.json({ error: 'Mission not found' }, { status: 404 });
    }
    if (mission.workspaceId !== worker.workspaceId) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    if (linkedTask?.missionId && linkedTask.missionId !== missionId) {
      return NextResponse.json(
        { error: "missionId does not match the worker's task mission" },
        { status: 400 }
      );
    }
  }
  const artifactMissionId = missionId || linkedTask?.missionId || null;

  const uuid = randomUUID();
  let storageKey: string;
  try {
    storageKey = buildArtifactKey(worker.workspaceId, uuid, filename);
  } catch {
    return NextResponse.json({ error: 'Unable to derive a storage key' }, { status: 400 });
  }

  // This route used to accept `type` unvalidated (`type || FILE`), so it was the
  // one writer that could persist a type no reader knows how to render. Absent
  // still defaults to `file`; present must be in the shared vocabulary.
  const artifactType = type === undefined || type === null || type === ''
    ? ArtifactType.FILE
    : type;
  const artifactTitle = title || filename;

  const [artifact] = await db
    .insert(artifacts)
    .values({
      workerId,
      workspaceId: worker.workspaceId || null,
      missionId: artifactMissionId,
      type: artifactType,
      title: artifactTitle,
      storageKey,
      // Private until an explicit Share: a token is a bearer credential and
      // POST /api/artifacts/[artifactId]/share is the only thing that mints one.
      shareToken: null,
      visibility: 'private',
      metadata: {
        ...(metadata || {}),
        // The caller's own name, kept verbatim for display; the object key uses
        // a reduced form of it.
        filename,
        mimeType,
        sizeBytes,
      },
    })
    .returning();

  const uploadUrl = await generateSizedUploadUrl(storageKey, mimeType, sizeBytes);

  // The credentialed download path (API key / session, scoped to the artifact's
  // tenant) is the only way to read this back until someone shares it.
  const downloadUrl = `${appBaseUrl()}/api/artifacts/${artifact.id}/download`;

  return NextResponse.json({
    artifactId: artifact.id,
    uploadUrl,
    downloadUrl,
    shareUrl: null,
    storageKey,
  });
}
