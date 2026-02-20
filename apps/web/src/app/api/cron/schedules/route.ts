import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { taskSchedules, tasks, workspaces } from '@buildd/core/db/schema';
import type { ScheduleTrigger } from '@buildd/core/db/schema';
import { eq, and, lte, sql, inArray } from 'drizzle-orm';
import { computeNextRunAt } from '@/lib/schedule-helpers';
import { dispatchNewTask } from '@/lib/task-dispatch';
import { triggerEvent, channels, events } from '@/lib/pusher';

const MAX_SCHEDULES_PER_RUN = 50;
const TRIGGER_FETCH_TIMEOUT = 10_000;

/**
 * Extract a value from a JSON object using simple dot-notation path.
 * Supports: ".tag_name", ".items[0].title", ".feed.entry[0].id"
 */
function extractByPath(obj: unknown, path?: string): string | null {
  if (!path) return typeof obj === 'string' ? obj : JSON.stringify(obj);
  const parts = path.replace(/^\./, '').split(/\.|\[(\d+)\]/).filter(Boolean);
  let current: unknown = obj;
  for (const part of parts) {
    if (current == null) return null;
    if (typeof current === 'object') {
      current = (current as Record<string, unknown>)[part];
    } else {
      return null;
    }
  }
  return current != null ? String(current) : null;
}

/**
 * Parse Atom/RSS XML — extract first entry's id, title, and link.
 */
function parseAtomFeed(xml: string): { latestId: string | null; latestTitle: string | null; latestLink: string | null } {
  const entryMatch = xml.match(/<entry[^>]*>([\s\S]*?)<\/entry>/);
  if (!entryMatch) return { latestId: null, latestTitle: null, latestLink: null };
  const entry = entryMatch[1];

  const idMatch = entry.match(/<id[^>]*>([\s\S]*?)<\/id>/);
  const titleMatch = entry.match(/<title[^>]*>([\s\S]*?)<\/title>/);
  const linkMatch = entry.match(/<link[^>]*href="([^"]*)"/) || entry.match(/<link[^>]*>([\s\S]*?)<\/link>/);

  return {
    latestId: idMatch?.[1]?.trim() || null,
    latestTitle: titleMatch?.[1]?.trim() || null,
    latestLink: linkMatch?.[1]?.trim() || null,
  };
}

/**
 * Evaluate a schedule trigger. Returns result or null on fetch error.
 */
async function evaluateTrigger(
  trigger: ScheduleTrigger,
  lastValue: string | null
): Promise<{ changed: boolean; currentValue: string; metadata?: Record<string, string> } | null> {
  try {
    const headers: Record<string, string> = {
      'User-Agent': 'buildd-scheduler/1.0',
      ...(trigger.headers || {}),
    };

    const res = await fetch(trigger.url, {
      headers,
      signal: AbortSignal.timeout(TRIGGER_FETCH_TIMEOUT),
    });

    if (!res.ok) return null;

    if (trigger.type === 'rss') {
      const xml = await res.text();
      const feed = parseAtomFeed(xml);
      const currentValue = feed.latestId || feed.latestTitle || '';
      if (!currentValue) return null;
      return {
        changed: currentValue !== lastValue,
        currentValue,
        metadata: {
          ...(feed.latestTitle ? { title: feed.latestTitle } : {}),
          ...(feed.latestLink ? { link: feed.latestLink } : {}),
        },
      };
    }

    // http-json
    const json = await res.json();
    const currentValue = extractByPath(json, trigger.path);
    if (currentValue == null) return null;
    return {
      changed: currentValue !== lastValue,
      currentValue,
    };
  } catch {
    return null;
  }
}

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
  let triggerChecks = 0;

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
        // Check trigger condition before anything else
        const trigger = schedule.taskTemplate?.trigger;
        let triggerResult: { currentValue: string; metadata?: Record<string, string> } | null = null;
        if (trigger) {
          triggerChecks++;
          const result = await evaluateTrigger(trigger, schedule.lastTriggerValue);

          // Always update lastCheckedAt and totalChecks
          const triggerUpdate: Record<string, unknown> = {
            lastCheckedAt: now,
            totalChecks: sql`${taskSchedules.totalChecks} + 1`,
            updatedAt: now,
          };

          if (result) {
            triggerUpdate.lastTriggerValue = result.currentValue;
          }

          if (!result || !result.changed) {
            // No change or fetch failed — advance nextRunAt but don't create task
            triggerUpdate.nextRunAt = computeNextRunAt(schedule.cronExpression, schedule.timezone);
            await db.update(taskSchedules).set(triggerUpdate).where(eq(taskSchedules.id, schedule.id));
            skipped++;
            continue;
          }

          // Trigger fired — save result for task context, update DB
          triggerResult = result;
          await db.update(taskSchedules).set(triggerUpdate).where(eq(taskSchedules.id, schedule.id));
        }

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

        // Build task context — include trigger metadata if present
        const template = schedule.taskTemplate;
        const taskContext: Record<string, unknown> = {
          ...(template.context || {}),
          scheduleId: schedule.id,
          scheduleName: schedule.name,
        };

        // Inject trigger info into task context so the agent knows what changed
        if (trigger && triggerResult) {
          taskContext.triggerValue = triggerResult.currentValue;
          taskContext.previousTriggerValue = schedule.lastTriggerValue; // value before this run
          if (triggerResult.metadata) {
            taskContext.triggerMetadata = triggerResult.metadata;
          }
        }

        // Interpolate trigger value into title and description if {{triggerValue}} placeholder present
        let taskTitle = template.title;
        let taskDescription = template.description || null;
        if (triggerResult) {
          taskTitle = taskTitle.replace(/\{\{triggerValue\}\}/g, triggerResult.currentValue);
          if (taskDescription) {
            taskDescription = taskDescription.replace(/\{\{triggerValue\}\}/g, triggerResult.currentValue);
          }
        }

        // Dedup trigger-based schedules: skip if an active task already exists
        // for this schedule with the same trigger value
        if (triggerResult) {
          const externalId = `schedule-${schedule.id}-${triggerResult.currentValue}`;
          const existing = await db.query.tasks.findFirst({
            where: and(
              eq(tasks.workspaceId, schedule.workspaceId),
              eq(tasks.externalId, externalId),
              inArray(tasks.status, ['pending', 'assigned', 'in_progress'])
            ),
          });
          if (existing) {
            skipped++;
            continue;
          }
        }

        const externalId = triggerResult
          ? `schedule-${schedule.id}-${triggerResult.currentValue}`
          : undefined;

        // Create task from template
        const [task] = await db
          .insert(tasks)
          .values({
            workspaceId: schedule.workspaceId,
            title: taskTitle,
            description: taskDescription,
            priority: template.priority || 0,
            status: 'pending',
            mode: template.mode || 'execution',
            runnerPreference: template.runnerPreference || 'any',
            requiredCapabilities: template.requiredCapabilities || [],
            context: taskContext,
            creationSource: 'schedule',
            ...(externalId ? { externalId } : {}),
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
      triggerChecks,
    });
  } catch (error) {
    console.error('Cron schedules error:', error);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
