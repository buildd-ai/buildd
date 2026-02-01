import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { accounts, accountWorkspaces, workspaces } from '@buildd/core/db/schema';
import { desc, eq } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';

async function authenticateApiKey(apiKey: string | null) {
  if (!apiKey) return null;
  const account = await db.query.accounts.findFirst({
    where: eq(accounts.apiKey, apiKey),
  });
  return account || null;
}

export async function GET(req: NextRequest) {
  // Dev mode returns empty
  if (process.env.NODE_ENV === 'development') {
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
    // If API key auth, return workspaces linked to that account
    // If session auth, return workspaces owned by the user
    let allWorkspaces;
    if (apiAccount) {
      // For API key auth, get workspaces linked via accountWorkspaces
      const linkedWorkspaces = await db.query.accountWorkspaces.findMany({
        where: eq(accountWorkspaces.accountId, apiAccount.id),
        with: {
          workspace: {
            with: {
              accountWorkspaces: {
                with: {
                  account: true,
                },
              },
            },
          },
        },
      });
      allWorkspaces = linkedWorkspaces.map(aw => aw.workspace);
    } else {
      // For session auth, get workspaces owned by user
      allWorkspaces = await db.query.workspaces.findMany({
        where: eq(workspaces.ownerId, user!.id),
        orderBy: desc(workspaces.createdAt),
        with: {
          accountWorkspaces: {
            with: {
              account: true,
            },
          },
        },
      });
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

      return {
        ...ws,
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

  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await req.json();
    const { name, repoUrl, defaultBranch, githubRepoId, githubInstallationId, accessMode } = body;

    // Auto-derive name from repoUrl if not provided
    let workspaceName = name;
    if (!workspaceName && repoUrl) {
      workspaceName = extractRepoName(repoUrl);
    }

    if (!workspaceName) {
      return NextResponse.json({ error: 'Name is required (or provide repoUrl to auto-derive)' }, { status: 400 });
    }

    const [workspace] = await db
      .insert(workspaces)
      .values({
        name: workspaceName,
        repo: repoUrl || null,
        localPath: defaultBranch || null,
        githubRepoId: githubRepoId || null,
        githubInstallationId: githubInstallationId || null,
        accessMode: accessMode || 'open',
        ownerId: user.id,
      })
      .returning();

    return NextResponse.json(workspace);
  } catch (error) {
    console.error('Create workspace error:', error);
    return NextResponse.json({ error: 'Failed to create workspace' }, { status: 500 });
  }
}
