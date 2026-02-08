import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { githubInstallations, workspaces } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { auth } from '@/auth';
import { listInstallationRepos } from '@/lib/github';

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

    // Fetch repos directly from GitHub API
    const ghRepos = await listInstallationRepos(installation.installationId);

    // Get workspaces linked to repos from this installation to mark "already linked"
    const linkedWorkspaces = await db.query.workspaces.findMany({
      where: eq(workspaces.githubInstallationId, id),
      columns: { id: true, repo: true, githubRepoId: true },
    });

    // Build a set of linked repo full names for quick lookup
    const linkedRepoNames = new Set(
      linkedWorkspaces
        .map((w) => w.repo)
        .filter(Boolean)
    );

    return NextResponse.json({
      repos: ghRepos.map((repo: Record<string, unknown>) => {
        const owner = (repo.owner as Record<string, unknown>)?.login as string || '';
        const fullName = repo.full_name as string;
        return {
          id: String(repo.id), // Use GitHub's numeric repo ID as string
          repoId: repo.id,
          fullName,
          name: repo.name as string,
          owner,
          private: repo.private as boolean,
          defaultBranch: repo.default_branch as string,
          htmlUrl: repo.html_url as string,
          description: repo.description as string | null,
          hasWorkspace: linkedRepoNames.has(fullName),
        };
      }),
    });
  } catch (error) {
    console.error('Get repos error:', error);
    return NextResponse.json({ error: 'Failed to get repos' }, { status: 500 });
  }
}
