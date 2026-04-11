import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { githubInstallations, workspaces } from '@buildd/core/db/schema';
import { desc, inArray } from 'drizzle-orm';
import { auth } from '@/auth';
import { isGitHubAppConfigured } from '@/lib/github';
import { getUserWorkspaceIds } from '@/lib/team-access';

export async function GET(req: NextRequest) {
  if (process.env.NODE_ENV === 'development') {
    return NextResponse.json({ installations: [], configured: false });
  }

  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const configured = isGitHubAppConfigured();

  if (!configured) {
    return NextResponse.json({ installations: [], configured: false });
  }

  try {
    // Scope installations to the user's workspaces
    const wsIds = await getUserWorkspaceIds(session.user.id!);

    if (wsIds.length === 0) {
      return NextResponse.json({ installations: [], configured: true });
    }

    // Find installation IDs linked to user's workspaces
    const userWorkspaces = await db.query.workspaces.findMany({
      where: inArray(workspaces.id, wsIds),
      columns: { githubInstallationId: true },
    });

    const installationIds = [
      ...new Set(
        userWorkspaces
          .map(w => w.githubInstallationId)
          .filter((id): id is string => !!id)
      ),
    ];

    if (installationIds.length === 0) {
      return NextResponse.json({ installations: [], configured: true });
    }

    const installations = await db.query.githubInstallations.findMany({
      where: inArray(githubInstallations.id, installationIds),
      orderBy: desc(githubInstallations.createdAt),
    });

    return NextResponse.json({
      installations: installations.map((inst) => ({
        id: inst.id,
        installationId: inst.installationId,
        accountType: inst.accountType,
        accountLogin: inst.accountLogin,
        accountAvatarUrl: inst.accountAvatarUrl,
        repositorySelection: inst.repositorySelection,
        suspendedAt: inst.suspendedAt,
        createdAt: inst.createdAt,
      })),
      configured: true,
    });
  } catch (error) {
    console.error('Get installations error:', error);
    return NextResponse.json({ error: 'Failed to get installations' }, { status: 500 });
  }
}
