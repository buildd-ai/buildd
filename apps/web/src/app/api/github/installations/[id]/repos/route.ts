import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { githubInstallations, githubRepos, workspaces } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { auth } from '@/auth';
import { syncInstallationRepos } from '@/lib/github';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  if (process.env.NODE_ENV === 'development') {
    return NextResponse.json({ repos: [] });
  }

  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const installation = await db.query.githubInstallations.findFirst({
      where: eq(githubInstallations.id, id),
    });

    if (!installation) {
      return NextResponse.json({ error: 'Installation not found' }, { status: 404 });
    }

    const repos = await db.query.githubRepos.findMany({
      where: eq(githubRepos.installationId, id),
      with: {
        workspaces: true,
      },
    });

    return NextResponse.json({
      repos: repos.map((repo) => ({
        id: repo.id,
        repoId: repo.repoId,
        fullName: repo.fullName,
        name: repo.name,
        owner: repo.owner,
        private: repo.private,
        defaultBranch: repo.defaultBranch,
        htmlUrl: repo.htmlUrl,
        description: repo.description,
        hasWorkspace: repo.workspaces && repo.workspaces.length > 0,
        workspaceId: repo.workspaces?.[0]?.id,
      })),
    });
  } catch (error) {
    console.error('Get repos error:', error);
    return NextResponse.json({ error: 'Failed to get repos' }, { status: 500 });
  }
}

// POST to sync repos from GitHub
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  if (process.env.NODE_ENV === 'development') {
    return NextResponse.json({ synced: 0 });
  }

  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const installation = await db.query.githubInstallations.findFirst({
      where: eq(githubInstallations.id, id),
    });

    if (!installation) {
      return NextResponse.json({ error: 'Installation not found' }, { status: 404 });
    }

    const synced = await syncInstallationRepos(id, installation.installationId);

    return NextResponse.json({ synced });
  } catch (error) {
    console.error('Sync repos error:', error);
    return NextResponse.json({ error: 'Failed to sync repos' }, { status: 500 });
  }
}
