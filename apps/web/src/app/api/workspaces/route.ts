import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { accountWorkspaces, workspaces } from '@buildd/core/db/schema';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { authenticateTaskScopedCaller, taskScopeAllowsDelegated } from '@/lib/task-token-auth';
import { listReachableWorkspaceIds } from '@/lib/workspace-access';
import { getUserWorkspaceIds, getUserDefaultTeamId, getUserTeamIds } from '@/lib/team-access';
import { toPublicWorkspace } from '@/lib/workspace-public';
import { can } from '@/lib/permissions';
import { hasTokenRouteAdminAccess } from '@/lib/token-route-policy';
import { isGrantSession } from '@/lib/grant-scope';
import { sqlOrderBy, sqlWhere } from '@buildd/core/db/relational-sql';
import { createWorkspace } from '@/lib/workspace-create';

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
  // A per-task token lists only its own task's workspace and the ones its
  // schedule's delegation names, so a delegated task can resolve a workspace
  // by name; it learns nothing about the rest of the team.
  const apiAccount = await authenticateTaskScopedCaller(apiKey, req);

  // Fall back to session auth (only without a key: a key is authoritative)
  const user = apiAccount ? null : await getCurrentUser();

  if (!apiAccount && !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    if (apiAccount?.taskScope) {
      const reachable = await listReachableWorkspaceIds({ account: apiAccount });
      const ids = reachable.filter(id =>
        taskScopeAllowsDelegated(apiAccount, id, 'analytics:read') || taskScopeAllowsDelegated(apiAccount, id, 'tasks:create'));
      const rows = ids.length
        ? await db.query.workspaces.findMany({ where: sqlWhere(inArray(workspaces.id, ids)), orderBy: sqlOrderBy(desc(workspaces.createdAt)) })
        : [];
      // No runner or connected-account detail: a task token needs the name, not the fleet.
      return NextResponse.json({ workspaces: rows.map(ws => toPublicWorkspace(ws)) });
    }

    // Both paths list exactly the workspaces the caller can reach
    // (lib/workspace-access.ts) — the same rule task and mission creation
    // apply. For an API account that is its own team's open workspaces plus
    // its explicit links; another team's open workspace never appears.
    let allWorkspaces;
    if (apiAccount) {
      const allIds = await listReachableWorkspaceIds({ account: apiAccount });

      allWorkspaces = allIds.length > 0
        ? await db.query.workspaces.findMany({
            where: sqlWhere(inArray(workspaces.id, allIds)),
            orderBy: sqlOrderBy(desc(workspaces.createdAt)),
            with: {
              accountWorkspaces: {
                with: { account: { columns: CONNECTED_ACCOUNT_COLUMNS } },
              },
              // The team's name only: `buildd top` says "5 workspaces · <team>".
              team: { columns: { name: true } },
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
            where: sqlWhere(whereClause),
            orderBy: sqlOrderBy(desc(workspaces.createdAt)),
            with: {
              accountWorkspaces: {
                with: {
                  account: { columns: CONNECTED_ACCOUNT_COLUMNS },
                },
              },
              team: { columns: { name: true } },
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
        teamName: (ws as { team?: { name?: string | null } | null }).team?.name ?? null,
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
  const apiAccount = await authenticateApiKey(apiKey, req);
  const user = await getCurrentUser();

  if (!user && !apiAccount) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await req.json();
    const { name, repoUrl, defaultBranch, gitConfig, githubRepo, githubInstallationId, accessMode, knowledgeIngest, teamId: requestedTeamId } = body;

    // The knowledge ingest switch (default on). Strict boolean: a coerced
    // "false" string must not quietly leave ingest on.
    if (knowledgeIngest !== undefined && typeof knowledgeIngest !== 'boolean') {
      return NextResponse.json({ error: 'knowledgeIngest must be a boolean' }, { status: 400 });
    }
    const ingestOn = knowledgeIngest !== false;

    // Auto-derive name from repoUrl if not provided
    let workspaceName = name;
    if (!workspaceName && repoUrl) {
      workspaceName = extractRepoName(repoUrl);
    }

    if (!workspaceName) {
      return NextResponse.json({ error: 'Name is required (or provide repoUrl to auto-derive)' }, { status: 400 });
    }

    // Resolve team: a credential creates in its own team, a session user in the
    // requested or default team.
    //  - An API key: its account's team.
    //  - An account-level MCP connection (grant session): the team of the one
    //    granted workspace the request is bound to (x-buildd-workspace, see
    //    lib/api-auth.ts), which the grant reaches now. The MCP transport binds
    //    a create to a workspace in the team it names (lib/mcp-grant-session.ts
    //    grantCreateTarget).
    // Naming any other team is refused, never quietly moved.
    let teamId: string | null = null;
    if (apiAccount) {
      if (requestedTeamId && requestedTeamId !== apiAccount.teamId) {
        return NextResponse.json({ error: 'This connection cannot create a workspace in that team' }, { status: 403 });
      }
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

    // create_workspace: owner/admin of the target team for a session (the
    // registry counts a personal team as owned), an admin-level key of its
    // own team. A member is refused, not quietly moved to their personal team.
    // A grant session acts at the user's role in that team (level), and a
    // person grant is also held to the person's own permission there; an
    // agent grant has no person and is gated by level alone, as a key is.
    const grantPerson = apiAccount && isGrantSession(apiAccount)
      ? (apiAccount as { sessionUserId?: string }).sessionUserId ?? null
      : null;
    const mayCreate = apiAccount
      ? hasTokenRouteAdminAccess(apiAccount, req)
        && (!grantPerson || await can({ kind: 'user', userId: grantPerson }, 'create_workspace', teamId))
      : await can({ kind: 'user', userId: user!.id }, 'create_workspace', teamId);
    if (!mayCreate) {
      return NextResponse.json({ error: 'Creating a workspace in this team requires team admin' }, { status: 403 });
    }

    const created = await createWorkspace({
      teamId,
      name: workspaceName,
      repoUrl,
      defaultBranch,
      gitConfig,
      githubRepo,
      githubInstallationId,
      accessMode,
      knowledgeIngest: ingestOn,
      origin: req.nextUrl.origin,
      userId: user?.id ?? null,
    });
    if (!created.ok) {
      return NextResponse.json({ error: created.error }, { status: created.status });
    }
    return NextResponse.json(toPublicWorkspace(created.workspace));
  } catch (error) {
    console.error('Create workspace error:', error);
    return NextResponse.json({ error: 'Failed to create workspace' }, { status: 500 });
  }
}
