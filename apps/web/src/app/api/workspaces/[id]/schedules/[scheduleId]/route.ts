import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { taskSchedules, workspaces } from '@buildd/core/db/schema';
import { eq, and } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { validateCronExpression, computeNextRunAt } from '@/lib/schedule-helpers';
import { verifyWorkspaceAccess, verifyAccountWorkspaceAccess } from '@/lib/team-access';

type RouteParams = { params: Promise<{ id: string; scheduleId: string }> };

/**
 * Authenticate via session or admin-level API key.
 */
async function resolveAuth(req: NextRequest, workspaceId: string) {
  const user = await getCurrentUser();
  if (user) {
    const access = await verifyWorkspaceAccess(user.id, workspaceId);
    if (access) return { userId: user.id };
  }

  const apiKey = req.headers.get('authorization')?.replace('Bearer ', '') || null;
  const account = await authenticateApiKey(apiKey);
  if (account) {
    if (account.level !== 'admin') return null;
    const hasAccess = await verifyAccountWorkspaceAccess(account.id, workspaceId);
    if (hasAccess) return { accountId: account.id };
  }

  return null;
}

// GET /api/workspaces/[id]/schedules/[scheduleId] - Get a single schedule
export async function GET(req: NextRequest, { params }: RouteParams) {
  const { id, scheduleId } = await params;
  const authResult = await resolveAuth(req, id);
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
    if (body.maxConcurrentFromSchedule !== undefined) updates.maxConcurrentFromSchedule = body.maxConcurrentFromSchedule;
    if (body.pauseAfterFailures !== undefined) updates.pauseAfterFailures = body.pauseAfterFailures;

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
