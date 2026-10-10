import { NextRequest, NextResponse } from 'next/server';
import { isUuid } from '@/lib/uuid';
import { db } from '@buildd/core/db';
import { workers, artifacts, tasks, workspaces } from '@buildd/core/db/schema';
import { eq, and } from 'drizzle-orm';
import { triggerEvent, channels, events } from '@/lib/pusher';
import { ARTIFACT_TYPES, ArtifactType, isArtifactType } from '@buildd/shared';
import { authenticateApiKey } from '@/lib/api-auth';
import { callerOwnsWorker } from '@/lib/worker-owner';
import { authenticateTaskScopedCaller } from '@/lib/task-token-auth';
import { isOwnedStorageKey } from '@/lib/storage-keys';
import { appBaseUrl } from '@/lib/app-url';
import { upsertedContent } from '@/lib/artifact-upsert-content';
import { shouldNotifyOnArtifact, notifyArtifactReady } from '@/lib/artifact-notify';
import { isRunReportKey, recordRunnerUsageFromReport } from '@/lib/hosted-runner-usage-store';


// POST /api/workers/[id]/artifacts - Create (or upsert by key) an artifact for a worker
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  // workers.id is a uuid column: a non-UUID can never name a worker, and
  // querying with one throws 22P02, which escaped as a 500.
  if (!isUuid(id)) {
    return NextResponse.json({ error: 'Worker not found' }, { status: 404 });
  }

  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  // A per-task token (cloud container) may add artifacts only to its own worker.
  const account = await authenticateTaskScopedCaller(apiKey, req);

  if (!account) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const worker = await db.query.workers.findFirst({
    where: eq(workers.id, id),
    with: { task: true },
  });

  if (!worker) {
    return NextResponse.json({ error: 'Worker not found' }, { status: 404 });
  }

  if (!callerOwnsWorker(account, worker)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  // Sensitive: block content — allow metadata stub rows only
  let isSensitive = false;
  if (worker.workspaceId) {
    const wsRow = await db.query.workspaces.findFirst({
      where: eq(workspaces.id, worker.workspaceId),
      columns: { dataClass: true },
    });
    isSensitive = wsRow?.dataClass === 'sensitive';
  }

  const linkedTask = worker.taskId
    ? await db.query.tasks.findFirst({
        where: eq(tasks.id, worker.taskId),
        columns: { missionId: true },
      })
    : null;

  const body = await req.json();
  const { type, title, content, url, metadata, key, storageKey } = body;

  // Single vocabulary (@buildd/shared ARTIFACT_TYPES). This route used to accept
  // 6 of the 17 types, so an agent whose `create_artifact` was routed here got a
  // 400 for a type the mission route accepted.
  if (!isArtifactType(type)) {
    return NextResponse.json(
      { error: `Invalid type. Must be one of: ${ARTIFACT_TYPES.join(', ')}` },
      { status: 400 }
    );
  }

  if (!title || typeof title !== 'string') {
    return NextResponse.json({ error: 'title is required' }, { status: 400 });
  }

  // For LINK type, require url
  if (type === ArtifactType.LINK && !url) {
    return NextResponse.json({ error: 'url is required for link artifacts' }, { status: 400 });
  }

  // A stored key is later turned into a signed download URL, so a key named by
  // the caller must resolve inside the worker's own workspace prefix.
  if (storageKey !== undefined && storageKey !== null && !isSensitive) {
    if (!isOwnedStorageKey(storageKey, worker.workspaceId)) {
      return NextResponse.json(
        { error: 'storageKey does not belong to this workspace' },
        { status: 400 }
      );
    }
  }

  // Merge url into metadata for LINK type
  const artifactMetadata = {
    ...(metadata || {}),
    ...(url ? { url } : {}),
  };

  const baseUrl = appBaseUrl();

  // A cloud run report: keep this attempt's hosted runner time. The report
  // artifact below is one per worker (a resumed attempt overwrites it), the
  // usage row is one per attempt. Best-effort; never fails the write.
  if (isRunReportKey(key) && worker.workspaceId) {
    await recordRunnerUsageFromReport({
      workspaceId: worker.workspaceId,
      workerId: id,
      taskId: worker.taskId ?? null,
      report: (metadata as { report?: unknown } | null | undefined)?.report,
    });
  }

  // If key is provided, try to upsert by (workspaceId, key)
  if (key && typeof key === 'string' && worker.workspaceId) {
    const existing = await db.query.artifacts.findFirst({
      where: and(
        eq(artifacts.workspaceId, worker.workspaceId),
        eq(artifacts.key, key),
      ),
    });

    // A key is unique per workspace, so the upsert can land on any artifact
    // there. A task token may take over only its own task's worker artifacts,
    // never another task's, a mission's or an initiative's (those routes apply
    // the same rule to their own levels).
    if (existing && account.taskScope && existing.workerId !== id) {
      const owner = existing.workerId
        ? await db.query.workers.findFirst({ where: eq(workers.id, existing.workerId), columns: { taskId: true } })
        : null;
      if (!owner || !worker.taskId || owner.taskId !== worker.taskId) {
        return NextResponse.json(
          { error: 'That key belongs to an artifact outside this task. Use another key, or the mission-level artifact action for a mission artifact.' },
          { status: 409 },
        );
      }
    }

    if (existing) {
      // Update existing artifact, preserve shareToken
      // Sensitive: never store content prose; storageKey is also blocked (no R2 upload)
      const [updated] = await db
        .update(artifacts)
        .set({
          title,
          content: isSensitive ? null : upsertedContent(existing.content, content),
          storageKey: isSensitive ? null : (storageKey || existing.storageKey || null),
          metadata: artifactMetadata,
          workerId: id,
          type,
          updatedAt: new Date(),
        })
        .where(eq(artifacts.id, existing.id))
        .returning();

      // Preserve any existing token; only expose a live URL if still shared.
      const shareUrl = updated.shareToken && updated.visibility === 'public'
        ? `${baseUrl}/share/${updated.shareToken}`
        : null;

      const activityAt = new Date();
      await db
        .update(workers)
        .set({ updatedAt: activityAt })
        .where(eq(workers.id, id));

      await triggerEvent(
        channels.worker(id),
        events.WORKER_PROGRESS,
        { workerId: id, taskId: worker.taskId, status: worker.status, updatedAt: activityAt }
      );

      if (worker.workspaceId) {
        await triggerEvent(
          channels.workspace(worker.workspaceId),
          'worker:artifact',
          { workerId: id, taskId: worker.taskId }
        );
      }

      // Notify if this artifact is meant for review and the task opted in.
      // For updates, only notify if content or title actually changed.
      if (worker.taskId && worker.workspaceId) {
        const shouldNotify = await shouldNotifyOnArtifact(updated, worker.taskId);
        const newContent = isSensitive ? null : upsertedContent(existing.content, content);
        if (shouldNotify && (existing.content !== newContent || existing.title !== title)) {
          await notifyArtifactReady(updated, worker.taskId, worker.workspaceId);
        }
      }

      return NextResponse.json({
        artifact: { ...updated, shareUrl },
        upserted: true,
      });
    }
  }

  // Insert new artifact
  // Sensitive: content and storageKey are always null — metadata stub only
  // Artifacts are PRIVATE by default; no share token until an explicit Share action.
  const [artifact] = await db
    .insert(artifacts)
    .values({
      workerId: id,
      workspaceId: worker.workspaceId || null,
      missionId: linkedTask?.missionId ?? null,
      key: key || null,
      type,
      title,
      content: isSensitive ? null : (content || null),
      storageKey: isSensitive ? null : (storageKey || null),
      shareToken: null,
      visibility: 'private',
      metadata: artifactMetadata,
    })
    .returning();

  const shareUrl = null;

  const activityAt = new Date();
  await db
    .update(workers)
    .set({ updatedAt: activityAt })
    .where(eq(workers.id, id));

  // Trigger realtime events (thin payloads — no full worker row)
  await triggerEvent(
    channels.worker(id),
    events.WORKER_PROGRESS,
    { workerId: id, taskId: worker.taskId, status: worker.status, updatedAt: activityAt }
  );

  if (worker.workspaceId) {
    await triggerEvent(
      channels.workspace(worker.workspaceId),
      'worker:artifact',
      { workerId: id, taskId: worker.taskId }
    );
  }

  // Notify if this artifact is meant for review and the task opted in.
  if (worker.taskId && worker.workspaceId) {
    const shouldNotify = await shouldNotifyOnArtifact(artifact, worker.taskId);
    if (shouldNotify) {
      await notifyArtifactReady(artifact, worker.taskId, worker.workspaceId);
    }
  }

  return NextResponse.json({
    artifact: { ...artifact, shareUrl },
  });
}

// GET /api/workers/[id]/artifacts - List all artifacts for a worker
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  // workers.id is a uuid column: a non-UUID can never name a worker, and
  // querying with one throws 22P02, which escaped as a 500.
  if (!isUuid(id)) {
    return NextResponse.json({ error: 'Worker not found' }, { status: 404 });
  }

  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  const account = await authenticateApiKey(apiKey, req);

  if (!account) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const worker = await db.query.workers.findFirst({
    where: eq(workers.id, id),
  });

  if (!worker) {
    return NextResponse.json({ error: 'Worker not found' }, { status: 404 });
  }

  if (!callerOwnsWorker(account, worker)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const workerArtifacts = await db.query.artifacts.findMany({
    where: eq(artifacts.workerId, id),
  });

  return NextResponse.json({ artifacts: workerArtifacts });
}
