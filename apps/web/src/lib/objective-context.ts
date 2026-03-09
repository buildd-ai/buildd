import { db } from '@buildd/core/db';
import { tasks, objectives, taskRecipes } from '@buildd/core/db/schema';
import { eq, and, inArray, desc } from 'drizzle-orm';

const HEARTBEAT_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['ok', 'action_taken', 'error'] },
    summary: { type: 'string' },
    checksPerformed: { type: 'array', items: { type: 'string' } },
    actionsPerformed: { type: 'array', items: { type: 'string' } },
  },
  required: ['status'],
};

function timeAgo(date: Date | string): string {
  const ms = Date.now() - new Date(date).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/**
 * Check if the current hour falls within an active hours window.
 * Handles both normal ranges (9-17) and overnight ranges (22-6).
 */
export function isWithinActiveHours(currentHour: number, start: number, end: number): boolean {
  if (start < end) {
    // Normal range: e.g., 9-17
    return currentHour >= start && currentHour < end;
  }
  if (start > end) {
    // Overnight range: e.g., 22-6
    return currentHour >= start || currentHour < end;
  }
  // start === end means all hours active
  return true;
}

/**
 * Build rich context for an objective planning task.
 * Queries task history, active tasks, failures, and optional recipe playbook.
 * Detects heartbeat mode and produces specialised instructions.
 */
export async function buildObjectiveContext(objectiveId: string, templateContext?: Record<string, unknown>) {
  const objective = await db.query.objectives.findFirst({
    where: eq(objectives.id, objectiveId),
    columns: {
      id: true,
      title: true,
      description: true,
      status: true,
      priority: true,
      isHeartbeat: true,
      heartbeatChecklist: true,
    },
  });
  if (!objective) return null;

  // ── Heartbeat mode ──
  if ((objective as any).isHeartbeat === true) {
    return buildHeartbeatContext(objective as any);
  }

  // ── Standard objective context ──
  // Last 10 completed tasks
  const completedTasks = await db.query.tasks.findMany({
    where: and(
      eq(tasks.objectiveId, objectiveId),
      eq(tasks.status, 'completed')
    ),
    orderBy: [desc(tasks.createdAt)],
    limit: 10,
    columns: { id: true, title: true, mode: true, result: true, createdAt: true },
  });

  // Active tasks
  const activeTasks = await db.query.tasks.findMany({
    where: and(
      eq(tasks.objectiveId, objectiveId),
      inArray(tasks.status, ['pending', 'assigned', 'in_progress'])
    ),
    limit: 5,
    columns: { id: true, title: true, status: true },
  });

  // Recent failed tasks
  const failedTasks = await db.query.tasks.findMany({
    where: and(
      eq(tasks.objectiveId, objectiveId),
      eq(tasks.status, 'failed')
    ),
    orderBy: [desc(tasks.createdAt)],
    limit: 3,
    columns: { id: true, title: true, result: true },
  });

  // Recipe playbook (if configured)
  const recipeId = templateContext?.recipeId as string | undefined;
  let recipeSteps: unknown[] | null = null;
  if (recipeId) {
    const recipe = await db.query.taskRecipes.findFirst({
      where: eq(taskRecipes.id, recipeId),
      columns: { name: true, steps: true },
    });
    if (recipe) {
      recipeSteps = recipe.steps as unknown[];
    }
  }

  // Build rich description
  const descParts: string[] = [];
  descParts.push(`## Objective: ${objective.title}`);
  if (objective.description) descParts.push(objective.description);

  if (completedTasks.length > 0) {
    descParts.push('\n## Prior Results (last 10)');
    for (const t of completedTasks) {
      const result = t.result as Record<string, unknown> | null;
      const summary = result?.summary as string || 'no summary';
      const structuredOutput = result?.structuredOutput;
      let line = `- [${t.title}] ${timeAgo(t.createdAt)}: ${summary}`;
      if (structuredOutput) {
        line += `\n  ${JSON.stringify(structuredOutput)}`;
      }
      descParts.push(line);
    }
  }

  if (activeTasks.length > 0) {
    descParts.push('\n## Active Tasks');
    for (const t of activeTasks) {
      descParts.push(`- [${t.title}] status: ${t.status}`);
    }
  }

  if (failedTasks.length > 0) {
    descParts.push('\n## Failed Tasks (recent)');
    for (const t of failedTasks) {
      const result = t.result as Record<string, unknown> | null;
      const errorSummary = result?.summary as string || 'unknown error';
      descParts.push(`- [${t.title}] error: ${errorSummary}`);
    }
  }

  if (recipeSteps) {
    descParts.push('\n## Playbook');
    for (const step of recipeSteps as Array<{ ref?: string; title?: string; description?: string }>) {
      descParts.push(`- [ ] ${step.title || step.ref}${step.description ? `: ${step.description}` : ''}`);
    }
  }

  // Dedup guidance: detect repetitive results and warn planner
  descParts.push('\n## Instructions');
  if (completedTasks.length >= 3) {
    const summaries = completedTasks
      .map(t => (t.result as Record<string, unknown> | null)?.summary as string || '')
      .filter(Boolean);
    const uniqueSummaries = new Set(summaries);
    if (uniqueSummaries.size <= 2) {
      descParts.push(
        '⚠️ Recent tasks produced nearly identical results. Focus on what has CHANGED since the last run. ' +
        'Do NOT repeat the same analysis — identify new developments, blockers removed, or status changes. ' +
        'If nothing meaningful has changed, create fewer or no sub-tasks.'
      );
    }
  }
  descParts.push(
    'Review the prior results above. Plan the NEXT concrete steps toward the objective. ' +
    'Avoid duplicating work already completed or in progress.'
  );

  // Build context JSONB
  const contextData: Record<string, unknown> = {
    objectiveId: objective.id,
    objectiveTitle: objective.title,
    recentCompletions: completedTasks.map(t => {
      const result = t.result as Record<string, unknown> | null;
      return {
        taskId: t.id,
        title: t.title,
        mode: t.mode,
        summary: result?.summary || null,
        structuredOutput: result?.structuredOutput || null,
        completedAt: t.createdAt,
      };
    }),
    activeTasks: activeTasks.map(t => ({
      taskId: t.id,
      title: t.title,
      status: t.status,
    })),
    ...(recipeSteps ? { recipeSteps } : {}),
  };

  return { description: descParts.join('\n'), context: contextData };
}

/**
 * Build context specifically for heartbeat objectives.
 * Produces a checklist-focused description with compact prior results.
 */
async function buildHeartbeatContext(objective: {
  id: string;
  title: string;
  description: string | null;
  heartbeatChecklist: string | null;
}) {
  // Last 3 completed heartbeat results (compact)
  const priorHeartbeats = await db.query.tasks.findMany({
    where: and(
      eq(tasks.objectiveId, objective.id),
      eq(tasks.status, 'completed')
    ),
    orderBy: [desc(tasks.createdAt)],
    limit: 3,
    columns: { result: true, createdAt: true },
  });

  const descParts: string[] = [];
  descParts.push(`## Heartbeat: ${objective.title}`);
  if (objective.description) descParts.push(objective.description);

  descParts.push('\n## Checklist');
  descParts.push(objective.heartbeatChecklist || '(no checklist configured)');

  descParts.push('\n## Protocol');
  descParts.push(`You are running a periodic heartbeat check. Follow the checklist above.
- Perform each check item and note the result.
- If ALL checks pass with no action needed, report status "ok" with a one-line summary.
- If you took action on any check, report status "action_taken" and describe what you did.
- Do NOT repeat the same analysis as prior runs unless something has changed.
- Batch all checks into a single pass. Only create sub-tasks if a check explicitly requires external work.`);

  if (priorHeartbeats.length > 0) {
    descParts.push('\n## Prior Heartbeats');
    for (const t of priorHeartbeats) {
      const result = t.result as Record<string, unknown> | null;
      const so = result?.structuredOutput as Record<string, unknown> | undefined;
      const status = so?.status || 'unknown';
      const summary = so?.summary || result?.summary || 'no summary';
      descParts.push(`- ${timeAgo(t.createdAt)}: [${status}] ${summary}`);
    }
  }

  const contextData: Record<string, unknown> = {
    objectiveId: objective.id,
    objectiveTitle: objective.title,
    heartbeat: true,
    heartbeatChecklist: objective.heartbeatChecklist,
    outputSchema: HEARTBEAT_OUTPUT_SCHEMA,
  };

  return { description: descParts.join('\n'), context: contextData };
}
