import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { taskSchedules, workspaces } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { validateCronExpression, computeNextRunAt } from '@/lib/schedule-helpers';
import { verifyWorkspaceAccess, verifyAccountWorkspaceAccess } from '@/lib/team-access';

/**
 * Authenticate via session or API key. Returns { userId?, accountId? } or null.
 */
async function resolveAuth(req: NextRequest, workspaceId: string) {
  // Try session auth first
  const user = await getCurrentUser();
  if (user) {
    const access = await verifyWorkspaceAccess(user.id, workspaceId);
    if (access) return { userId: user.id };
  }

  // Try API key auth
  const apiKey = req.headers.get('authorization')?.replace('Bearer ', '') || null;
  const account = await authenticateApiKey(apiKey);
  if (account) {
    const hasAccess = await verifyAccountWorkspaceAccess(account.id, workspaceId);
    if (hasAccess) return { accountId: account.id };
  }

  return null;
}

// GET /api/workspaces/[id]/schedules - List schedules for a workspace
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const authResult = await resolveAuth(req, id);
  if (!authResult) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const schedules = await db.query.taskSchedules.findMany({
    where: eq(taskSchedules.workspaceId, id),
    orderBy: (s, { desc }) => [desc(s.createdAt)],
  });

  return NextResponse.json({ schedules });
}

// POST /api/workspaces/[id]/schedules - Create a new schedule
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const authResult = await resolveAuth(req, id);
  if (!authResult) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await req.json();
    const {
      name,
      cronExpression,
      timezone = 'UTC',
      taskTemplate,
      enabled = true,
      maxConcurrentFromSchedule = 1,
      pauseAfterFailures = 5,
    } = body;

    if (!name || !cronExpression || !taskTemplate?.title) {
      return NextResponse.json(
        { error: 'name, cronExpression, and taskTemplate.title are required' },
        { status: 400 }
      );
    }

    // Validate cron expression
    const cronError = validateCronExpression(cronExpression);
    if (cronError) {
      return NextResponse.json({ error: `Invalid cron expression: ${cronError}` }, { status: 400 });
    }

    // Compute next run time
    const nextRunAt = enabled ? computeNextRunAt(cronExpression, timezone) : null;

    const [schedule] = await db
      .insert(taskSchedules)
      .values({
        workspaceId: id,
        name,
        cronExpression,
        timezone,
        taskTemplate,
        enabled,
        nextRunAt,
        maxConcurrentFromSchedule,
        pauseAfterFailures,
        createdByUserId: authResult.userId || null,
      })
      .returning();

    return NextResponse.json({ schedule }, { status: 201 });
  } catch (error) {
    console.error('Create schedule error:', error);
    return NextResponse.json({ error: 'Failed to create schedule' }, { status: 500 });
  }
}
