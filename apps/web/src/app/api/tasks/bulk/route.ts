import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { tasks } from '@buildd/core/db/schema';
import { eq, and, lt, inArray, not } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { getUserWorkspaceIds, verifyAccountWorkspaceAccess } from '@/lib/team-access';
import { getAccountWorkspacePermissions } from '@/lib/account-workspace-cache';

interface BulkCleanupBody {
  status?: string;
  olderThanHours?: number;
  missionId?: string;
  action: 'cancel' | 'delete';
  dryRun?: boolean;
  workspaceId?: string;
}

/**
 * POST /api/tasks/bulk - Bulk task cleanup (cancel or delete)
 *
 * Requires session auth or admin-level API key.
 * Never touches tasks with status 'running' or 'in_progress' (active work).
 */
export async function POST(req: NextRequest) {
  // Auth: session or admin API key
  const user = await getCurrentUser();
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  const apiAccount = await authenticateApiKey(apiKey);

  const hasSessionAuth = !!user;
  const hasAdminToken = apiAccount?.level === 'admin';

  if (!hasSessionAuth && !hasAdminToken) {
    return NextResponse.json(
      { error: 'Unauthorized - requires session auth or admin-level API token' },
      { status: 401 }
    );
  }

  let body: BulkCleanupBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { status, olderThanHours, missionId, action, dryRun = false, workspaceId } = body;

  if (!action || !['cancel', 'delete'].includes(action)) {
    return NextResponse.json(
      { error: 'action is required and must be "cancel" or "delete"' },
      { status: 400 }
    );
  }

  // Resolve accessible workspace IDs
  let accessibleWorkspaceIds: string[] = [];
  if (apiAccount) {
    const permissions = await getAccountWorkspacePermissions(apiAccount.id);
    accessibleWorkspaceIds = permissions.map(p => p.workspaceId);
  } else if (user) {
    accessibleWorkspaceIds = await getUserWorkspaceIds(user.id);
  }

  if (accessibleWorkspaceIds.length === 0) {
    return NextResponse.json({ affected: 0, taskIds: [], dryRun }, { status: 200 });
  }

  // If workspaceId is specified, verify access
  if (workspaceId) {
    if (!accessibleWorkspaceIds.includes(workspaceId)) {
      return NextResponse.json({ error: 'Workspace not found or access denied' }, { status: 403 });
    }
    accessibleWorkspaceIds = [workspaceId];
  }

  // Build filter conditions
  // Always scope to accessible workspaces
  const conditions = [inArray(tasks.workspaceId, accessibleWorkspaceIds)];

  // Never touch actively running tasks
  const protectedStatuses = ['in_progress', 'assigned'];
  conditions.push(not(inArray(tasks.status, protectedStatuses)));

  // Filter by status if specified
  if (status) {
    // Don't allow targeting protected statuses even if explicitly requested
    if (protectedStatuses.includes(status)) {
      return NextResponse.json(
        { error: `Cannot bulk-modify tasks with status "${status}" - they are actively being worked on` },
        { status: 400 }
      );
    }
    conditions.push(eq(tasks.status, status));
  }

  // Filter by age
  if (olderThanHours && olderThanHours > 0) {
    const cutoff = new Date(Date.now() - olderThanHours * 60 * 60 * 1000);
    conditions.push(lt(tasks.createdAt, cutoff));
  }

  // Filter by mission
  if (missionId) {
    conditions.push(eq(tasks.missionId, missionId));
  }

  const whereClause = and(...conditions);

  // Find matching tasks
  const matchingTasks = await db.query.tasks.findMany({
    where: whereClause,
    columns: { id: true, status: true },
    limit: 1000, // Safety cap
  });

  const taskIds = matchingTasks.map((t: { id: string }) => t.id);

  if (dryRun || taskIds.length === 0) {
    return NextResponse.json({
      affected: taskIds.length,
      taskIds,
      dryRun: true,
    });
  }

  // Execute the action
  if (action === 'cancel') {
    await db
      .update(tasks)
      .set({
        status: 'failed',
        result: { error: 'Bulk cancelled by admin' } as any,
        updatedAt: new Date(),
      })
      .where(inArray(tasks.id, taskIds));
  } else if (action === 'delete') {
    await db
      .delete(tasks)
      .where(inArray(tasks.id, taskIds));
  }

  return NextResponse.json({
    affected: taskIds.length,
    taskIds,
    dryRun: false,
  });
}
