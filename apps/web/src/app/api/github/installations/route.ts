import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { githubInstallations, githubRepos } from '@buildd/core/db/schema';
import { desc, eq, count } from 'drizzle-orm';
import { auth } from '@/auth';
import { isGitHubAppConfigured } from '@/lib/github';

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
    const installations = await db.query.githubInstallations.findMany({
      orderBy: desc(githubInstallations.createdAt),
      with: {
        repos: true,
      },
    });

    return NextResponse.json({
      installations: installations.map((inst) => ({
        id: inst.id,
        installationId: inst.installationId,
        accountType: inst.accountType,
        accountLogin: inst.accountLogin,
        accountAvatarUrl: inst.accountAvatarUrl,
        repositorySelection: inst.repositorySelection,
        repoCount: inst.repos?.length || 0,
        suspended: !!inst.suspendedAt,
        createdAt: inst.createdAt,
      })),
      configured: true,
    });
  } catch (error) {
    console.error('Get installations error:', error);
    return NextResponse.json({ error: 'Failed to get installations' }, { status: 500 });
  }
}
