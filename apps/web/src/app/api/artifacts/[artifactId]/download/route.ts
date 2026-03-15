import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { artifacts } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { isStorageConfigured, generateDownloadUrl } from '@/lib/storage';
import { authenticateApiKey } from '@/lib/api-auth';
import { getCurrentUser } from '@/lib/auth-helpers';

// GET /api/artifacts/[artifactId]/download - Redirect to presigned download URL
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ artifactId: string }> }
) {
  const { artifactId } = await params;

  if (!isStorageConfigured()) {
    return NextResponse.json({ error: 'Storage not configured' }, { status: 503 });
  }

  const artifact = await db.query.artifacts.findFirst({
    where: eq(artifacts.id, artifactId),
  });

  if (!artifact) {
    return NextResponse.json({ error: 'Artifact not found' }, { status: 404 });
  }

  if (!artifact.storageKey) {
    return NextResponse.json({ error: 'Artifact has no file' }, { status: 404 });
  }

  // Auth: share token (public) or API key/session
  const token = req.nextUrl.searchParams.get('token');
  if (token) {
    if (token !== artifact.shareToken) {
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
