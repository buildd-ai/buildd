import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { workspaces } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { verifyWorkspaceAccess, verifyAccountWorkspaceAccess } from '@/lib/team-access';
import { checkCapabilityMatch } from '@/lib/claim-gates';

/**
 * GET /api/workspaces/[id]/backends
 *
 * Returns live backend availability for this workspace, sourced from the same
 * check the start gate uses so the two cannot drift.
 *
 * Response:
 * { backends: Array<{ id: string; label: string; available: boolean; reason?: string }> }
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: workspaceId } = await params;

  // Dual auth: API key or session
  let accountId: string | null = null;
  let userId: string | null = null;

  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;

  if (apiKey) {
    const account = await authenticateApiKey(apiKey);
    if (!account) {
      return NextResponse.json({ error: 'Invalid API key' }, { status: 401 });
    }
    accountId = account.id;
    const hasAccess = await verifyAccountWorkspaceAccess(accountId, workspaceId);
    if (!hasAccess) {
      return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
    }
  } else {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    userId = user.id;
    const access = await verifyWorkspaceAccess(userId, workspaceId);
    if (!access) {
      return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
    }
  }

  try {
    const workspace = await db.query.workspaces.findFirst({
      where: eq(workspaces.id, workspaceId),
      columns: { id: true, teamId: true },
    });

    if (!workspace) {
      return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
    }

    const teamId = (workspace as any).teamId as string | null;

    const codexMissing = teamId
      ? await checkCapabilityMatch({
          backend: 'codex',
          workspaceId,
          teamId,
          accountId,
        })
      : 'backend:codex';

    const backends = [
      { id: 'claude', label: 'Claude', available: true },
      {
        id: 'codex',
        label: 'Codex',
        available: !codexMissing,
        ...(codexMissing ? { reason: 'No server credentials configured' } : {}),
      },
    ];

    return NextResponse.json({ backends });
  } catch (error) {
    console.error('Get workspace backends error:', error);
    return NextResponse.json({ error: 'Failed to get backend availability' }, { status: 500 });
  }
}
