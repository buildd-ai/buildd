import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { workspaces, githubInstallations, githubRepos } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { authenticateApiKey } from '@/lib/api-auth';
import { getCurrentUser } from '@/lib/auth-helpers';
import { verifyWorkspaceAccess } from '@/lib/team-access';
import { githubApi, isGitHubAppConfigured } from '@/lib/github';

/**
 * POST /api/workspaces/[id]/create-repo
 *
 * Create a new GitHub repository via the workspace's GitHub App installation
 * and link it to the workspace.
 *
 * Body: { name, org?, private?, description? }
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  // Dual auth: API key or session
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  const apiAccount = await authenticateApiKey(apiKey);
  const user = await getCurrentUser();

  if (!apiAccount && !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // For session auth, verify workspace access
  if (user && !apiAccount) {
    const access = await verifyWorkspaceAccess(user.id, id);
    if (!access) {
      return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
    }
  }

  try {
    const body = await req.json();
    const { name, org, private: isPrivate = true, description } = body;

    if (!name) {
      return NextResponse.json({ error: 'name (repo name) is required' }, { status: 400 });
    }

    // Look up the workspace and its GitHub installation
    const workspace = await db.query.workspaces.findFirst({
      where: eq(workspaces.id, id),
      with: {
        githubInstallation: true,
      },
    });

    if (!workspace) {
      return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
    }

    if (!isGitHubAppConfigured()) {
      return NextResponse.json({
        error: 'GitHub App is not configured on this server',
        hint: 'Use `gh repo create` from the CLI instead, then update the workspace with manage_workspaces action=update repoUrl=<url>',
      }, { status: 422 });
    }

    if (!workspace.githubInstallationId) {
      // Try to find an installation matching the org if provided
      let installation = null;
      if (org) {
        installation = await db.query.githubInstallations.findFirst({
          where: eq(githubInstallations.accountLogin, org),
        });
      }

      if (!installation) {
        return NextResponse.json({
          error: 'No GitHub installation linked to this workspace',
          hint: 'Use `gh repo create` from the CLI instead, then update the workspace with manage_workspaces action=update repoUrl=<url>',
        }, { status: 422 });
      }

      // Use found installation
      const repoData = await createGitHubRepo(installation.installationId, name, org, isPrivate, description);
      await linkRepoToWorkspace(id, repoData, installation.id);
      return NextResponse.json({ repoUrl: repoData.html_url, fullName: repoData.full_name });
    }

    // Use the workspace's linked installation
    const installation = workspace.githubInstallation;
    if (!installation) {
      return NextResponse.json({ error: 'GitHub installation record not found' }, { status: 500 });
    }

    const targetOrg = org || installation.accountLogin;
    const repoData = await createGitHubRepo(installation.installationId, name, targetOrg, isPrivate, description);
    await linkRepoToWorkspace(id, repoData, installation.id);

    return NextResponse.json({ repoUrl: repoData.html_url, fullName: repoData.full_name });
  } catch (error) {
    console.error('Create repo error:', error);
    const message = error instanceof Error ? error.message : 'Failed to create repository';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

async function createGitHubRepo(
  installationId: number,
  name: string,
  org: string,
  isPrivate: boolean,
  description?: string,
) {
  // GitHub API: create repo under org or user
  const repoBody: Record<string, unknown> = {
    name,
    private: isPrivate,
    auto_init: true, // Create with initial commit so it's ready to clone
  };
  if (description) repoBody.description = description;

  // Use org endpoint if available, otherwise user endpoint
  const endpoint = org
    ? `/orgs/${org}/repos`
    : '/user/repos';

  const data = await githubApi(installationId, endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(repoBody),
  });

  return data;
}

async function linkRepoToWorkspace(
  workspaceId: string,
  repoData: any,
  installationDbId: string,
) {
  // Upsert into github_repos table
  const [upserted] = await db
    .insert(githubRepos)
    .values({
      installationId: installationDbId,
      repoId: repoData.id,
      fullName: repoData.full_name,
      name: repoData.name,
      owner: repoData.owner?.login || repoData.full_name.split('/')[0],
      private: repoData.private ?? true,
      defaultBranch: repoData.default_branch || 'main',
      htmlUrl: repoData.html_url || null,
      description: repoData.description || null,
    })
    .onConflictDoUpdate({
      target: githubRepos.repoId,
      set: {
        fullName: repoData.full_name,
        name: repoData.name,
        htmlUrl: repoData.html_url || null,
        description: repoData.description || null,
        updatedAt: new Date(),
      },
    })
    .returning();

  // Update workspace with repo URL and github repo reference
  await db
    .update(workspaces)
    .set({
      repo: repoData.html_url || `https://github.com/${repoData.full_name}`,
      githubRepoId: upserted.id,
      updatedAt: new Date(),
    })
    .where(eq(workspaces.id, workspaceId));
}
