import { db } from '@buildd/core/db';
import { tasks, missions, missionNotes } from '@buildd/core/db/schema';
import { eq, and, sql, inArray, like, lt } from 'drizzle-orm';
import { triggerEvent, channels, events } from '@/lib/pusher';
import { maybeRetriggerMission, retriggerMissionOnFailure } from '@/lib/mission-loop';
import { approvePlan, type PlanStep } from '@/lib/approve-plan';

/**
 * Handle post-completion logic when a task reaches a terminal state (completed/failed).
 *
 * Checks if the completed task's parent has all children done and fires
 * a CHILDREN_COMPLETED Pusher event for dashboard visibility.
 */
export async function resolveCompletedTask(
  completedTaskId: string,
  _workspaceId: string
): Promise<void> {
  // Check if the completed task's parent has all children done
  const completedTask = await db.query.tasks.findFirst({
    where: eq(tasks.id, completedTaskId),
    columns: { parentTaskId: true },
  });

  if (completedTask?.parentTaskId) {
    await checkChildrenCompleted(completedTask.parentTaskId);
  }

  // Check if task is a planning task that needs mission-level handling
  const completedTaskFull = await db.query.tasks.findFirst({
    where: eq(tasks.id, completedTaskId),
    columns: { mode: true, missionId: true, status: true },
  });

  if (completedTaskFull?.mode === 'planning') {
    if (completedTaskFull.status === 'failed') {
      // Failed planning task — auto-retry the mission (infrastructure failure, not stall)
      if (completedTaskFull.missionId) {
        retriggerMissionOnFailure(completedTaskFull.missionId, completedTaskId).catch((err) =>
          console.error(`[mission-loop] failure auto-retry failed:`, err)
        );
      }
    } else {
      // Completed planning task — auto-approve plan if present in structuredOutput
      const taskWithResult = await db.query.tasks.findFirst({
        where: eq(tasks.id, completedTaskId),
        columns: { result: true },
      });
      const result = taskWithResult?.result as Record<string, unknown> | null;
      const structuredOutput = result?.structuredOutput as Record<string, unknown> | undefined;
      const plan = structuredOutput?.plan as PlanStep[] | undefined;

      // Extract questions from planning output and post as mission notes
      const questions = structuredOutput?.questions as Array<{ ref?: string; question: string; context?: string; defaultChoice?: string }> | undefined;
      if (questions?.length && completedTaskFull.missionId) {
        try {
          for (const q of questions) {
            await db.insert(missionNotes).values({
              missionId: completedTaskFull.missionId,
              taskId: completedTaskId,
              authorType: 'agent',
              type: 'question',
              title: q.question,
              body: q.context || null,
              defaultChoice: q.defaultChoice || null,
              status: 'open',
            });
          }
        } catch (err) {
          console.error(`[mission-notes] Failed to extract questions from task ${completedTaskId}:`, err);
        }
      }

      if (plan && Array.isArray(plan) && plan.length > 0) {
        try {
          await approvePlan(completedTaskId, plan, { autoApproved: true });
          // Children created — retrigger will happen when they complete
          // via checkChildrenCompleted → maybeCreateAggregationTask → maybeRetriggerMission
        } catch (err) {
          console.error(`[auto-approve] Failed for task ${completedTaskId}:`, err);
          // Fall through to retrigger so the mission doesn't stall
          if (completedTaskFull.missionId) {
            maybeRetriggerMission(completedTaskFull.missionId, completedTaskId).catch((e) =>
              console.error(`[mission-loop] retrigger after auto-approve failure:`, e)
            );
          }
        }
      } else if (completedTaskFull.missionId) {
        // Empty plan or no plan — retrigger mission loop (checks missionComplete signal)
        maybeRetriggerMission(completedTaskFull.missionId, completedTaskId).catch((err) =>
          console.error(`[mission-loop] zero-plan retrigger failed:`, err)
        );
      }
    }
  }

  // Check if this is a completed evaluation task — handle verdict
  if (completedTaskFull?.missionId) {
    const missionRecord = await db.query.missions.findFirst({
      where: and(
        eq(missions.id, completedTaskFull.missionId),
        eq(missions.lastEvaluationTaskId, completedTaskId),
      ),
      columns: { id: true },
    });
    if (missionRecord) {
      import('@/lib/mission-evaluation').then(({ handleEvaluationResult }) =>
        handleEvaluationResult(missionRecord.id, completedTaskId).catch((err) =>
          console.error(`[evaluation] result handling failed for mission ${missionRecord.id}:`, err)
        )
      );
    }
  }

  // Check if any tasks have this task in their dependsOn list
  // For failed tasks: cascade failure to dependent tasks
  // For completed tasks: check if deps are now unblocked
  if (completedTaskFull?.status === 'failed') {
    await cascadeDependencyFailure(completedTaskId);
  } else {
    await checkDependsOnResolved(completedTaskId);
  }
}

