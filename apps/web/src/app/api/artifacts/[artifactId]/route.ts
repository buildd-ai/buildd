import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { artifacts } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { authenticateApiKey } from '@/lib/api-auth';
import { verifyAccountWorkspaceAccess, verifyWorkspaceAccess } from '@/lib/team-access';
import { getCurrentUser } from '@/lib/auth-helpers';
import { appBaseUrl } from '@/lib/app-url';
import { isUuid } from '@/lib/uuid';
import { isAuditStorageKey } from '@/lib/storage-keys';
import { triggerEvent, channels } from '@/lib/pusher';

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * PATCH metadata semantics (docs/design/visual-qa-human-review.md, "PATCH
 * integrity fix"): top-level keys shallow-merge onto the stored metadata, and
 * `qa` deep-merges one level, so update_artifact {metadata: {qa: {fixTaskId}}}
 * keeps the shot's route, viewport, finding and the upload's filename. A
 * wholesale replace used to erase them, and the shot silently dropped out of
 * the evidence check and the strip.
 */
function mergeArtifactMetadata(stored: unknown, patch: Json): Json {
  const base = isObject(stored) ? stored : {};
  const merged: Json = { ...base, ...patch };
  if (isObject(patch.qa) && isObject(base.qa)) merged.qa = { ...base.qa, ...patch.qa };
  return merged;
}

// GET /api/artifacts/[artifactId] - Fetch a specific artifact by ID
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ artifactId: string }> }
) {
  const { artifactId } = await params;

  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  const account = await authenticateApiKey(apiKey);
  // The dashboard session (e.g. the in-app agent chat calling this in-process
  // as the signed-in user) is accepted on this read only. A key, when present,
  // stays authoritative so the key path is unchanged.
  const sessionUser = account ? null : await getCurrentUser();

  if (!account && !sessionUser) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // A non-UUID can never name an artifact; querying with one throws 22P02 (a 500).
  if (!isUuid(artifactId)) {
    return NextResponse.json({ error: `Invalid artifact id: expected a UUID, got "${artifactId}". Pass the full UUID.` }, { status: 404 });
  }

  const artifact = await db.query.artifacts.findFirst({
    where: eq(artifacts.id, artifactId),
    with: { worker: true },
  });

  if (!artifact) {
    return NextResponse.json({ error: 'Artifact not found' }, { status: 404 });
  }

  if (!account) {
    // Session: membership of the artifact's workspace team, same as the
    // dashboard. Outside it the artifact does not exist for this caller.
    const workspaceId = artifact.workspaceId ?? artifact.worker?.workspaceId ?? null;
    const access = workspaceId ? await verifyWorkspaceAccess(sessionUser!.id, workspaceId) : null;
    if (!access) {
      return NextResponse.json({ error: 'Artifact not found' }, { status: 404 });
    }
  } else {
    // Key: owner of the worker, or workspace member
    const isOwner = artifact.worker?.accountId === account.id;
    if (!isOwner) {
      if (artifact.workspaceId) {
        const hasAccess = await verifyAccountWorkspaceAccess(account.id, artifact.workspaceId);
        if (!hasAccess) {
          return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        }
      } else {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }
    }
  }

  // A token only addresses a live share while the artifact is public.
  const shareUrl = artifact.shareToken && artifact.visibility === 'public'
    ? `${appBaseUrl()}/share/${artifact.shareToken}`
    : null;

  // Return full artifact without the worker relation
  const { worker: _worker, ...artifactData } = artifact;
  return NextResponse.json({
    artifact: { ...artifactData, shareUrl },
  });
}

// PATCH /api/artifacts/[artifactId] - Update an artifact
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ artifactId: string }> }
) {
  const { artifactId } = await params;

  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  const account = await authenticateApiKey(apiKey);

  if (!account) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (!isUuid(artifactId)) {
    return NextResponse.json({ error: `Invalid artifact id: expected a UUID, got "${artifactId}". Pass the full UUID.` }, { status: 404 });
  }

  // Find artifact and verify ownership via worker -> account
  const artifact = await db.query.artifacts.findFirst({
    where: eq(artifacts.id, artifactId),
    with: { worker: true },
  });

  if (!artifact) {
    return NextResponse.json({ error: 'Artifact not found' }, { status: 404 });
  }

  // Allow: worker owner, OR workspace member for artifacts without an owning worker (e.g. mission-level artifacts)
  const isOwner = artifact.worker?.accountId === account.id;
  if (!isOwner) {
    if (artifact.workspaceId) {
      const hasAccess = await verifyAccountWorkspaceAccess(account.id, artifact.workspaceId);
      if (!hasAccess) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }
    } else {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
  }

  const body = await req.json();
  const { title, content, metadata } = body;
  if (metadata !== undefined && !isObject(metadata)) {
    return NextResponse.json({ error: 'metadata must be an object' }, { status: 400 });
  }

  const updateFields: Record<string, unknown> = {
    updatedAt: new Date(),
  };

  if (title !== undefined) updateFields.title = title;
  if (content !== undefined) updateFields.content = content;
  if (metadata !== undefined) updateFields.metadata = mergeArtifactMetadata(artifact.metadata, metadata);

  const [updated] = await db
    .update(artifacts)
    .set(updateFields)
    .where(eq(artifacts.id, artifactId))
    .returning();

  // An audit shot changed (a fix link, a re-labelled finding): the mission
  // page refreshes on worker:artifact, so its thumbnails follow. Thin payload,
  // no share token; qa/ shots only, so ordinary edits stay quiet.
  if (artifact.missionId && isAuditStorageKey(artifact.storageKey)) {
    await triggerEvent(channels.mission(artifact.missionId), 'worker:artifact', {
      artifact: { id: artifact.id, workerId: artifact.workerId ?? null, missionId: artifact.missionId },
    });
  }

  const shareUrl = updated.shareToken && updated.visibility === 'public'
    ? `${appBaseUrl()}/share/${updated.shareToken}`
    : null;

  return NextResponse.json({
    artifact: { ...updated, shareUrl },
  });
}
