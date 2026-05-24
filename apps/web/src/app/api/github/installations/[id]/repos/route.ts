import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { githubInstallations, githubRepos, workspaces } from '@buildd/core/db/schema';
import { and, eq, ilike, isNull } from 'drizzle-orm';
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

// Repair endpoint: upsert every repo on this installation into github_repos,
// then back-link any workspace whose `repo` URL matches but has a null
// githubRepoId. Needed because the on-demand model only writes github_repos
// when a workspace is created through the new flow — repos linked the old
// way (or via the webhook before the refactor) end up with no row, which
// blocks create_pr.
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

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

    const ghRepos = await listInstallationRepos(installation.installationId);

    let synced = 0;
    let linked = 0;
    for (const repo of ghRepos as Array<Record<string, unknown>>) {
      const fullName = repo.full_name as string;
      const [upserted] = await db
        .insert(githubRepos)
        .values({
          installationId: id,
          repoId: repo.id as number,
          fullName,
          name: repo.name as string,
          owner: ((repo.owner as Record<string, unknown>)?.login as string) || fullName.split('/')[0],
          private: (repo.private as boolean) ?? false,
          defaultBranch: (repo.default_branch as string) || 'main',
          htmlUrl: (repo.html_url as string) || null,
          description: (repo.description as string) || null,
        })
        .onConflictDoUpdate({
          target: githubRepos.repoId,
          set: {
            installationId: id,
            fullName,
            name: repo.name as string,
            defaultBranch: (repo.default_branch as string) || 'main',
            htmlUrl: (repo.html_url as string) || null,
            description: (repo.description as string) || null,
            updatedAt: new Date(),
          },
        })
        .returning();
      synced += 1;

      // Back-link workspaces that point at this repo URL but have no githubRepoId
      const result = await db
        .update(workspaces)
        .set({ githubRepoId: upserted.id, githubInstallationId: id })
        .where(
          and(
            isNull(workspaces.githubRepoId),
            ilike(workspaces.repo, `%${fullName}%`),
          ),
        )
        .returning({ id: workspaces.id });
      linked += result.length;
    }

    return NextResponse.json({ synced, linked });
  } catch (error) {
    console.error('Sync repos error:', error);
    return NextResponse.json({ error: 'Failed to sync repos' }, { status: 500 });
  }
}
