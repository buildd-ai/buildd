import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { workspaces } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { BACKEND_REGISTRY, DISPATCHABLE_BACKENDS } from '@buildd/core/backend-policy';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { verifyWorkspaceAccess, verifyAccountWorkspaceAccess } from '@/lib/team-access';
import { isBackendConfigured, type BackendScope } from '@/lib/backend-failover';

/**
 * GET /api/workspaces/[id]/backends
 *
 * Returns live backend availability for this workspace, sourced from
 * isBackendConfigured (the same check the start gate and failover use) so the
 * UI can never drift from the claim route's view of "is this backend usable?".
 *
 * Adding a new backend to BACKEND_REGISTRY is enough — this route stays current
 * with no hand-registration needed here.
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
    const access = await verifyWorkspaceAccess(user.id, workspaceId);
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

    const teamId = (workspace as { teamId?: string | null }).teamId ?? null;
    const scope: BackendScope = { teamId: teamId ?? undefined, workspaceId, accountId: accountId ?? undefined };

    const backends = await Promise.all(
      DISPATCHABLE_BACKENDS.map(async (id) => {
        const descriptor = BACKEND_REGISTRY[id];
        const available = await isBackendConfigured(id, scope);
        return {
          id,
          label: descriptor.label,
          available,
          ...(!available ? { reason: 'No server credentials configured' } : {}),
        };
      }),
    );

    return NextResponse.json({ backends });
  } catch (error) {
    console.error('Get workspace backends error:', error);
    return NextResponse.json({ error: 'Failed to get backend availability' }, { status: 500 });
  }
}
