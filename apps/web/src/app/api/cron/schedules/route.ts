import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { taskSchedules, tasks, workspaces } from '@buildd/core/db/schema';
import { eq, and, lte, sql, inArray } from 'drizzle-orm';
import { computeNextRunAt } from '@/lib/schedule-helpers';
import { dispatchNewTask } from '@/lib/task-dispatch';
import { triggerEvent, channels, events } from '@/lib/pusher';

const MAX_SCHEDULES_PER_RUN = 50;

export async function GET(req: NextRequest) {
  // Verify CRON_SECRET
  const authHeader = req.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret) {
    return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
  }

  const token = authHeader?.replace('Bearer ', '');
  if (token !== cronSecret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const now = new Date();
  let processed = 0;
  let created = 0;
  let skipped = 0;
  let errors = 0;

  try {
    // Find due schedules: enabled=true AND nextRunAt <= now
    const dueSchedules = await db.query.taskSchedules.findMany({
      where: and(
        eq(taskSchedules.enabled, true),
        lte(taskSchedules.nextRunAt, now)
      ),
      limit: MAX_SCHEDULES_PER_RUN,
    });

    for (const schedule of dueSchedules) {
      processed++;

      try {
        // Check maxConcurrentFromSchedule - count active tasks from this schedule
        if (schedule.maxConcurrentFromSchedule > 0) {
          const activeStatuses = ['pending', 'assigned', 'in_progress'];
          const [activeCount] = await db
            .select({ count: sql<number>`count(*)::int` })
            .from(tasks)
            .where(
              and(
                eq(tasks.workspaceId, schedule.workspaceId),
                inArray(tasks.status, activeStatuses),
                sql`${tasks.context}->>'scheduleId' = ${schedule.id}`
              )
            );

          if ((activeCount?.count ?? 0) >= schedule.maxConcurrentFromSchedule) {
            // Too many active tasks from this schedule, skip but advance nextRunAt
            const nextRunAt = computeNextRunAt(schedule.cronExpression, schedule.timezone);
            await db
              .update(taskSchedules)
              .set({ nextRunAt, updatedAt: now })
              .where(eq(taskSchedules.id, schedule.id));
            skipped++;
            continue;
          }
        }

        // Atomic claim: UPDATE with WHERE on nextRunAt to prevent double-creation
        const nextRunAt = computeNextRunAt(schedule.cronExpression, schedule.timezone);
        const [claimed] = await db
          .update(taskSchedules)
          .set({
            nextRunAt,
            lastRunAt: now,
            totalRuns: sql`${taskSchedules.totalRuns} + 1`,
            consecutiveFailures: 0,
            lastError: null,
            updatedAt: now,
          })
          .where(
            and(
              eq(taskSchedules.id, schedule.id),
              eq(taskSchedules.nextRunAt, schedule.nextRunAt!)
            )
          )
          .returning();

        if (!claimed) {
          // Another invocation already processed this schedule
          skipped++;
          continue;
        }

        // Create task from template
        const template = schedule.taskTemplate;
        const [task] = await db
          .insert(tasks)
          .values({
            workspaceId: schedule.workspaceId,
            title: template.title,
            description: template.description || null,
            priority: template.priority || 0,
            status: 'pending',
            mode: template.mode || 'execution',
            runnerPreference: template.runnerPreference || 'any',
            requiredCapabilities: template.requiredCapabilities || [],
            context: {
              ...(template.context || {}),
              scheduleId: schedule.id,
              scheduleName: schedule.name,
            },
            creationSource: 'schedule',
          })
          .returning();

        // Update lastTaskId
        await db
          .update(taskSchedules)
          .set({ lastTaskId: task.id })
          .where(eq(taskSchedules.id, schedule.id));

        // Dispatch task
        const workspace = await db.query.workspaces.findFirst({
          where: eq(workspaces.id, schedule.workspaceId),
        });

        if (workspace) {
          await dispatchNewTask(task, workspace);
        }

        // Fire schedule triggered event
        await triggerEvent(
          channels.workspace(schedule.workspaceId),
          events.SCHEDULE_TRIGGERED,
          { schedule: { id: schedule.id, name: schedule.name }, task }
        );

        created++;
      } catch (error) {
        errors++;
        console.error(`Schedule ${schedule.id} error:`, error);

        // Increment consecutive failures
        const newFailures = schedule.consecutiveFailures + 1;
        const shouldPause = schedule.pauseAfterFailures > 0 && newFailures >= schedule.pauseAfterFailures;

        await db
          .update(taskSchedules)
          .set({
            consecutiveFailures: newFailures,
            lastError: error instanceof Error ? error.message : 'Unknown error',
            enabled: shouldPause ? false : schedule.enabled,
            // Still advance nextRunAt so we don't retry immediately
            nextRunAt: computeNextRunAt(schedule.cronExpression, schedule.timezone),
            updatedAt: now,
          })
          .where(eq(taskSchedules.id, schedule.id));
      }
    }

    return NextResponse.json({
      processed,
      created,
      skipped,
      errors,
    });
  } catch (error) {
    console.error('Cron schedules error:', error);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
