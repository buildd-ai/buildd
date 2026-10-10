import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { artifacts } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { authenticateTaskScopedCaller, taskScopeAllowsMission, taskScopeAllowsWorker, taskScopeAllowsWorkspace } from '@/lib/task-token-auth';
import { verifyAccountWorkspaceAccess, verifyWorkspaceAccess } from '@/lib/team-access';
import { getCurrentUser } from '@/lib/auth-helpers';
import { assertMemberRepoAccess, memberRepoAccessSubject } from '@/lib/member-repo-access';
import { appBaseUrl } from '@/lib/app-url';
import { isUuid } from '@/lib/uuid';
import { isAuditStorageKey } from '@/lib/storage-keys';
import { isStorageConfigured, generateDownloadUrl } from '@/lib/storage';
import { triggerEvent, channels } from '@/lib/pusher';
import { artifactMetadataMergeSql, isJsonObject } from '@/lib/artifact-metadata-merge';
import { getArtifactRevision, writeArtifactBody } from '@/lib/artifact-revisions';

// PATCH metadata semantics and the in-SQL merge: lib/artifact-metadata-merge.ts.

// GET /api/artifacts/[artifactId] - Fetch a specific artifact by ID
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ artifactId: string }> }
) {
  const { artifactId } = await params;

  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  // A per-task token reads only artifacts in its own task's workspace.
  const account = await authenticateTaskScopedCaller(apiKey, req);
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
    // Outside its own workspace an artifact does not exist for a task token,
    // even one its minting account's worker produced elsewhere.
    if (!taskScopeAllowsWorkspace(account, artifact.workspaceId ?? artifact.worker?.workspaceId ?? null)) {
      return NextResponse.json({ error: 'Artifact not found' }, { status: 404 });
    }
    // Key: owner of the worker, or workspace member
    const isOwner = artifact.worker?.accountId === account.id;
    if (!isOwner) {
      if (artifact.workspaceId) {
        const hasAccess = await verifyAccountWorkspaceAccess(account, artifact.workspaceId);
        if (!hasAccess) {
          return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        }
      } else {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }
    }
  }

  // A diff is repository code: with the workspace's opt-in GitHub check on, a
  // person must hold read on the repo (lib/member-repo-access.ts). Keys skip it.
  if (artifact.type === 'diff') {
    const refusal = await assertMemberRepoAccess(
      memberRepoAccessSubject(account, sessionUser),
      artifact.workspaceId ?? artifact.worker?.workspaceId ?? null,
    );
    if (refusal) return refusal;
  }

  // ?revision=N reads that immutable revision's body instead of the current one.
  const revisionParam = req.nextUrl.searchParams.get('revision');
  let requestedRevision: number | null = null;
  if (revisionParam !== null) {
    requestedRevision = Number(revisionParam);
    if (!Number.isInteger(requestedRevision) || requestedRevision < 1) {
      return NextResponse.json({ error: 'revision must be a positive integer' }, { status: 400 });
    }
  }
  const revisionNumber = requestedRevision ?? artifact.currentRevision;
  const revision = revisionNumber > 0 ? await getArtifactRevision(artifact.id, revisionNumber) : null;
  // A body written before revisions existed (current_revision 0) is its own
  // revision 1 until its first change snapshots it.
  const legacyFirst = requestedRevision === 1 && artifact.currentRevision === 0 && (artifact.content !== null || artifact.storageKey !== null);
  if (requestedRevision !== null && !revision && !legacyFirst) {
    return NextResponse.json(
      { error: `Artifact has no revision ${requestedRevision} (current revision is ${artifact.currentRevision})` },
      { status: 404 },
    );
  }
  const body = requestedRevision !== null && revision
    ? { content: revision.content, storageKey: revision.storageKey }
    : { content: artifact.content, storageKey: artifact.storageKey };

  // A token only addresses a live share while the artifact is public.
  const shareUrl = artifact.shareToken && artifact.visibility === 'public'
    ? `${appBaseUrl()}/share/${artifact.shareToken}`
    : null;

  // A file artifact has no inline content; hand back a short-lived presigned
  // URL under the same access check as above so a key-only caller (an agent
  // that may not use credentials from disk) can still read the bytes.
  let downloadUrl: string | null = null;
  if (body.storageKey && isStorageConfigured()) {
    try {
      downloadUrl = await generateDownloadUrl(body.storageKey);
    } catch {
      downloadUrl = null;
    }
  }

  // Return full artifact without the worker relation
  const { worker: _worker, contentAuthor: _contentAuthor, ...artifactData } = artifact;
  return NextResponse.json({
    artifact: {
      ...artifactData,
      ...body,
      shareUrl,
      downloadUrl,
      // `revision` is the body returned; `currentRevision` the latest. Pass
      // currentRevision back as PATCH expectedRevision to refuse a lost update.
      revision: revision
        ? { revision: revision.revision, contentHash: revision.contentHash, sizeBytes: revision.sizeBytes, author: revision.author, createdAt: revision.createdAt }
        : null,
    },
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
  // A per-task token updates only its own task's artifacts and the
  // mission-level artifacts of its own task's mission.
  const account = await authenticateTaskScopedCaller(apiKey, req);

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

  if (account.taskScope) {
    if (!taskScopeAllowsWorkspace(account, artifact.workspaceId ?? artifact.worker?.workspaceId ?? null)) {
      return NextResponse.json({ error: 'Artifact not found' }, { status: 404 });
    }
    const ownTaskArtifact = !!artifact.worker && artifact.worker.accountId === account.id && taskScopeAllowsWorker(account, artifact.worker);
    const ownMissionArtifact = !artifact.workerId && !artifact.initiativeId && await taskScopeAllowsMission(account, artifact.missionId);
    if (!ownTaskArtifact && !ownMissionArtifact) {
      return NextResponse.json({ error: "A task token may update only its own task's or its own mission's artifacts" }, { status: 403 });
    }
  }

  // Allow: worker owner, OR workspace member for artifacts without an owning worker (e.g. mission-level artifacts)
  const isOwner = artifact.worker?.accountId === account.id;
  if (!isOwner) {
    if (artifact.workspaceId) {
      const hasAccess = await verifyAccountWorkspaceAccess(account, artifact.workspaceId);
      if (!hasAccess) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }
    } else {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
  }

  const body = await req.json();
  const { title, content, metadata, expectedRevision } = body;
  if (metadata !== undefined && !isJsonObject(metadata)) {
    return NextResponse.json({ error: 'metadata must be an object' }, { status: 400 });
  }
  if (expectedRevision !== undefined) {
    if (content === undefined) {
      return NextResponse.json({ error: 'expectedRevision guards a content write; send content with it' }, { status: 400 });
    }
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
      return NextResponse.json({ error: 'expectedRevision must be a non-negative integer' }, { status: 400 });
    }
  }

  const updateFields: Record<string, unknown> = {
    updatedAt: new Date(),
  };

  if (title !== undefined) updateFields.title = title;
  // Merged in SQL against the row the UPDATE sees, not the value read above:
  // two overlapping PATCHes of one shot must not lose either update.
  if (metadata !== undefined) updateFields.metadata = artifactMetadataMergeSql(metadata);

  let updated: typeof artifacts.$inferSelect;
  if (content !== undefined) {
    // A body write is a new immutable revision (lib/artifact-revisions.ts).
    const written = await writeArtifactBody(
      artifactId,
      { content, expectedRevision, author: `account:${account.id}` },
      updateFields,
    );
    if (!written.ok) {
      return written.conflict
        ? NextResponse.json(
          {
            error: `Artifact changed since revision ${expectedRevision}: it is now at revision ${written.currentRevision}. Re-read it, then write on top of that revision.`,
            code: 'revision_conflict',
            currentRevision: written.currentRevision,
          },
          { status: 409 },
        )
        : NextResponse.json({ error: 'Artifact not found' }, { status: 404 });
    }
    updated = written.artifact;
  } else {
    [updated] = await db
      .update(artifacts)
      .set(updateFields)
      .where(eq(artifacts.id, artifactId))
      .returning();
  }

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
