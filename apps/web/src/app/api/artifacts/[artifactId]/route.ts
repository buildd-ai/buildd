import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { artifacts } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { authenticateApiKey } from '@/lib/api-auth';
import { verifyAccountWorkspaceAccess } from '@/lib/team-access';

// GET /api/artifacts/[artifactId] - Fetch a specific artifact by ID
export async function GET(
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

  const artifact = await db.query.artifacts.findFirst({
    where: eq(artifacts.id, artifactId),
    with: { worker: true },
  });

  if (!artifact) {
    return NextResponse.json({ error: 'Artifact not found' }, { status: 404 });
  }

  // Verify access: owner of the worker, or workspace member
  const isOwner = artifact.worker.accountId === account.id;
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

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : 'https://buildd.dev';
  const shareUrl = artifact.shareToken ? `${baseUrl}/share/${artifact.shareToken}` : null;

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

  // Find artifact and verify ownership via worker -> account
  const artifact = await db.query.artifacts.findFirst({
    where: eq(artifacts.id, artifactId),
    with: { worker: true },
  });

  if (!artifact) {
    return NextResponse.json({ error: 'Artifact not found' }, { status: 404 });
  }

  if (artifact.worker.accountId !== account.id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const body = await req.json();
  const { title, content, metadata } = body;

  const updateFields: Record<string, unknown> = {
    updatedAt: new Date(),
  };

  if (title !== undefined) updateFields.title = title;
  if (content !== undefined) updateFields.content = content;
  if (metadata !== undefined) updateFields.metadata = metadata;

  const [updated] = await db
    .update(artifacts)
    .set(updateFields)
    .where(eq(artifacts.id, artifactId))
    .returning();

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : 'https://buildd.dev';
  const shareUrl = updated.shareToken ? `${baseUrl}/share/${updated.shareToken}` : null;

  return NextResponse.json({
    artifact: { ...updated, shareUrl },
  });
}
