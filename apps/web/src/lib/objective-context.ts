import { db } from '@buildd/core/db';
import { objectives, tasks, taskRecipes } from '@buildd/core/db/schema';
import { eq, and, inArray, desc } from 'drizzle-orm';

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
 * Build rich context for an objective planning task.
 * Queries task history, active tasks, failures, and optional recipe playbook.
 */
export async function buildObjectiveContext(objectiveId: string, templateContext?: Record<string, unknown>) {
  const objective = await db.query.objectives.findFirst({
    where: eq(objectives.id, objectiveId),
    columns: { id: true, title: true, description: true, status: true, priority: true },
  });
  if (!objective) return null;

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

  // Detect if recent results are repetitive (same summaries)
  const recentSummaries = completedTasks.slice(0, 5).map(t => {
    const result = t.result as Record<string, unknown> | null;
    return result?.summary as string || '';
  }).filter(Boolean);
  const uniqueSummaries = new Set(recentSummaries);
  const isRepetitive = recentSummaries.length >= 3 && uniqueSummaries.size <= 2;

  // Build rich description
  const descParts: string[] = [];
  descParts.push(`## Objective: ${objective.title}`);
  if (objective.description) descParts.push(objective.description);

  // Planner guidance
  descParts.push('\n## Instructions');
  descParts.push('Review the prior results below. Focus on what has CHANGED since the last run.');
  descParts.push('- If nothing meaningful has changed, produce a brief "no changes" summary — do NOT repeat the same analysis.');
  descParts.push('- Only create new execution tasks when there is genuinely new information or action needed.');
  descParts.push('- If the prior results show the same outcome repeatedly, skip redundant checks and focus on anything that is actually different or newly due.');
  if (isRepetitive) {
    descParts.push('\n> ⚠️ The last several runs produced nearly identical results. Only report if something has CHANGED or a new action is due. If nothing is new, respond with a minimal confirmation.');
  }

  if (completedTasks.length > 0) {
    // Show fewer results when repetitive — just the latest plus one older for context
    const tasksToShow = isRepetitive ? completedTasks.slice(0, 2) : completedTasks;
    const label = isRepetitive ? 'Prior Results (latest — earlier runs were similar)' : `Prior Results (last ${tasksToShow.length})`;
    descParts.push(`\n## ${label}`);
    for (const t of tasksToShow) {
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
    isRepetitive,
  };

  return { description: descParts.join('\n'), context: contextData };
}
