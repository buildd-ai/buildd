import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { accounts, tasks, workers, workspaces } from '@buildd/core/db/schema';
import { eq, and, inArray, ne } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';

async function authenticateApiKey(apiKey: string | null) {
  if (!apiKey) return null;

  const account = await db.query.accounts.findFirst({
    where: eq(accounts.apiKey, apiKey),
  });

  return account || null;
}

// POST /api/tasks/[id]/reassign - Admin force-reassign a stuck task
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  // Check for admin access via session OR admin-level API token
  const user = await getCurrentUser();
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  const apiAccount = await authenticateApiKey(apiKey);

  // Must have session auth OR admin-level API token
  const hasSessionAuth = !!user;
  const hasAdminToken = apiAccount?.level === 'admin';

  if (!hasSessionAuth && !hasAdminToken) {
    return NextResponse.json(
      { error: 'Unauthorized - requires session auth or admin-level API token' },
      { status: 401 }
    );
  }

  try {
    const task = await db.query.tasks.findFirst({
      where: eq(tasks.id, id),
      with: { workspace: true },
    });

    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    // Verify ownership if using session auth
    if (hasSessionAuth && !hasAdminToken) {
      if (task.workspace?.ownerId !== user!.id) {
        return NextResponse.json({ error: 'Task not found' }, { status: 404 });
      }
    }

    if (task.status === 'completed') {
      return NextResponse.json({ error: 'Cannot reassign completed task' }, { status: 400 });
    }

    // Mark all non-terminal workers for this task as failed
    // This includes: idle, starting, running, waiting_input
    await db
      .update(workers)
      .set({
        status: 'failed',
        error: 'Task reassigned by admin',
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(workers.taskId, id),
          inArray(workers.status, ['idle', 'starting', 'running', 'waiting_input'])
        )
      );

    // Reset task to pending
    await db
      .update(tasks)
      .set({
        status: 'pending',
        claimedBy: null,
        claimedAt: null,
        expiresAt: null,
        updatedAt: new Date(),
      })
      .where(eq(tasks.id, id));

    return NextResponse.json({
      success: true,
      message: 'Task reset to pending and available for claiming'
    });
  } catch (error) {
    console.error('Reassign task error:', error);
    return NextResponse.json({ error: 'Failed to reassign task' }, { status: 500 });
  }
}
