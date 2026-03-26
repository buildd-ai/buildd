/**
 * Mission Completion Gate — independent evaluation of mission completion.
 *
 * Instead of letting any agent self-declare missionComplete, we intercept
 * that signal and spawn an independent evaluation task that compares the
 * mission's original goal against actual deliverables.
 */
import { db } from '@buildd/core/db';
import { missions, tasks, taskSchedules } from '@buildd/core/db/schema';
import { eq, and, desc, inArray } from 'drizzle-orm';
import { triggerEvent, channels, events } from '@/lib/pusher';
import { dispatchNewTask } from '@/lib/task-dispatch';
import { workspaces } from '@buildd/core/db/schema';

/** Structured output schema the evaluator must produce */
export const EVALUATION_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['complete', 'incomplete', 'blocked'] },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    rationale: { type: 'string', description: '2-3 sentence explanation of the verdict' },
    taskDispositions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          taskId: { type: 'string' },
          disposition: { type: 'string', enum: ['completed', 'skipped', 'failed', 'still_needed'] },
          reason: { type: 'string' },
        },
        required: ['taskId', 'disposition'],
      },
    },
    missingWork: {
      type: 'array',
      items: { type: 'string' },
      description: 'What is left to do, if verdict is incomplete',
    },
  },
  required: ['verdict', 'confidence', 'rationale', 'taskDispositions'],
} as const;

export interface EvaluationVerdict {
  verdict: 'complete' | 'incomplete' | 'blocked';
  confidence: 'high' | 'medium' | 'low';
  rationale: string;
  taskDispositions: Array<{
    taskId: string;
    disposition: 'completed' | 'skipped' | 'failed' | 'still_needed';
    reason?: string;
  }>;
  missingWork?: string[];
}

/**
 * Build the context payload for a mission evaluation task.
 * Gathers mission goal, all task statuses, and produces the evaluation prompt.
 */
export async function buildEvaluationContext(missionId: string): Promise<{
  description: string;
  context: Record<string, unknown>;
} | null> {
  const mission = await db.query.missions.findFirst({
    where: eq(missions.id, missionId),
    columns: { id: true, title: true, description: true, status: true },
  });
  if (!mission) return null;

  // Fetch all mission tasks
  const allTasks = await db.query.tasks.findMany({
    where: eq(tasks.missionId, missionId),
    orderBy: [desc(tasks.createdAt)],
    columns: {
      id: true, title: true, status: true, mode: true,
      result: true, createdAt: true, updatedAt: true,
    },
  });

  // Build task disposition summary
  const taskSummary = allTasks
    .filter(t => !t.title.startsWith('Aggregate results:') && !t.title.startsWith('Evaluate mission completion:'))
    .map(t => {
      const result = t.result as Record<string, unknown> | null;
      const summary = result?.summary as string || null;
      return {
        taskId: t.id,
        title: t.title,
        status: t.status,
        mode: t.mode,
        summary,
        updatedAt: t.updatedAt,
      };
    });

  const completed = taskSummary.filter(t => t.status === 'completed');
  const failed = taskSummary.filter(t => t.status === 'failed');
  const pending = taskSummary.filter(t => ['pending', 'assigned', 'in_progress'].includes(t.status));

  // Build evaluation prompt
  const descParts: string[] = [];
  descParts.push(`## Mission Completion Evaluation`);
  descParts.push(`\nYou are an **independent evaluator**. A working agent has signaled that this mission may be complete. Your job is to objectively assess whether the mission goal has been achieved.\n`);

  descParts.push(`### Original Mission Goal`);
  descParts.push(`**${mission.title}**`);
  if (mission.description) descParts.push(mission.description);

  descParts.push(`\n### Task Summary`);
  descParts.push(`- Total tasks: ${taskSummary.length}`);
  descParts.push(`- Completed: ${completed.length}`);
  descParts.push(`- Failed: ${failed.length}`);
  descParts.push(`- In progress / pending: ${pending.length}`);

  if (completed.length > 0) {
    descParts.push(`\n### Completed Tasks`);
    for (const t of completed.slice(0, 15)) {
      descParts.push(`- **${t.title}**: ${t.summary || 'no summary'}`);
    }
    if (completed.length > 15) {
      descParts.push(`  ... and ${completed.length - 15} more`);
    }
  }

  if (failed.length > 0) {
    descParts.push(`\n### Failed Tasks`);
    for (const t of failed) {
      descParts.push(`- **${t.title}**: ${t.summary || 'unknown error'}`);
    }
  }

  if (pending.length > 0) {
    descParts.push(`\n### Still In Progress`);
    for (const t of pending) {
      descParts.push(`- **${t.title}** (${t.status})`);
    }
  }

  descParts.push(`\n### Evaluation Instructions`);
  descParts.push(`1. Compare the original mission goal against the completed work above.`);
  descParts.push(`2. For each task, assign a disposition: completed, skipped (with reason), failed (with reason), or still_needed.`);
  descParts.push(`3. Determine if the mission goal has been substantially achieved.`);
  descParts.push(`4. If tasks are still in progress or pending, the mission is likely NOT complete.`);
  descParts.push(`5. If critical tasks failed and were not retried, the mission is likely NOT complete.`);
  descParts.push(`6. Be conservative: when in doubt, verdict should be "incomplete". A running mission can always be completed later, but a prematurely completed mission stops monitoring.`);
  descParts.push(`7. Respond ONLY with the structured output — no sub-tasks, no tool calls.`);

  const contextData: Record<string, unknown> = {
    missionId: mission.id,
    missionTitle: mission.title,
    evaluator: true,
    taskSummary,
    outputSchema: EVALUATION_OUTPUT_SCHEMA,
  };

  return { description: descParts.join('\n'), context: contextData };
}

