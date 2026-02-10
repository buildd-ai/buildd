import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { accounts, accountWorkspaces, workspaces } from '@buildd/core/db/schema';
import { eq, and } from 'drizzle-orm';
import { auth } from '@/auth';
import { verifyWorkspaceAccess } from '@/lib/team-access';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  if (process.env.NODE_ENV === 'development') {
    return NextResponse.json({ accounts: [] });
  }

  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Verify workspace access
  const access = await verifyWorkspaceAccess(session.user.id!, id);
  if (!access) {
    return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
  }

  try {
    const connections = await db.query.accountWorkspaces.findMany({
      where: eq(accountWorkspaces.workspaceId, id),
      with: {
        account: true,
      },
    });

    return NextResponse.json({
      accounts: connections.map((c) => ({
        accountId: c.accountId,
        accountName: c.account?.name,
        accountType: c.account?.type,
        canClaim: c.canClaim,
        canCreate: c.canCreate,
      })),
    });
  } catch (error) {
    console.error('Get workspace accounts error:', error);
    return NextResponse.json({ error: 'Failed to get accounts' }, { status: 500 });
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: workspaceId } = await params;

  if (process.env.NODE_ENV === 'development') {
    return NextResponse.json({ success: true });
  }

  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Verify workspace access
  const postAccess = await verifyWorkspaceAccess(session.user.id!, workspaceId);
  if (!postAccess) {
    return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
  }

  try {
    const body = await req.json();
    const { accountId, canClaim = true, canCreate = false } = body;

    if (!accountId) {
      return NextResponse.json({ error: 'accountId is required' }, { status: 400 });
    }

    // Verify workspace exists
    const workspace = await db.query.workspaces.findFirst({
      where: eq(workspaces.id, workspaceId),
    });

    if (!workspace) {
      return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
    }

    // Verify account exists
    const account = await db.query.accounts.findFirst({
      where: eq(accounts.id, accountId),
    });

    if (!account) {
      return NextResponse.json({ error: 'Account not found' }, { status: 404 });
    }

    // Check if connection already exists
    const existing = await db.query.accountWorkspaces.findFirst({
      where: and(
        eq(accountWorkspaces.accountId, accountId),
        eq(accountWorkspaces.workspaceId, workspaceId)
      ),
    });

    if (existing) {
      // Update existing connection
      await db
        .update(accountWorkspaces)
        .set({ canClaim, canCreate })
        .where(
          and(
            eq(accountWorkspaces.accountId, accountId),
            eq(accountWorkspaces.workspaceId, workspaceId)
          )
        );
    } else {
      // Create new connection
      await db.insert(accountWorkspaces).values({
        accountId,
        workspaceId,
        canClaim,
        canCreate,
      });
    }

    return NextResponse.json({
      success: true,
      accountId,
      workspaceId,
      canClaim,
      canCreate,
    });
  } catch (error) {
    console.error('Connect account error:', error);
    return NextResponse.json({ error: 'Failed to connect account' }, { status: 500 });
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: workspaceId } = await params;

  if (process.env.NODE_ENV === 'development') {
    return NextResponse.json({ success: true });
  }

  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Verify workspace access
  const deleteAccess = await verifyWorkspaceAccess(session.user.id!, workspaceId);
  if (!deleteAccess) {
    return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
  }

  try {
    const { searchParams } = new URL(req.url);
    const accountId = searchParams.get('accountId');

    if (!accountId) {
      return NextResponse.json({ error: 'accountId is required' }, { status: 400 });
    }

    await db
      .delete(accountWorkspaces)
      .where(
        and(
          eq(accountWorkspaces.accountId, accountId),
          eq(accountWorkspaces.workspaceId, workspaceId)
        )
      );

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Disconnect account error:', error);
    return NextResponse.json({ error: 'Failed to disconnect account' }, { status: 500 });
  }
}
