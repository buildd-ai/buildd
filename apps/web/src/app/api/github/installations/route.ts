import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { githubInstallations, workspaces } from '@buildd/core/db/schema';
import { desc, eq, inArray, or } from 'drizzle-orm';
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
    // An installation is visible to a user two ways:
    //   1. a workspace they can see already points at it, or
    //   2. they ran the install flow themselves (installedByUserId).
    //
    // (2) is what makes a fresh install usable. With (1) alone, installing the
    // App before creating any workspace left the installation unreachable —
    // absent from Settings (so its "Sync" button was unclickable) and absent
    // from the /workspaces/new picker (so no workspace could point at it).
    const wsIds = await getUserWorkspaceIds(session.user.id!);

    const userWorkspaces = wsIds.length
      ? await db.query.workspaces.findMany({
          where: inArray(workspaces.id, wsIds),
          columns: { githubInstallationId: true },
        })
      : [];

    const installationIds = [
      ...new Set(
        userWorkspaces
          .map(w => w.githubInstallationId)
          .filter((id): id is string => !!id)
      ),
    ];

    const installations = await db.query.githubInstallations.findMany({
      where: installationIds.length
        ? or(
            inArray(githubInstallations.id, installationIds),
            eq(githubInstallations.installedByUserId, session.user.id!)
          )
        : eq(githubInstallations.installedByUserId, session.user.id!),
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
