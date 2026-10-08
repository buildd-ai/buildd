import { hasTokenRouteAdminAccess } from '@/lib/token-route-policy';
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { taskSchedules, workspaces } from '@buildd/core/db/schema';
import { eq, and, inArray } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { authenticateTaskScopedCaller, taskScopeAllowsWorkspace, type TaskScopedAccount } from '@/lib/task-token-auth';
import { validateCronExpression, computeNextRunAt } from '@/lib/schedule-helpers';
import { verifyWorkspaceAccess, verifyAccountWorkspaceAccess, canCallerAdminTeam } from '@/lib/team-access';
import { parseScheduleDelegationInput, type ScheduleDelegation } from '@buildd/core/token-delegation';

type RouteParams = { params: Promise<{ id: string; scheduleId: string }> };

/**
 * Authenticate via session or API key.
 *
 * Mutating ops (PATCH/DELETE) require admin-level account.
 * Read (GET) accepts any account in the workspace — worker and trigger tokens
 * need visibility for routine discovery via MCP.
 */
async function resolveAuth(
  req: NextRequest,
  workspaceId: string,
  { requireAdmin = true }: { requireAdmin?: boolean } = {}
) {
  const user = await getCurrentUser();
  if (user) {
    const access = await verifyWorkspaceAccess(user.id, workspaceId);
    if (access) return { kind: 'user' as const, userId: user.id as string };
  }

  const apiKey = req.headers.get('authorization')?.replace('Bearer ', '') || null;
  // Reads also accept a per-task token, confined to its own task's workspace;
  // writes never do.
  const account: TaskScopedAccount | null = requireAdmin ? await authenticateApiKey(apiKey, req) : await authenticateTaskScopedCaller(apiKey, req);
  if (account) {
    if (requireAdmin && !hasTokenRouteAdminAccess(account, req)) return null;
    const hasAccess = taskScopeAllowsWorkspace(account, workspaceId) && await verifyAccountWorkspaceAccess(account.id, workspaceId);
    if (hasAccess) return { kind: 'account' as const, accountId: account.id, teamId: account.teamId as string, level: account.level as string | null };
  }

  return null;
}

type ScheduleAuth = NonNullable<Awaited<ReturnType<typeof resolveAuth>>>;

/**
 * Validate and stamp a `delegation` write (packages/core/token-delegation.ts).
 * Granting reach is an admin act: only a team admin/owner session or an admin
 * key of the schedule's team may set it, every target must be a workspace of
 * that same team, and the granter must itself reach each target. Clearing it
 * (null) needs the same authority. The stored row records who and when.
 */
async function resolveDelegationWrite(
  auth: ScheduleAuth,
  scheduleWorkspaceId: string,
  input: unknown,
): Promise<{ ok: true; value: ScheduleDelegation | null } | { ok: false; status: number; error: string }> {
  const parsed = parseScheduleDelegationInput(input, scheduleWorkspaceId);
  if (!parsed.ok) return { ok: false, status: 400, error: parsed.error };
  const own = await db.query.workspaces.findFirst({ where: eq(workspaces.id, scheduleWorkspaceId), columns: { teamId: true } });
  if (!own?.teamId) return { ok: false, status: 404, error: 'Workspace not found' };
  if (!(await canCallerAdminTeam(auth, own.teamId))) {
    return { ok: false, status: 403, error: 'Setting a schedule delegation requires team admin or owner' };
  }
  if (parsed.grants === null) return { ok: true, value: null };
  const targets = parsed.grants.map(g => g.workspaceId);
  const rows = await db.query.workspaces.findMany({ where: inArray(workspaces.id, targets), columns: { id: true, teamId: true } });
  for (const target of targets) {
    const row = rows.find(r => r.id === target);
    if (!row || row.teamId !== own.teamId) {
      return { ok: false, status: 400, error: `workspace ${target} is not a workspace of this schedule's team` };
    }
    const reaches = auth.kind === 'user'
      ? !!(await verifyWorkspaceAccess(auth.userId, target))
      : await verifyAccountWorkspaceAccess(auth.accountId, target);
    if (!reaches) return { ok: false, status: 403, error: `you cannot grant access to workspace ${target}: you do not reach it yourself` };
  }
  return {
    ok: true,
    value: {
      grants: parsed.grants,
      grantedByUserId: auth.kind === 'user' ? auth.userId : null,
      grantedByAccountId: auth.kind === 'account' ? auth.accountId : null,
      grantedAt: new Date().toISOString(),
    },
  };
}

