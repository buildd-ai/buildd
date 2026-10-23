import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { artifacts } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { isStorageConfigured, generateDownloadUrl } from '@/lib/storage';
import { authenticateApiKey } from '@/lib/api-auth';
import { getCurrentUser } from '@/lib/auth-helpers';
import { verifyAccountWorkspaceAccess, verifyWorkspaceAccess } from '@/lib/team-access';
import { isUuid } from '@/lib/uuid';
import { finalizeArtifactUpload } from '@/lib/artifact-upload';
import { getArtifactRevision } from '@/lib/artifact-revisions';
import { sqlWhere } from '@buildd/core/db/relational-sql';

// GET /api/artifacts/[artifactId]/download[?revision=N] - Redirect to presigned download URL
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ artifactId: string }> }
) {
  const { artifactId } = await params;
  if (!isUuid(artifactId)) {
    return NextResponse.json({ error: `Invalid artifact id: expected a UUID, got "${artifactId}". Pass the full UUID.` }, { status: 404 });
  }

  if (!isStorageConfigured()) {
    return NextResponse.json({ error: 'Storage not configured' }, { status: 503 });
  }

  // The worker relation is what makes a tenant comparison possible below.
  const artifact = await db.query.artifacts.findFirst({
    where: sqlWhere(eq(artifacts.id, artifactId)),
    with: { worker: true },
  });

  if (!artifact) {
    return NextResponse.json({ error: 'Artifact not found' }, { status: 404 });
  }

  if (!artifact.storageKey) {
    return NextResponse.json({ error: 'Artifact has no file' }, { status: 404 });
  }

  // Auth: explicitly published artifact, share token, or API key/session.
  //
  // A `visibility: 'public'` artifact needs no credential: the share page already
  // serves its content anonymously, and `upload_artifact` hands agents this URL as
  // the "permanent, for markdown embedding" link (packages/core/mcp-tools.ts) which
  // they inline into artifact prose. Requiring a credential here would break every
  // embedded image on a shared page. Publishing is the deliberate act that opens
  // the bytes; nothing here widens access to a private artifact.
  const token = req.nextUrl.searchParams.get('token');
  if (artifact.visibility === 'public') {
    // Published: no credential required, and no token needed either.
  } else if (token) {
    // A token is only ever a grant for a published artifact, and that case is
    // handled above — so a token presented here is for a private artifact and is
    // always rejected, whether or not it matches the stored one.
    return NextResponse.json({ error: 'Invalid token' }, { status: 403 });
  } else {
    const authHeader = req.headers.get('authorization');
    const apiKey = authHeader?.replace('Bearer ', '') || null;
    const account = await authenticateApiKey(apiKey, req);
    const user = account ? null : await getCurrentUser();

    if (!account && !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Being authenticated is not being entitled: the caller has to own the
    // artifact's worker or belong to its workspace. Same guard as ../route.ts.
    if (account) {
      const isOwner = artifact.worker?.accountId === account.id;
      if (!isOwner) {
        const hasAccess = artifact.workspaceId
          ? await verifyAccountWorkspaceAccess(account, artifact.workspaceId)
          : false;
        if (!hasAccess) {
          return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        }
      }
    } else {
      const hasAccess = artifact.workspaceId
        ? await verifyWorkspaceAccess(user!.id, artifact.workspaceId)
        : null;
      if (!hasAccess) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }
    }
  }

  // ?revision=N serves that revision's own object: a file artifact given a new
  // body (upload_artifact { artifactId, ... }) keeps every earlier one.
  const revisionParam = req.nextUrl.searchParams.get('revision');
  let storageKey: string = artifact.storageKey;
  if (revisionParam !== null) {
    const n = Number(revisionParam);
    if (!Number.isInteger(n) || n < 1) {
      return NextResponse.json({ error: 'revision must be a positive integer' }, { status: 400 });
    }
    // A body from before revisions existed (current_revision 0) is its own revision 1.
    if (n !== Math.max(artifact.currentRevision, 1)) {
      const revision = await getArtifactRevision(artifact.id, n);
      if (!revision?.storageKey) {
        return NextResponse.json({ error: `Artifact has no file at revision ${n} (current revision is ${artifact.currentRevision})` }, { status: 404 });
      }
      // Only a verified body is ever replaced, so an earlier revision needs no upload check.
      if (n < artifact.currentRevision) storageKey = revision.storageKey;
    }
  }

  // An upload is served only once its bytes are verified: a pending one is
  // finalized by this read; a failed one stays failed and reports why.
  if (storageKey === artifact.storageKey && (artifact.uploadState === 'pending' || artifact.uploadState === 'failed')) {
    const upload = await finalizeArtifactUpload(artifact.id);
    if (upload.state !== 'ready') {
      return NextResponse.json(
        { error: upload.state === 'failed' ? `Upload failed: ${upload.reason}` : 'Upload not finished: the file has not arrived yet', uploadState: upload.state },
        { status: 409 },
      );
    }
  }

  const downloadUrl = await generateDownloadUrl(storageKey);
  const metadata = artifact.metadata as Record<string, unknown> | null;
  const filename = (metadata?.filename as string) || 'download';

  return NextResponse.redirect(downloadUrl, {
    headers: {
      'Content-Disposition': `inline; filename="${filename}"`,
      'Cache-Control': 'private, max-age=3500',
    },
  });
}
