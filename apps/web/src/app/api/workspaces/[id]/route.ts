import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { workspaces } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { auth } from '@/auth';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  if (process.env.NODE_ENV === 'development') {
    return NextResponse.json({ workspace: null });
  }

  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
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

  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await req.json();
    const { name, accessMode } = body;

    const updates: Record<string, unknown> = {
      updatedAt: new Date(),
    };

    if (name !== undefined) updates.name = name;
    if (accessMode !== undefined) updates.accessMode = accessMode;

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

  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    // Check if workspace exists
    const workspace = await db.query.workspaces.findFirst({
      where: eq(workspaces.id, id),
    });

    if (!workspace) {
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
