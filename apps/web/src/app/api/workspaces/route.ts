import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { accounts, accountWorkspaces, workspaces } from '@buildd/core/db/schema';
import { desc, eq } from 'drizzle-orm';
import { auth } from '@/auth';

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
  const account = await authenticateApiKey(apiKey);

  // Fall back to session auth
  const session = await auth();

  if (!account && !session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const allWorkspaces = await db.query.workspaces.findMany({
      orderBy: desc(workspaces.createdAt),
      with: {
        accountWorkspaces: {
          with: {
            account: true,
          },
        },
      },
    });

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

export async function POST(req: NextRequest) {
  // Dev mode returns mock
  if (process.env.NODE_ENV === 'development') {
    return NextResponse.json({ id: 'dev-workspace', name: 'Dev Workspace' });
  }

  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await req.json();
    const { name, repoUrl, defaultBranch, githubRepoId, githubInstallationId } = body;

    if (!name) {
      return NextResponse.json({ error: 'Name is required' }, { status: 400 });
    }

    const [workspace] = await db
      .insert(workspaces)
      .values({
        name,
        repo: repoUrl || null,
        localPath: defaultBranch || null,
        githubRepoId: githubRepoId || null,
        githubInstallationId: githubInstallationId || null,
      })
      .returning();

    return NextResponse.json(workspace);
  } catch (error) {
    console.error('Create workspace error:', error);
    return NextResponse.json({ error: 'Failed to create workspace' }, { status: 500 });
  }
}
