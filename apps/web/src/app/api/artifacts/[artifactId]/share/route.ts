import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { artifacts } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { randomBytes } from 'crypto';
import { authenticateApiKey } from '@/lib/api-auth';
import { verifyAccountWorkspaceAccess, getUserWorkspaceIds } from '@/lib/team-access';
import { getCurrentUser } from '@/lib/auth-helpers';

/**
 * Authorize a request against an artifact for share (make public / revoke) actions.
 * Accepts EITHER a logged-in dashboard user who is a member of the artifact's
 * workspace, OR an API-key account that owns the artifact (via its worker) or has
 * workspace access.
 *
 * Returns:
 *  - { ok: true } when authorized
 *  - { response } (a NextResponse) to short-circuit with 401/403
 */
async function authorizeShare(
  req: NextRequest,
  artifact: { workspaceId: string | null; worker?: { accountId?: string | null } | null },
): Promise<{ ok: true } | { response: NextResponse }> {
  // API-key path (mirror GET/PATCH in ../route.ts)
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  const account = apiKey ? await authenticateApiKey(apiKey) : null;

  if (account) {
    const isOwner = artifact.worker?.accountId === account.id;
    if (isOwner) return { ok: true };
    if (artifact.workspaceId) {
      const hasAccess = await verifyAccountWorkspaceAccess(account.id, artifact.workspaceId);
      if (hasAccess) return { ok: true };
    }
    return { response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  }

  // Session path (mirror app/(protected)/artifacts/[id]/page.tsx)
  const user = await getCurrentUser();
  if (!user) {
    return { response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  }

  if (artifact.workspaceId) {
    const wsIds = await getUserWorkspaceIds(user.id);
    if (wsIds.includes(artifact.workspaceId)) return { ok: true };
  }
  return { response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
}

function baseUrl(): string {
  if (process.env.NEXT_PUBLIC_APP_URL) return process.env.NEXT_PUBLIC_APP_URL;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return 'https://buildd.dev';
}

// POST /api/artifacts/[artifactId]/share - Make an artifact public (generate token if needed)
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ artifactId: string }> }
) {
  const { artifactId } = await params;

  const artifact = await db.query.artifacts.findFirst({
    where: eq(artifacts.id, artifactId),
    with: { worker: true },
  });

  if (!artifact) {
    return NextResponse.json({ error: 'Artifact not found' }, { status: 404 });
  }

  const authz = await authorizeShare(req, artifact);
  if ('response' in authz) return authz.response;

  const token = artifact.shareToken || randomBytes(24).toString('base64url');

  const [updated] = await db
    .update(artifacts)
    .set({ visibility: 'public', shareToken: token, updatedAt: new Date() })
    .where(eq(artifacts.id, artifactId))
    .returning();

  const shareUrl = `${baseUrl()}/share/${updated.shareToken}`;
  return NextResponse.json({ shareUrl });
}

// DELETE /api/artifacts/[artifactId]/share - Make private / revoke share (nulls the token)
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ artifactId: string }> }
) {
  const { artifactId } = await params;

  const artifact = await db.query.artifacts.findFirst({
    where: eq(artifacts.id, artifactId),
    with: { worker: true },
  });

  if (!artifact) {
    return NextResponse.json({ error: 'Artifact not found' }, { status: 404 });
  }

  const authz = await authorizeShare(req, artifact);
  if ('response' in authz) return authz.response;

  await db
    .update(artifacts)
    .set({ visibility: 'private', shareToken: null, updatedAt: new Date() })
    .where(eq(artifacts.id, artifactId));

  return NextResponse.json({ ok: true });
}
