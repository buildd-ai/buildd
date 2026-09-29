import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { accountWorkspaces, githubRepos, workspaces } from '@buildd/core/db/schema';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { listReachableWorkspaceIds } from '@/lib/workspace-access';
import { getInstallationOwnerTeamIds } from '@/lib/github-installation-access';
import { getUserWorkspaceIds, getUserDefaultTeamId, getUserTeamIds } from '@/lib/team-access';
import { enqueueFullIngestJob } from '@/lib/knowledge-ingest';
import { normalizeRepoFullName } from '@/lib/repo-scope';
import { toPublicWorkspace } from '@/lib/workspace-public';

/**
 * The account fields a workspace listing may carry. The response spreads each
 * workspace row, so selecting whole account rows here would serialise every
 * column of every connected account — credentials included — to the caller.
 */
const CONNECTED_ACCOUNT_COLUMNS = { id: true, name: true, type: true } as const;

export async function GET(req: NextRequest) {
  // Dev mode returns empty
  if (process.env.NODE_ENV === 'development' && (!process.env.DATABASE_URL || !process.env.DEV_USER_EMAIL)) {
    return NextResponse.json({ workspaces: [] });
  }

  // Check API key auth first
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  const apiAccount = await authenticateApiKey(apiKey);

  // Fall back to session auth
  const user = await getCurrentUser();

  if (!apiAccount && !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    // Both paths list exactly the workspaces the caller can reach
    // (lib/workspace-access.ts) — the same rule task and mission creation
    // apply. For an API account that is its own team's open workspaces plus
    // its explicit links; another team's open workspace never appears.
    let allWorkspaces;
    if (apiAccount) {
      const allIds = await listReachableWorkspaceIds({ account: apiAccount });

      allWorkspaces = allIds.length > 0
        ? await db.query.workspaces.findMany({
            where: inArray(workspaces.id, allIds),
            orderBy: desc(workspaces.createdAt),
            with: {
              accountWorkspaces: {
                with: { account: { columns: CONNECTED_ACCOUNT_COLUMNS } },
              },
            },
          })
        : [];
    } else {
      // For session auth, get workspaces via team membership
      const wsIds = await getUserWorkspaceIds(user!.id);

      // Optional team scoping. A teamId the user is not a member of yields an
      // empty list — never another team's workspaces.
      const teamIdFilter = new URL(req.url).searchParams.get('teamId');
      let whereClause = inArray(workspaces.id, wsIds);
      if (teamIdFilter) {
        const memberTeamIds = await getUserTeamIds(user!.id);
        if (!memberTeamIds.includes(teamIdFilter)) {
          return NextResponse.json({ workspaces: [] });
        }
        whereClause = and(whereClause, eq(workspaces.teamId, teamIdFilter))!;
      }

      allWorkspaces = wsIds.length > 0
        ? await db.query.workspaces.findMany({
            where: whereClause,
            orderBy: desc(workspaces.createdAt),
            with: {
              accountWorkspaces: {
                with: {
                  account: { columns: CONNECTED_ACCOUNT_COLUMNS },
                },
              },
            },
          })
        : [];
    }

    // Transform to include runner status
    const workspacesWithRunners = allWorkspaces.map((ws) => {
      const connectedAccounts = ws.accountWorkspaces || [];
      const hasActionRunner = connectedAccounts.some(
        (aw) => aw.account?.type === 'action' && aw.canClaim
      );
      const hasServiceRunner = connectedAccounts.some(
        (aw) => aw.account?.type === 'service' && aw.canClaim
      );
      const hasUserRunner = connectedAccounts.some(
        (aw) => aw.account?.type === 'user' && aw.canClaim
      );

      // An explicit allowlist, never `...ws`: the row carries
      // webhook_config.token, a plaintext bearer credential.
      return {
        ...toPublicWorkspace(ws),
        runners: {
          action: hasActionRunner,
          service: hasServiceRunner,
          user: hasUserRunner,
        },
        connectedAccounts: connectedAccounts.map((aw) => ({
          accountId: aw.accountId,
          accountName: aw.account?.name,
          accountType: aw.account?.type,
          canClaim: aw.canClaim,
          canCreate: aw.canCreate,
        })),
      };
    });

    return NextResponse.json({ workspaces: workspacesWithRunners });
  } catch (error) {
    console.error('Get workspaces error:', error);
    return NextResponse.json({ error: 'Failed to get workspaces' }, { status: 500 });
  }
}

