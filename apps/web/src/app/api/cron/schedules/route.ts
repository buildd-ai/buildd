import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { taskSchedules, tasks, workspaces, missions, workers, workerHeartbeats } from '@buildd/core/db/schema';
import type { ScheduleTrigger } from '@buildd/core/db/schema';
import { eq, and, lte, lt, sql, inArray } from 'drizzle-orm';
import { computeNextRunAt, computeStaggerOffset } from '@/lib/schedule-helpers';
import { dispatchNewTask } from '@/lib/task-dispatch';
import { triggerEvent, channels, events } from '@/lib/pusher';
import { buildMissionContext, isWithinActiveHours } from '@/lib/mission-context';
import { getOrCreateCoordinationWorkspace } from '@/lib/orchestrator-workspace';

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
            const rawNext = computeNextRunAt(schedule.cronExpression, schedule.timezone);
            const staggerSec = computeStaggerOffset(schedule.id, schedule.cronExpression);
            triggerUpdate.nextRunAt = rawNext && staggerSec > 0 ? new Date(rawNext.getTime() + staggerSec * 1000) : rawNext;
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
          const concurrentConditions = [
            ...(schedule.workspaceId ? [eq(tasks.workspaceId, schedule.workspaceId)] : []),
            inArray(tasks.status, activeStatuses),
            sql`${tasks.context}->>'scheduleId' = ${schedule.id}`,
          ] as const;
          const [activeCount] = await db
            .select({ count: sql<number>`count(*)::int` })
            .from(tasks)
            .where(and(...concurrentConditions));

          if ((activeCount?.count ?? 0) >= schedule.maxConcurrentFromSchedule) {
            // Too many active tasks from this schedule, skip but advance nextRunAt
            const rawNext = computeNextRunAt(schedule.cronExpression, schedule.timezone);
            const staggerSec = computeStaggerOffset(schedule.id, schedule.cronExpression);
            const nextRunAt = rawNext && staggerSec > 0 ? new Date(rawNext.getTime() + staggerSec * 1000) : rawNext;
            await db
              .update(taskSchedules)
              .set({ nextRunAt, updatedAt: now })
              .where(eq(taskSchedules.id, schedule.id));
            skipped++;
            continue;
          }
        }

        // Atomic claim: UPDATE with WHERE on nextRunAt to prevent double-creation
        // For one-shot schedules: disable after firing and set nextRunAt to null
        const isOneShot = schedule.oneShot;
        let nextRunAt: Date | null = null;
        if (!isOneShot) {
          const rawNext = computeNextRunAt(schedule.cronExpression, schedule.timezone);
          const staggerSec = computeStaggerOffset(schedule.id, schedule.cronExpression);
          nextRunAt = rawNext && staggerSec > 0 ? new Date(rawNext.getTime() + staggerSec * 1000) : rawNext;
        }
        const [claimed] = await db
          .update(taskSchedules)
          .set({
            nextRunAt,
            ...(isOneShot ? { enabled: false } : {}),
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
          const dedupConditions = [
            ...(schedule.workspaceId ? [eq(tasks.workspaceId, schedule.workspaceId)] : []),
            eq(tasks.externalId, externalId),
            inArray(tasks.status, ['pending', 'assigned', 'in_progress']),
          ] as const;
          const existing = await db.query.tasks.findFirst({
            where: and(...dedupConditions),
          });
          if (existing) {
            skipped++;
            continue;
          }
        }

        const externalId = triggerResult
          ? `schedule-${schedule.id}-${triggerResult.currentValue}`
          : undefined;

        // Check if this schedule is linked to a mission
        const linkedMission = await db.query.missions.findFirst({
          where: eq(missions.scheduleId, schedule.id),
          columns: {
            id: true,
            status: true,
            workspaceId: true,
            teamId: true,
          },
        });

        // Skip if linked mission is no longer active
        if (linkedMission && linkedMission.status !== 'active') {
          // Auto-disable the schedule so it stops firing
          await db.update(taskSchedules).set({
            enabled: false,
            updatedAt: now,
          }).where(eq(taskSchedules.id, schedule.id));
          continue;
        }

        // Resolve workspace: schedule.workspaceId takes priority, fall back to mission.workspaceId
        let taskWorkspaceId = schedule.workspaceId;
        if (!taskWorkspaceId && linkedMission?.workspaceId) {
          taskWorkspaceId = linkedMission.workspaceId;
        }
        // Auto-create orchestrator workspace if mission has a teamId but no workspace
        if (!taskWorkspaceId && linkedMission?.teamId) {
          taskWorkspaceId = (await getOrCreateCoordinationWorkspace(linkedMission.teamId)).id;
        }

        if (!taskWorkspaceId) {
          const newFailures = (schedule.consecutiveFailures || 0) + 1;
          await db.update(taskSchedules).set({
            consecutiveFailures: newFailures,
            lastError: 'No workspace: schedule and mission both lack workspaceId',
            updatedAt: now,
          }).where(eq(taskSchedules.id, schedule.id));
          errors++;
          continue;
        }

        // Read heartbeat/activeHours config from the schedule's taskTemplate.context
        const templateCtx = schedule.taskTemplate?.context as Record<string, unknown> | undefined;
        const isHeartbeat = templateCtx?.heartbeat === true;
        const activeHoursStart = templateCtx?.activeHoursStart as number | undefined;
        const activeHoursEnd = templateCtx?.activeHoursEnd as number | undefined;
        const activeHoursTimezone = templateCtx?.activeHoursTimezone as string | undefined;

        // Active hours gating for heartbeat schedules
        if (
          isHeartbeat &&
          activeHoursStart != null &&
          activeHoursEnd != null
        ) {
          const tz = activeHoursTimezone || schedule.timezone || 'UTC';
          const currentHourStr = new Date().toLocaleString('en-US', {
            timeZone: tz,
            hour: 'numeric',
            hour12: false,
          });
          const currentHour = parseInt(currentHourStr, 10);

          if (!isWithinActiveHours(currentHour, activeHoursStart, activeHoursEnd)) {
            // Outside active hours — advance nextRunAt, skip task creation
            const rawNext = computeNextRunAt(schedule.cronExpression, schedule.timezone);
            const staggerSec = computeStaggerOffset(schedule.id, schedule.cronExpression);
            const advancedNextRunAt = rawNext && staggerSec > 0 ? new Date(rawNext.getTime() + staggerSec * 1000) : rawNext;
            await db
              .update(taskSchedules)
              .set({ nextRunAt: advancedNextRunAt, updatedAt: now })
              .where(eq(taskSchedules.id, schedule.id));
            skipped++;
            continue;
          }
        }

        // If linked to a mission, build rich planning context
        if (linkedMission) {
          const missionContext = await buildMissionContext(linkedMission.id, {
            ...template.context,
            triggerSource: 'cron',
          });
          if (missionContext) {
            taskDescription = missionContext.description;
            Object.assign(taskContext, missionContext.context);
          }
        }

        // Promote outputSchema from context to top-level column so the runner can read it
        const outputSchema = taskContext.outputSchema as Record<string, unknown> | undefined;

        // Create task from template
        const [task] = await db
          .insert(tasks)
          .values({
            workspaceId: taskWorkspaceId,
            title: taskTitle,
            description: taskDescription,
            priority: template.priority || 0,
            status: 'pending',
            mode: template.mode || 'execution',
            runnerPreference: template.runnerPreference || 'any',
            requiredCapabilities: template.requiredCapabilities || [],
            context: taskContext,
            creationSource: linkedMission ? 'orchestrator' : 'schedule',
            ...(externalId ? { externalId } : {}),
            ...(linkedMission ? { missionId: linkedMission.id } : {}),
            ...(outputSchema ? { outputSchema } : {}),
          })
          .returning();

        // Update lastTaskId
        await db
          .update(taskSchedules)
          .set({ lastTaskId: task.id })
          .where(eq(taskSchedules.id, schedule.id));

        // Dispatch task
        const workspace = await db.query.workspaces.findFirst({
          where: eq(workspaces.id, taskWorkspaceId),
        });

        if (workspace) {
          await dispatchNewTask(task, workspace);
        }

        // Fire schedule triggered event
        await triggerEvent(
          channels.workspace(taskWorkspaceId),
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
            nextRunAt: (() => {
              const rawNext = computeNextRunAt(schedule.cronExpression, schedule.timezone);
              const staggerSec = computeStaggerOffset(schedule.id, schedule.cronExpression);
              return rawNext && staggerSec > 0 ? new Date(rawNext.getTime() + staggerSec * 1000) : rawNext;
            })(),
            updatedAt: now,
          })
          .where(eq(taskSchedules.id, schedule.id));
      }
    }

    // Lightweight stale-worker cleanup: mark workers as failed when their
    // runner heartbeat expired (10+ min).  Runs every cron tick (~1 min)
    // so stale workers are caught quickly instead of waiting 30 min for a
    // runner to call /api/tasks/cleanup.
    let heartbeatOrphans = 0;
    try {
      const tenMinutesAgo = new Date(now.getTime() - 10 * 60 * 1000);
      const staleHBs = await db.query.workerHeartbeats.findMany({
        where: lt(workerHeartbeats.lastHeartbeatAt, tenMinutesAgo),
        columns: { id: true, accountId: true },
      });
      if (staleHBs.length > 0) {
        const staleAccountIds = staleHBs.map(hb => hb.accountId);
        const orphanedWorkers = await db.query.workers.findMany({
          where: and(
            inArray(workers.accountId, staleAccountIds),
            inArray(workers.status, ['running', 'starting', 'idle', 'waiting_input']),
          ),
          columns: { id: true, taskId: true },
        });
        if (orphanedWorkers.length > 0) {
          await db
            .update(workers)
            .set({
              status: 'failed',
              error: 'Worker runner went offline (heartbeat expired)',
              completedAt: now,
              updatedAt: now,
            })
            .where(inArray(workers.id, orphanedWorkers.map(w => w.id)));

          const orphanTaskIds = orphanedWorkers.map(w => w.taskId).filter(Boolean) as string[];
          if (orphanTaskIds.length > 0) {
            await db
              .update(tasks)
              .set({ status: 'pending', claimedBy: null, claimedAt: null, updatedAt: now })
              .where(inArray(tasks.id, orphanTaskIds));
          }
          heartbeatOrphans = orphanedWorkers.length;
        }
        // Delete stale heartbeat records
        await db.delete(workerHeartbeats).where(lt(workerHeartbeats.lastHeartbeatAt, tenMinutesAgo));
      }
    } catch (cleanupErr) {
      console.warn('[Cron] Stale worker cleanup failed:', cleanupErr instanceof Error ? cleanupErr.message : cleanupErr);
    }

    return NextResponse.json({
      processed,
      created,
      skipped,
      errors,
      triggerChecks,
      heartbeatOrphans,
    });
  } catch (error) {
    console.error('Cron schedules error:', error);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
