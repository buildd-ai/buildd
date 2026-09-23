import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { tasks } from '@buildd/core/db/schema';
import { eq, and, lt, inArray, not, notInArray, sql } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { getUserWorkspaceIds, verifyAccountWorkspaceAccess } from '@/lib/team-access';
import { getAccountWorkspacePermissions } from '@/lib/account-workspace-cache';
import { applyTaskCancelSideEffects } from '@/lib/task-cancel';

const TERMINAL_STATUSES = ['completed', 'failed', 'cancelled'];
const SIDE_EFFECT_BATCH = 10;

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
 * Never touches tasks with status 'assigned' or 'in_progress' (active work).
 * Cancel only ever matches non-terminal tasks, writes `cancelled` (merging into
 * `result` rather than replacing it) and runs the shared cancel side effects
 * for each row it actually changed. `dryRun` in the response echoes the caller.
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
    // Cancelling a finished task would overwrite its outcome — refuse outright.
    if (action === 'cancel' && TERMINAL_STATUSES.includes(status)) {
      return NextResponse.json(
        { error: `Cannot bulk-cancel tasks with status "${status}" - they are already terminal` },
        { status: 400 }
      );
    }
    conditions.push(eq(tasks.status, status));
  }

  // Cancel only ever targets unfinished work, with or without a status filter.
  if (action === 'cancel') {
    conditions.push(notInArray(tasks.status, TERMINAL_STATUSES));
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
      dryRun,
    });
  }

  // Execute the action
  if (action === 'cancel') {
    const cancelled = await db
      .update(tasks)
      .set({
        status: 'cancelled',
        // Merge, don't replace: keep any prUrl/prNumber/summary already recorded.
        result: sql`coalesce(${tasks.result}, '{}'::jsonb) || ${JSON.stringify({ cancelReason: 'Bulk cancelled by admin' })}::jsonb`,
        updatedAt: new Date(),
      })
      // Re-guard: a row that went terminal since the SELECT is left alone.
      .where(and(inArray(tasks.id, taskIds), notInArray(tasks.status, TERMINAL_STATUSES)))
      .returning({ id: tasks.id, workspaceId: tasks.workspaceId, missionId: tasks.missionId });

    // Up to 1000 rows: run the per-row side effects in bounded batches rather
    // than serially. The helper never throws.
    for (let i = 0; i < cancelled.length; i += SIDE_EFFECT_BATCH) {
      await Promise.all(cancelled.slice(i, i + SIDE_EFFECT_BATCH).map((row) => applyTaskCancelSideEffects(row)));
    }

    return NextResponse.json({
      affected: cancelled.length,
      taskIds: cancelled.map((r) => r.id),
      dryRun: false,
    });
  }

  await db
    .delete(tasks)
    .where(inArray(tasks.id, taskIds));

  return NextResponse.json({
    affected: taskIds.length,
    taskIds,
    dryRun: false,
  });
}
