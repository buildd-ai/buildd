import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { getUserWorkspaceIds } from '@/lib/team-access';
import { getAccountWorkspacePermissions } from '@/lib/account-workspace-cache';
import { getWorkspaceRoles } from '@/lib/mission-context';

// GET /api/roles — list roles with current load
export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  const apiAccount = await authenticateApiKey(apiKey);

  if (!user && !apiAccount) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    let wsIds: string[];
    if (apiAccount) {
      const perms = await getAccountWorkspacePermissions(apiAccount.id);
      wsIds = perms.map(p => p.workspaceId);
    } else {
      wsIds = await getUserWorkspaceIds(user!.id);
    }

    if (wsIds.length === 0) {
      return NextResponse.json({ roles: [] });
    }

    // Fetch roles across all workspaces, merge by slug
    const allRoles = [];
    for (const wsId of wsIds) {
      const wsRoles = await getWorkspaceRoles(wsId);
      allRoles.push(...wsRoles);
    }

    // Deduplicate by slug (keep first occurrence)
    const seenSlugs = new Set<string>();
    const roles = allRoles.filter(r => {
      if (seenSlugs.has(r.slug)) return false;
      seenSlugs.add(r.slug);
      return true;
    });

    return NextResponse.json({ roles });
  } catch (error) {
    console.error('GET /api/roles error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