/**
 * Spawn an independent evaluation task for a mission.
 * Returns the created task ID, or null if a pending evaluation already exists.
 */
export async function spawnEvaluationTask(
  missionId: string,
  triggeringTaskId: string,
): Promise<string | null> {
  const mission = await db.query.missions.findFirst({
    where: eq(missions.id, missionId),
    columns: {
      id: true, title: true, workspaceId: true,
      lastEvaluationTaskId: true, status: true,
    },
  });
  if (!mission || mission.status !== 'active') return null;

  // Check if there's already a pending/in-progress evaluation
  if (mission.lastEvaluationTaskId) {
    const existingEval = await db.query.tasks.findFirst({
      where: eq(tasks.id, mission.lastEvaluationTaskId),
      columns: { status: true },
    });
    if (existingEval && ['pending', 'assigned', 'in_progress'].includes(existingEval.status)) {
      return null; // Don't spam evaluations
    }
  }

  const evalContext = await buildEvaluationContext(missionId);
  if (!evalContext) return null;

  // Use the mission's workspace
  const workspaceId = mission.workspaceId;
  if (!workspaceId) return null;

  const [evalTask] = await db
    .insert(tasks)
    .values({
      workspaceId,
      title: `Evaluate mission completion: ${mission.title}`,
      description: evalContext.description,
      priority: 1, // Higher priority — evaluate quickly
      status: 'pending',
      mode: 'planning',
      context: {
        ...evalContext.context,
        triggeringTaskId,
      },
      creationSource: 'orchestrator',
      missionId,
      outputSchema: EVALUATION_OUTPUT_SCHEMA as Record<string, unknown>,
    })
    .returning();

  // Update mission to track this evaluation task
  await db
    .update(missions)
    .set({ lastEvaluationTaskId: evalTask.id, updatedAt: new Date() })
    .where(eq(missions.id, missionId));

  // Dispatch the task
  const workspace = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, workspaceId),
  });
  if (workspace) {
    await dispatchNewTask(evalTask, workspace);
  }

  return evalTask.id;
}

/**
 * Handle the result of a completed evaluation task.
 * Decides whether to complete the mission or keep it active with feedback.
 */
export async function handleEvaluationResult(
  missionId: string,
  evaluationTaskId: string,
): Promise<{ action: 'completed' | 'kept_active'; verdict: EvaluationVerdict | null }> {
  const evalTask = await db.query.tasks.findFirst({
    where: eq(tasks.id, evaluationTaskId),
    columns: { result: true, status: true },
  });

  if (!evalTask || evalTask.status !== 'completed') {
    return { action: 'kept_active', verdict: null };
  }

  const result = evalTask.result as Record<string, unknown> | null;
  const structuredOutput = result?.structuredOutput as EvaluationVerdict | undefined;

  // Safe default: if no valid verdict, keep active
  if (!structuredOutput?.verdict || !structuredOutput?.confidence) {
    console.warn(`[evaluation] Missing/malformed verdict for mission ${missionId}, keeping active`);
    return { action: 'kept_active', verdict: null };
  }

  const verdict = structuredOutput;

  // Only auto-complete on high or medium confidence + complete verdict
  if (verdict.verdict === 'complete' && (verdict.confidence === 'high' || verdict.confidence === 'medium')) {
    if (verdict.confidence === 'medium') {
      console.warn(`[evaluation] Medium-confidence completion for mission ${missionId}: ${verdict.rationale}`);
    }

    // Complete the mission
    const mission = await db.query.missions.findFirst({
      where: eq(missions.id, missionId),
      columns: { scheduleId: true },
    });

    await db
      .update(missions)
      .set({ status: 'completed', updatedAt: new Date() })
      .where(eq(missions.id, missionId));

    // Disable schedule
    if (mission?.scheduleId) {
      await db
        .update(taskSchedules)
        .set({ enabled: false, updatedAt: new Date() })
        .where(eq(taskSchedules.id, mission.scheduleId));
    }

    await triggerEvent(
      channels.mission(missionId),
      events.MISSION_LOOP_COMPLETED,
      {
        missionId,
        reason: 'evaluation_complete',
        verdict: verdict.verdict,
        confidence: verdict.confidence,
        rationale: verdict.rationale,
      }
    );

    return { action: 'completed', verdict };
  }

  // Keep active — verdict is incomplete, blocked, or low confidence
  await triggerEvent(
    channels.mission(missionId),
    events.MISSION_CYCLE_STARTED,
    {
      missionId,
      reason: 'evaluation_incomplete',
      verdict: verdict.verdict,
      confidence: verdict.confidence,
      rationale: verdict.rationale,
      missingWork: verdict.missingWork,
    }
  );

  return { action: 'kept_active', verdict };
}
