import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { taskSchedules, workspaces } from '@buildd/core/db/schema';
import { eq, and } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { validateCronExpression, computeNextRunAt } from '@/lib/schedule-helpers';

// GET /api/workspaces/[id]/schedules - List schedules for a workspace
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Verify workspace ownership
  const workspace = await db.query.workspaces.findFirst({
    where: and(eq(workspaces.id, id), eq(workspaces.ownerId, user.id)),
    columns: { id: true },
  });

  if (!workspace) {
    return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
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
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Verify workspace ownership
  const workspace = await db.query.workspaces.findFirst({
    where: and(eq(workspaces.id, id), eq(workspaces.ownerId, user.id)),
    columns: { id: true },
  });

  if (!workspace) {
    return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
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
        createdByUserId: user.id,
      })
      .returning();

    return NextResponse.json({ schedule }, { status: 201 });
  } catch (error) {
    console.error('Create schedule error:', error);
    return NextResponse.json({ error: 'Failed to create schedule' }, { status: 500 });
  }
}