/**
 * Check if all children of a parent task have reached terminal state.
 * Fires a CHILDREN_COMPLETED Pusher event for dashboard visibility.
 * If the parent is a planning task, auto-creates an aggregation child task.
 */
async function checkChildrenCompleted(
  parentTaskId: string
): Promise<void> {
  const children = await db.query.tasks.findMany({
    where: eq(tasks.parentTaskId, parentTaskId),
    columns: { id: true, status: true, workspaceId: true, title: true, result: true },
  });

  if (children.length === 0) return;

  const allDone = children.every(
    (c) => c.status === 'completed' || c.status === 'failed'
  );

  if (allDone) {
    const workspaceId = children[0].workspaceId;
    await triggerEvent(
      channels.workspace(workspaceId),
      events.CHILDREN_COMPLETED,
      {
        parentTaskId,
        childCount: children.length,
        completed: children.filter((c) => c.status === 'completed').length,
        failed: children.filter((c) => c.status === 'failed').length,
      }
    );

    // Auto-create aggregation task for planning parents
    await maybeCreateAggregationTask(parentTaskId, children);
  }
}

/**
 * If the parent task has mode='planning', create an aggregation child task
 * to synthesize the results of all completed sub-tasks.
 * Guards against duplicate creation by checking for existing aggregation tasks.
 * Cancels stale pending aggregators (>1 hour old) and skips if mission is already completed.
 */
async function maybeCreateAggregationTask(
  parentTaskId: string,
  children: Array<{ id: string; status: string; workspaceId: string; title: string; result: unknown }>
): Promise<void> {
  // Fetch parent to check if it's a planning task
  const parent = await db.query.tasks.findFirst({
    where: eq(tasks.id, parentTaskId),
    columns: { id: true, mode: true, title: true, workspaceId: true, missionId: true },
  });

  if (!parent || parent.mode !== 'planning') return;

  // Skip if the parent's mission is already completed
  if (parent.missionId) {
    const mission = await db.query.missions.findFirst({
      where: eq(missions.id, parent.missionId),
      columns: { id: true, status: true },
    });
    if (mission?.status === 'completed') return;
  }

  // Guard: check if an aggregation task already exists
  const existing = await db
    .select({ id: tasks.id, status: tasks.status, createdAt: tasks.createdAt })
    .from(tasks)
    .where(
      and(
        eq(tasks.parentTaskId, parentTaskId),
        like(tasks.title, 'Aggregate results:%')
      )
    );

  if (existing.length > 0) {
    // Cancel stale pending aggregators (created > 1 hour ago) so a fresh one can be created
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const stalePending = existing.filter(
      (e) => e.status === 'pending' && e.createdAt < oneHourAgo
    );

    if (stalePending.length > 0) {
      await db
        .update(tasks)
        .set({ status: 'cancelled' })
        .where(inArray(tasks.id, stalePending.map((e) => e.id)));
    } else {
      // Non-stale aggregator exists (pending, in_progress, or completed) — don't create another
      // If the aggregation is completed and this is a mission task, trigger the closed loop
      const completedAgg = existing.find((e) => e.status === 'completed');
      if (completedAgg && parent.missionId) {
        maybeRetriggerMission(parent.missionId, parentTaskId).catch((err) =>
          console.error(`[mission-loop] retrigger failed for ${parent.missionId}:`, err)
        );
      }
      return;
    }
  }

  // Build context with child task summaries
  const childSummaries = children.map((c) => ({
    taskId: c.id,
    title: c.title,
    status: c.status,
    result: c.result ?? null,
  }));

  // Skip aggregation when all children failed — nothing to synthesize
  const hasCompletedChild = childSummaries.some(c => c.status === 'completed');
  if (!hasCompletedChild) {
    if (parent.missionId) {
      maybeRetriggerMission(parent.missionId, parentTaskId).catch((err) =>
        console.error(`[aggregation] all children failed, retrigger error:`, err)
      );
    }
    return;
  }

  // Skip aggregation for single-child planning tasks — redundant overhead
  const nonAggChildren = children.filter(c => !c.title.startsWith('Aggregate results:'));
  if (nonAggChildren.length <= 1) {
    if (parent.missionId) {
      maybeRetriggerMission(parent.missionId, parentTaskId).catch((err) =>
        console.error(`[aggregation] single child, skipping aggregation:`, err)
      );
    }
    return;
  }

  await db.insert(tasks).values({
    workspaceId: parent.workspaceId,
    title: `Aggregate results: ${parent.title}`,
    description: 'Synthesize the results from all completed sub-tasks into a final deliverable.',
    mode: 'execution',
    parentTaskId,
    missionId: parent.missionId,
    status: 'pending',
    creationSource: 'api',
    outputRequirement: 'artifact_required',
    context: {
      aggregation: true,
      parentTaskId,
      childTasks: childSummaries,
    },
  });
}