// Extract repo name from various URL formats
function extractRepoName(repoUrl: string): string | null {
  // Handle: https://github.com/owner/repo.git, git@github.com:owner/repo, owner/repo
  const cleaned = repoUrl
    .replace(/\.git$/, '')
    .replace(/^https?:\/\/[^/]+\//, '')  // Remove https://github.com/
    .replace(/^git@[^:]+:/, '');          // Remove git@github.com:

  // Get the repo name (last part after /)
  const parts = cleaned.split('/');
  if (parts.length >= 1) {
    return parts[parts.length - 1] || null;
  }
  return null;
}

export async function POST(req: NextRequest) {
  // Dev mode returns mock
  if (process.env.NODE_ENV === 'development') {
    return NextResponse.json({ id: 'dev-workspace', name: 'Dev Workspace' });
  }

  // Support both session auth and API key auth
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  const apiAccount = await authenticateApiKey(apiKey);
  const user = await getCurrentUser();

  if (!user && !apiAccount) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await req.json();
    const { name, repoUrl, defaultBranch, githubRepo, githubInstallationId, accessMode, teamId: requestedTeamId } = body;

    // Auto-derive name from repoUrl if not provided
    let workspaceName = name;
    if (!workspaceName && repoUrl) {
      workspaceName = extractRepoName(repoUrl);
    }

    if (!workspaceName) {
      return NextResponse.json({ error: 'Name is required (or provide repoUrl to auto-derive)' }, { status: 400 });
    }

    // Resolve team: API key uses its team, session user uses requested or default team
    let teamId: string | null = null;
    if (apiAccount) {
      teamId = apiAccount.teamId;
    } else {
      if (requestedTeamId) {
        const memberTeamIds = await getUserTeamIds(user!.id);
        if (memberTeamIds.includes(requestedTeamId)) {
          teamId = requestedTeamId;
        }
      }
      if (!teamId) {
        teamId = await getUserDefaultTeamId(user!.id);
      }
    }
    if (!teamId) {
      return NextResponse.json({ error: 'No team found' }, { status: 500 });
    }

    // A GitHub installation may only be linked into a team it belongs to (see
    // lib/github-installation-access.ts).
    if (githubInstallationId) {
      const ownerTeamIds = await getInstallationOwnerTeamIds(githubInstallationId);
      if (!ownerTeamIds.includes(teamId)) {
        return NextResponse.json(
          { error: 'That GitHub installation is not connected to this team' },
          { status: 403 },
        );
      }
    }

    // If a GitHub repo is selected, persist it on-demand
    let githubRepoDbId: string | null = null;
    if (githubRepo && githubInstallationId) {
      const [upserted] = await db
        .insert(githubRepos)
        .values({
          installationId: githubInstallationId,
          repoId: parseInt(githubRepo.repoId || githubRepo.id),
          fullName: githubRepo.fullName,
          name: githubRepo.name,
          owner: githubRepo.owner,
          private: githubRepo.private ?? false,
          defaultBranch: githubRepo.defaultBranch || 'main',
          htmlUrl: githubRepo.htmlUrl || null,
          description: githubRepo.description || null,
        })
        .onConflictDoUpdate({
          target: githubRepos.repoId,
          // Only refresh a row that already belongs to this installation.
          setWhere: eq(githubRepos.installationId, githubInstallationId),
          set: {
            fullName: githubRepo.fullName,
            name: githubRepo.name,
            owner: githubRepo.owner,
            private: githubRepo.private ?? false,
            defaultBranch: githubRepo.defaultBranch || 'main',
            htmlUrl: githubRepo.htmlUrl || null,
            description: githubRepo.description || null,
            updatedAt: new Date(),
          },
        })
        .returning();
      if (!upserted) {
        return NextResponse.json(
          { error: 'That repository is linked through a different GitHub installation' },
          { status: 409 },
        );
      }
      githubRepoDbId = upserted.id;
    }

    const [workspace] = await db
      .insert(workspaces)
      .values({
        name: workspaceName,
        // Canonical `owner/name` when parseable, else the caller's input
        // verbatim — see the PATCH handler for why unparseable input survives.
        repo: repoUrl ? (normalizeRepoFullName(repoUrl) ?? repoUrl) : null,
        localPath: defaultBranch || null,
        githubRepoId: githubRepoDbId,
        githubInstallationId: githubInstallationId || null,
        accessMode: accessMode || 'open',
        teamId,
      })
      .returning();

    // Auto-ingest on repo link: enqueue a full ingest job when a repo URL was provided.
    if (repoUrl) {
      const fullName = normalizeRepoFullName(repoUrl);
      if (fullName) {
        enqueueFullIngestJob({ workspaceId: workspace.id, repo: fullName, trigger: 'repo_link' }).catch(err =>
          console.error(`[knowledge-ingest] repo-link enqueue failed for new workspace ${workspace.id}:`, err)
        );
      }
    }

    return NextResponse.json(toPublicWorkspace(workspace));
  } catch (error) {
    console.error('Create workspace error:', error);
    return NextResponse.json({ error: 'Failed to create workspace' }, { status: 500 });
  }
}
