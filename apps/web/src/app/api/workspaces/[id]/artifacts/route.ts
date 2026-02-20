import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { artifacts, accounts } from '@buildd/core/db/schema';
import { eq, and, desc } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { hashApiKey } from '@/lib/api-auth';
import { verifyWorkspaceAccess, verifyAccountWorkspaceAccess } from '@/lib/team-access';

async function authenticateRequest(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;

  if (apiKey) {
    const account = await db.query.accounts.findFirst({
      where: eq(accounts.apiKey, hashApiKey(apiKey)),
    });
    if (account) return { type: 'api' as const, account };
  }

  if (process.env.NODE_ENV !== 'development') {
    const user = await getCurrentUser();
    if (user) return { type: 'session' as const, user };
  } else {
    return { type: 'dev' as const };
  }

  return null;
}

// GET /api/workspaces/[id]/artifacts - Query artifacts by workspace
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const auth = await authenticateRequest(req);
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Verify workspace access
  if (auth.type === 'session') {
    const access = await verifyWorkspaceAccess(auth.user.id, id);
    if (!access) return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
  } else if (auth.type === 'api') {
    const hasAccess = await verifyAccountWorkspaceAccess(auth.account.id, id);
    if (!hasAccess) return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
  }

  const url = new URL(req.url);
  const key = url.searchParams.get('key');
  const type = url.searchParams.get('type');
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '10'), 1), 50);

  // Build conditions
  const conditions = [eq(artifacts.workspaceId, id)];
  if (key) conditions.push(eq(artifacts.key, key));
  if (type) conditions.push(eq(artifacts.type, type));

  const results = await db.query.artifacts.findMany({
    where: and(...conditions),
    orderBy: [desc(artifacts.updatedAt)],
    limit,
  });

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : 'https://buildd.dev';

  const artifactsWithUrls = results.map(a => ({
    ...a,
    shareUrl: a.shareToken ? `${baseUrl}/share/${a.shareToken}` : null,
  }));

  return NextResponse.json({ artifacts: artifactsWithUrls });
}