// GET /api/workspaces/[id]/schedules/[scheduleId] - Get a single schedule
export async function GET(req: NextRequest, { params }: RouteParams) {
  const { id, scheduleId } = await params;
  const authResult = await resolveAuth(req, id, { requireAdmin: false });
  if (!authResult) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const schedule = await db.query.taskSchedules.findFirst({
    where: and(
      eq(taskSchedules.id, scheduleId),
      eq(taskSchedules.workspaceId, id)
    ),
  });

  if (!schedule) {
    return NextResponse.json({ error: 'Schedule not found' }, { status: 404 });
  }

  return NextResponse.json({ schedule });
}

// PATCH /api/workspaces/[id]/schedules/[scheduleId] - Update a schedule
export async function PATCH(req: NextRequest, { params }: RouteParams) {
  const { id, scheduleId } = await params;
  const authResult = await resolveAuth(req, id);
  if (!authResult) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Verify schedule exists in this workspace
  const existing = await db.query.taskSchedules.findFirst({
    where: and(
      eq(taskSchedules.id, scheduleId),
      eq(taskSchedules.workspaceId, id)
    ),
  });

  if (!existing) {
    return NextResponse.json({ error: 'Schedule not found' }, { status: 404 });
  }

  try {
    const body = await req.json();
    const updates: Record<string, unknown> = { updatedAt: new Date() };

    if (body.name !== undefined) updates.name = body.name;
    if (body.taskTemplate !== undefined) updates.taskTemplate = body.taskTemplate;
    if (body.oneShot !== undefined) updates.oneShot = body.oneShot;
    if (body.maxConcurrentFromSchedule !== undefined) updates.maxConcurrentFromSchedule = body.maxConcurrentFromSchedule;
    if (body.pauseAfterFailures !== undefined) updates.pauseAfterFailures = body.pauseAfterFailures;
    if (body.workspaceId !== undefined) {
      updates.workspaceId = body.workspaceId;
      // A grant is made for one schedule in one workspace; it never travels.
      if (body.workspaceId !== existing.workspaceId) updates.delegation = null;
    }

    if (body.delegation !== undefined) {
      if (body.workspaceId !== undefined && body.workspaceId !== existing.workspaceId) {
        return NextResponse.json({ error: 'Move the schedule and set its delegation in separate requests' }, { status: 400 });
      }
      const delegation = await resolveDelegationWrite(authResult, id, body.delegation);
      if (!delegation.ok) return NextResponse.json({ error: delegation.error }, { status: delegation.status });
      updates.delegation = delegation.value;
    }

    // If cron or timezone changed, recompute nextRunAt
    const newCron = body.cronExpression ?? existing.cronExpression;
    const newTz = body.timezone ?? existing.timezone;
    const newEnabled = body.enabled ?? existing.enabled;

    if (body.cronExpression !== undefined) {
      const cronError = validateCronExpression(body.cronExpression);
      if (cronError) {
        return NextResponse.json({ error: `Invalid cron expression: ${cronError}` }, { status: 400 });
      }
      updates.cronExpression = body.cronExpression;
    }

    if (body.timezone !== undefined) updates.timezone = body.timezone;

    if (body.enabled !== undefined) {
      updates.enabled = body.enabled;
      // Reset failures when re-enabling
      if (body.enabled && !existing.enabled) {
        updates.consecutiveFailures = 0;
        updates.lastError = null;
      }
    }

    // Recompute nextRunAt if cron/timezone/enabled changed
    if (body.cronExpression !== undefined || body.timezone !== undefined || body.enabled !== undefined) {
      updates.nextRunAt = newEnabled ? computeNextRunAt(newCron, newTz) : null;
    }

    const [updated] = await db
      .update(taskSchedules)
      .set(updates)
      .where(eq(taskSchedules.id, scheduleId))
      .returning();

    return NextResponse.json({ schedule: updated });
  } catch (error) {
    console.error('Update schedule error:', error);
    return NextResponse.json({ error: 'Failed to update schedule' }, { status: 500 });
  }
}

// DELETE /api/workspaces/[id]/schedules/[scheduleId] - Delete a schedule
export async function DELETE(req: NextRequest, { params }: RouteParams) {
  const { id, scheduleId } = await params;
  const authResult = await resolveAuth(req, id);
  if (!authResult) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const [deleted] = await db
    .delete(taskSchedules)
    .where(and(
      eq(taskSchedules.id, scheduleId),
      eq(taskSchedules.workspaceId, id)
    ))
    .returning();

  if (!deleted) {
    return NextResponse.json({ error: 'Schedule not found' }, { status: 404 });
  }

  return NextResponse.json({ success: true });
}
