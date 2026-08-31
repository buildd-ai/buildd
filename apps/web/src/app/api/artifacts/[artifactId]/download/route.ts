import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { artifacts } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { isStorageConfigured, generateDownloadUrl } from '@/lib/storage';
import { authenticateApiKey } from '@/lib/api-auth';
import { getCurrentUser } from '@/lib/auth-helpers';
import { verifyAccountWorkspaceAccess, verifyWorkspaceAccess } from '@/lib/team-access';

// GET /api/artifacts/[artifactId]/download - Redirect to presigned download URL
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ artifactId: string }> }
) {
  const { artifactId } = await params;

  if (!isStorageConfigured()) {
    return NextResponse.json({ error: 'Storage not configured' }, { status: 503 });
  }

  // The worker relation is what makes a tenant comparison possible below.
  const artifact = await db.query.artifacts.findFirst({
    where: eq(artifacts.id, artifactId),
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
    // A valid token grants access only while the artifact is public.
    if (token !== artifact.shareToken || artifact.visibility !== 'public') {
      return NextResponse.json({ error: 'Invalid token' }, { status: 403 });
    }
  } else {
    const authHeader = req.headers.get('authorization');
    const apiKey = authHeader?.replace('Bearer ', '') || null;
    const account = await authenticateApiKey(apiKey);
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
          ? await verifyAccountWorkspaceAccess(account.id, artifact.workspaceId)
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

  const downloadUrl = await generateDownloadUrl(artifact.storageKey);
  const metadata = artifact.metadata as Record<string, unknown> | null;
  const filename = (metadata?.filename as string) || 'download';

  return NextResponse.redirect(downloadUrl, {
    headers: {
      'Content-Disposition': `inline; filename="${filename}"`,
      'Cache-Control': 'private, max-age=3500',
    },
  });
}
