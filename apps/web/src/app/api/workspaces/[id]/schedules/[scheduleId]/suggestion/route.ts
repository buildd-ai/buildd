import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { taskSchedules } from '@buildd/core/db/schema';
import { eq, and } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { validateCronExpression, computeNextRunAt } from '@/lib/schedule-helpers';
import { verifyWorkspaceAccess, verifyAccountWorkspaceAccess } from '@/lib/team-access';

type RouteParams = { params: Promise<{ id: string; scheduleId: string }> };

/**
 * Authenticate any API key level (worker or admin) with workspace access.
 * Returns auth info or null.
 */
async function resolveAnyAuth(req: NextRequest, workspaceId: string) {
  // Session auth
  const user = await getCurrentUser();
  if (user) {
    const access = await verifyWorkspaceAccess(user.id, workspaceId);
    if (access) return { type: 'session' as const, userId: user.id };
  }

  // API key auth (any level)
  const apiKey = req.headers.get('authorization')?.replace('Bearer ', '') || null;
  const account = await authenticateApiKey(apiKey);
  if (account) {
    const hasAccess = await verifyAccountWorkspaceAccess(account.id, workspaceId);
    if (hasAccess) return { type: 'api' as const, accountId: account.id, level: account.level };
  }

  return null;
}

/**
 * Authenticate via session or admin-level API key only.
 */
async function resolveAdminAuth(req: NextRequest, workspaceId: string) {
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

async function getSchedule(workspaceId: string, scheduleId: string) {
  return db.query.taskSchedules.findFirst({
    where: and(
      eq(taskSchedules.id, scheduleId),
      eq(taskSchedules.workspaceId, workspaceId),
    ),
  });
}

// POST - Create a suggestion (any auth level with workspace access)
export async function POST(req: NextRequest, { params }: RouteParams) {
  const { id, scheduleId } = await params;
  const auth = await resolveAnyAuth(req, id);
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const schedule = await getSchedule(id, scheduleId);
  if (!schedule) {
    return NextResponse.json({ error: 'Schedule not found' }, { status: 404 });
  }

  if (schedule.pendingSuggestion) {
    return NextResponse.json(
      { error: 'A suggestion is already pending. Wait for it to be approved or dismissed.' },
      { status: 409 },
    );
  }

  try {
    const body = await req.json();

    if (!body.reason || typeof body.reason !== 'string') {
      return NextResponse.json({ error: 'reason is required' }, { status: 400 });
    }

    if (body.cronExpression === undefined && body.enabled === undefined) {
      return NextResponse.json(
        { error: 'At least one of cronExpression or enabled must be provided' },
        { status: 400 },
      );
    }

    if (body.cronExpression !== undefined) {
      const cronError = validateCronExpression(body.cronExpression);
      if (cronError) {
        return NextResponse.json({ error: `Invalid cron expression: ${cronError}` }, { status: 400 });
      }
    }

    const suggestion = {
      cronExpression: body.cronExpression,
      enabled: body.enabled,
      reason: body.reason,
      suggestedAt: new Date().toISOString(),
      suggestedByTaskId: body.taskId,
      suggestedByWorkerId: body.workerId,
    };

    const [updated] = await db
      .update(taskSchedules)
      .set({ pendingSuggestion: suggestion, updatedAt: new Date() })
      .where(eq(taskSchedules.id, scheduleId))
      .returning();

    return NextResponse.json({ schedule: updated, suggestion });
  } catch (error) {
    console.error('Create suggestion error:', error);
    return NextResponse.json({ error: 'Failed to create suggestion' }, { status: 500 });
  }
}

// PATCH - Approve suggestion (session or admin API key only)
export async function PATCH(req: NextRequest, { params }: RouteParams) {
  const { id, scheduleId } = await params;
  const auth = await resolveAdminAuth(req, id);
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const schedule = await getSchedule(id, scheduleId);
  if (!schedule) {
    return NextResponse.json({ error: 'Schedule not found' }, { status: 404 });
  }

  const suggestion = schedule.pendingSuggestion as {
    cronExpression?: string;
    enabled?: boolean;
    reason: string;
  } | null;

  if (!suggestion) {
    return NextResponse.json({ error: 'No pending suggestion' }, { status: 404 });
  }

  try {
    const updates: Record<string, unknown> = {
      pendingSuggestion: null,
      updatedAt: new Date(),
    };

    const newCron = suggestion.cronExpression ?? schedule.cronExpression;
    const newEnabled = suggestion.enabled ?? schedule.enabled;

    if (suggestion.cronExpression !== undefined) {
      const cronError = validateCronExpression(suggestion.cronExpression);
      if (cronError) {
        return NextResponse.json({ error: `Suggested cron is invalid: ${cronError}` }, { status: 400 });
      }
      updates.cronExpression = suggestion.cronExpression;
    }

    if (suggestion.enabled !== undefined) {
      updates.enabled = suggestion.enabled;
      if (suggestion.enabled && !schedule.enabled) {
        updates.consecutiveFailures = 0;
        updates.lastError = null;
      }
    }

    // Recompute nextRunAt
    updates.nextRunAt = newEnabled ? computeNextRunAt(newCron, schedule.timezone) : null;

    const [updated] = await db
      .update(taskSchedules)
      .set(updates)
      .where(eq(taskSchedules.id, scheduleId))
      .returning();

    return NextResponse.json({ schedule: updated });
  } catch (error) {
    console.error('Approve suggestion error:', error);
    return NextResponse.json({ error: 'Failed to approve suggestion' }, { status: 500 });
  }
}

// DELETE - Dismiss suggestion (session or admin API key only)
export async function DELETE(req: NextRequest, { params }: RouteParams) {
  const { id, scheduleId } = await params;
  const auth = await resolveAdminAuth(req, id);
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const schedule = await getSchedule(id, scheduleId);
  if (!schedule) {
    return NextResponse.json({ error: 'Schedule not found' }, { status: 404 });
  }

  if (!schedule.pendingSuggestion) {
    return NextResponse.json({ error: 'No pending suggestion' }, { status: 404 });
  }

  const [updated] = await db
    .update(taskSchedules)
    .set({ pendingSuggestion: null, updatedAt: new Date() })
    .where(eq(taskSchedules.id, scheduleId))
    .returning();

  return NextResponse.json({ schedule: updated });
}
