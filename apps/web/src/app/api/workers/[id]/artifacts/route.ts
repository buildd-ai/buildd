import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { workers, artifacts } from '@buildd/core/db/schema';
import { eq, and } from 'drizzle-orm';
import { randomBytes } from 'crypto';
import { triggerEvent, channels, events } from '@/lib/pusher';
import { ArtifactType } from '@buildd/shared';
import { authenticateApiKey } from '@/lib/api-auth';

const DELIVERABLE_TYPES = new Set([
  ArtifactType.CONTENT,
  ArtifactType.REPORT,
  ArtifactType.DATA,
  ArtifactType.LINK,
  ArtifactType.SUMMARY,
]);

// POST /api/workers/[id]/artifacts - Create (or upsert by key) an artifact for a worker
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

  const worker = await db.query.workers.findFirst({
    where: eq(workers.id, id),
    with: { task: true },
  });

  if (!worker) {
    return NextResponse.json({ error: 'Worker not found' }, { status: 404 });
  }

  if (worker.accountId !== account.id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const body = await req.json();
  const { type, title, content, url, metadata, key } = body;

  if (!type || !DELIVERABLE_TYPES.has(type)) {
    return NextResponse.json(
      { error: `Invalid type. Must be one of: ${[...DELIVERABLE_TYPES].join(', ')}` },
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

  // Merge url into metadata for LINK type
  const artifactMetadata = {
    ...(metadata || {}),
    ...(url ? { url } : {}),
  };

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : 'https://buildd.dev';

  // If key is provided, try to upsert by (workspaceId, key)
  if (key && typeof key === 'string' && worker.workspaceId) {
    const existing = await db.query.artifacts.findFirst({
      where: and(
        eq(artifacts.workspaceId, worker.workspaceId),
        eq(artifacts.key, key),
      ),
    });

    if (existing) {
      // Update existing artifact, preserve shareToken
      const [updated] = await db
        .update(artifacts)
        .set({
          title,
          content: content || null,
          metadata: artifactMetadata,
          workerId: id,
          type,
          updatedAt: new Date(),
        })
        .where(eq(artifacts.id, existing.id))
        .returning();

      const shareUrl = `${baseUrl}/share/${updated.shareToken}`;

      await triggerEvent(
        channels.worker(id),
        events.WORKER_PROGRESS,
        { worker, artifact: { ...updated, shareUrl } }
      );

      if (worker.workspaceId) {
        await triggerEvent(
          channels.workspace(worker.workspaceId),
          'worker:artifact',
          { worker, artifact: { ...updated, shareUrl } }
        );
      }

      return NextResponse.json({
        artifact: { ...updated, shareUrl },
        upserted: true,
      });
    }
  }

  // Insert new artifact
  const shareToken = randomBytes(24).toString('base64url');

  const [artifact] = await db
    .insert(artifacts)
    .values({
      workerId: id,
      workspaceId: worker.workspaceId || null,
      key: key || null,
      type,
      title,
      content: content || null,
      shareToken,
      metadata: artifactMetadata,
    })
    .returning();

  const shareUrl = `${baseUrl}/share/${shareToken}`;

  // Trigger realtime events
  await triggerEvent(
    channels.worker(id),
    events.WORKER_PROGRESS,
    { worker, artifact: { ...artifact, shareUrl } }
  );

  if (worker.workspaceId) {
    await triggerEvent(
      channels.workspace(worker.workspaceId),
      'worker:artifact',
      { worker, artifact: { ...artifact, shareUrl } }
    );
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

  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  const account = await authenticateApiKey(apiKey);

  if (!account) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const worker = await db.query.workers.findFirst({
    where: eq(workers.id, id),
  });

  if (!worker) {
    return NextResponse.json({ error: 'Worker not found' }, { status: 404 });
  }

  if (worker.accountId !== account.id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const workerArtifacts = await db.query.artifacts.findMany({
    where: eq(artifacts.workerId, id),
  });

  return NextResponse.json({ artifacts: workerArtifacts });
}