/**
 * Check if completing a task unblocks any tasks that depend on it via `dependsOn`.
 * For each dependent task, verify all its dependencies are in terminal state,
 * then fire a TASK_UNBLOCKED Pusher event.
 */
async function checkDependsOnResolved(
  completedTaskId: string
): Promise<void> {
  // Find all tasks where dependsOn contains the completed task ID
  const dependentTasks = await db
    .select({
      id: tasks.id,
      dependsOn: tasks.dependsOn,
      workspaceId: tasks.workspaceId,
    })
    .from(tasks)
    .where(
      sql`${tasks.dependsOn}::jsonb @> ${JSON.stringify([completedTaskId])}::jsonb`
    );

  if (dependentTasks.length === 0) return;

  // Collect all unique dependency IDs across all dependent tasks
  const allDepIds = new Set<string>();
  for (const task of dependentTasks) {
    const deps = task.dependsOn as string[] | null;
    if (deps) {
      for (const depId of deps) {
        allDepIds.add(depId);
      }
    }
  }

  // Fetch statuses for all dependency tasks in a single query
  const depTasks = await db
    .select({ id: tasks.id, status: tasks.status })
    .from(tasks)
    .where(inArray(tasks.id, Array.from(allDepIds)));

  const statusMap = new Map(depTasks.map((t) => [t.id, t.status]));

  // Check each dependent task to see if all its dependencies are resolved
  for (const task of dependentTasks) {
    const deps = task.dependsOn as string[] | null;
    if (!deps || deps.length === 0) continue;

    const allCompleted = deps.every((depId) => {
      const status = statusMap.get(depId);
      return status === 'completed';
    });

    if (allCompleted) {
      await triggerEvent(
        channels.workspace(task.workspaceId),
        events.TASK_UNBLOCKED,
        {
          taskId: task.id,
          resolvedDependency: completedTaskId,
        }
      );
    }
  }
}

/**
 * Cascade failure to tasks that depend on the failed task.
 * Auto-fails dependent tasks and recursively resolves them (triggering further cascades).
 */
async function cascadeDependencyFailure(
  failedTaskId: string
): Promise<void> {
  // Find all pending/assigned tasks where dependsOn contains the failed task ID
  const dependentTasks = await db
    .select({
      id: tasks.id,
      title: tasks.title,
      workspaceId: tasks.workspaceId,
      status: tasks.status,
    })
    .from(tasks)
    .where(
      and(
        sql`${tasks.dependsOn}::jsonb @> ${JSON.stringify([failedTaskId])}::jsonb`,
        // Only cascade to non-terminal tasks
        sql`${tasks.status} NOT IN ('completed', 'failed', 'cancelled')`,
      )
    );

  if (dependentTasks.length === 0) return;

  // Fetch the failed task's title for a meaningful error message
  const failedTask = await db.query.tasks.findFirst({
    where: eq(tasks.id, failedTaskId),
    columns: { title: true },
  });
  const failedTitle = failedTask?.title || failedTaskId;

  for (const task of dependentTasks) {
    // Auto-fail the dependent task
    await db
      .update(tasks)
      .set({
        status: 'failed',
        result: { error: `Blocked: dependency "${failedTitle}" (${failedTaskId}) failed` } as any,
        updatedAt: new Date(),
      })
      .where(eq(tasks.id, task.id));

    // Fire event for dashboard visibility
    await triggerEvent(
      channels.workspace(task.workspaceId),
      events.TASK_DEPENDENCY_FAILED,
      {
        taskId: task.id,
        failedDependency: failedTaskId,
        failedDependencyTitle: failedTitle,
      }
    );

    // Recursively resolve — triggers further cascades, mission loop updates, etc.
    await resolveCompletedTask(task.id, task.workspaceId);
  }
}
