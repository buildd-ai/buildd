import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { workspaces } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { verifyWorkspaceAccess, getUserTeamIds } from '@/lib/team-access';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  if (process.env.NODE_ENV === 'development') {
    return NextResponse.json({ workspace: null });
  }

  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const access = await verifyWorkspaceAccess(user.id, id);
    if (!access) {
      return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
    }

    const workspace = await db.query.workspaces.findFirst({
      where: eq(workspaces.id, id),
      with: {
        tasks: true,
        workers: true,
        githubRepo: true,
      },
    });

    if (!workspace) {
      return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
    }

    return NextResponse.json({ workspace });
  } catch (error) {
    console.error('Get workspace error:', error);
    return NextResponse.json({ error: 'Failed to get workspace' }, { status: 500 });
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  if (process.env.NODE_ENV === 'development') {
    return NextResponse.json({ success: true });
  }

  // Support both session auth and API key auth
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  const apiAccount = await authenticateApiKey(apiKey);
  const user = await getCurrentUser();

  if (!apiAccount && !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    // For session auth, verify workspace access via team membership
    if (user && !apiAccount) {
      const access = await verifyWorkspaceAccess(user.id, id);
      if (!access) {
        return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
      }
    }
    // For API key auth, verify workspace belongs to the API key's team
    if (apiAccount) {
      const ws = await db.query.workspaces.findFirst({
        where: eq(workspaces.id, id),
        columns: { teamId: true },
      });
      if (!ws || ws.teamId !== apiAccount.teamId) {
        return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
      }
    }

    const body = await req.json();
    const { name, repo, repoUrl, localPath, defaultBranch, accessMode, discordConfig, teamId } = body;

    const updates: Record<string, unknown> = {
      updatedAt: new Date(),
    };

    if (teamId !== undefined) {
      if (user) {
        const userTeamIds = await getUserTeamIds(user.id);
        if (!userTeamIds.includes(teamId)) {
          return NextResponse.json({ error: 'You do not belong to the target team' }, { status: 403 });
        }
      }
      updates.teamId = teamId;
    }

    if (name !== undefined) updates.name = name;
    // Accept both "repo" and "repoUrl" for convenience
    const repoValue = repo ?? repoUrl;
    if (repoValue !== undefined) updates.repo = repoValue;
    // Accept both "localPath" and "defaultBranch" (localPath column stores the default branch)
    const branchValue = localPath ?? defaultBranch;
    if (branchValue !== undefined) updates.localPath = branchValue;
    if (accessMode !== undefined) updates.accessMode = accessMode;
    if (discordConfig !== undefined) updates.discordConfig = discordConfig;

    await db.update(workspaces).set(updates).where(eq(workspaces.id, id));

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Update workspace error:', error);
    return NextResponse.json({ error: 'Failed to update workspace' }, { status: 500 });
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  if (process.env.NODE_ENV === 'development') {
    return NextResponse.json({ success: true });
  }

  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const access = await verifyWorkspaceAccess(user.id, id, 'owner');
    if (!access) {
      return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
    }

    // Delete the workspace (cascade will handle tasks, workers, etc.)
    await db.delete(workspaces).where(eq(workspaces.id, id));

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Delete workspace error:', error);
    return NextResponse.json({ error: 'Failed to delete workspace' }, { status: 500 });
  }
}
