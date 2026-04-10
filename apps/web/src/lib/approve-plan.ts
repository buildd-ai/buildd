import { db } from '@buildd/core/db';
import { tasks, workspaces } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';

export interface PlanStep {
  ref: string;
  title: string;
  description: string;
  dependsOn?: string[];
  baseBranch?: string;
  roleSlug?: string;
  requiredCapabilities?: string[];
  outputRequirement?: string;
  priority?: number;
  model?: string;
  skillSlugs?: string[];
}

export interface ApprovePlanResult {
  taskIds: string[];
}

/**
 * Create child execution tasks from a planning task's structured plan.
 *
 * Two-pass process:
 * 1. Create all tasks with empty dependsOn (to get IDs)
 * 2. Resolve ref→ID for dependsOn and baseBranch
 *
 * Throws on circular dependencies or if plan was already approved.
 */
export async function approvePlan(
  planningTaskId: string,
  plan: PlanStep[],
  options?: { autoApproved?: boolean }
): Promise<ApprovePlanResult> {
  // Fetch the planning task for workspace/mission context
  const task = await db.query.tasks.findFirst({
    where: eq(tasks.id, planningTaskId),
    columns: { id: true, workspaceId: true, missionId: true },
  });

  if (!task) {
    throw new Error(`Planning task ${planningTaskId} not found`);
  }

  // Fetch workspace git config for branch name prediction
  const workspace = task.workspaceId
    ? await db.query.workspaces.findFirst({
        where: eq(workspaces.id, task.workspaceId),
        columns: { gitConfig: true },
      })
    : null;

  const gitConfig = (workspace?.gitConfig as {
    branchingStrategy?: string;
    branchPrefix?: string;
  }) || null;

  // Guard: prevent duplicate approval
  const existingChildren = await db.query.tasks.findMany({
    where: eq(tasks.parentTaskId, planningTaskId),
    columns: { id: true },
    limit: 1,
  });
  if (existingChildren.length > 0) {
    throw new Error('Plan already approved — child tasks exist');
  }

  // Validate: no circular dependencies
  const cycle = detectCircularDeps(plan);
  if (cycle) {
    throw new Error(`Circular dependency detected: ${cycle.join(' → ')}`);
  }

  // First pass: create all tasks with empty dependsOn to get their IDs
  const refToId: Record<string, string> = {};
  const refToTitle: Record<string, string> = {};
  const createdTaskIds: string[] = [];

  for (const step of plan) {
    const [created] = await db
      .insert(tasks)
      .values({
        workspaceId: task.workspaceId,
        title: step.title,
        description: step.description || null,
        parentTaskId: planningTaskId,
        missionId: task.missionId,
        mode: 'execution',
        creationSource: options?.autoApproved ? 'orchestrator' : 'api',
        status: 'pending',
        priority: step.priority ?? 0,
        roleSlug: step.roleSlug || null,
        requiredCapabilities: step.requiredCapabilities ?? [],
        outputRequirement: step.outputRequirement as 'pr_required' | 'artifact_required' | 'none' | 'auto' | undefined,
        dependsOn: [], // Updated in second pass
        context: {
          ...(step.model ? { model: step.model } : {}),
          ...(step.skillSlugs?.length ? { skillSlugs: step.skillSlugs } : {}),
          ...(options?.autoApproved ? { autoApproved: true } : {}),
        },
      })
      .returning();

    refToId[step.ref] = created.id;
    refToTitle[step.ref] = step.title;
    createdTaskIds.push(created.id);
  }

  // Second pass: resolve dependsOn refs and baseBranch to actual IDs/branch names
  for (const step of plan) {
    const updates: Record<string, unknown> = { updatedAt: new Date() };

    if (step.dependsOn && step.dependsOn.length > 0) {
      const resolvedDeps = step.dependsOn
        .map((ref) => refToId[ref])
        .filter(Boolean);
      if (resolvedDeps.length > 0) {
        updates.dependsOn = resolvedDeps;
      }
    }

    // Resolve baseBranch ref to predicted branch name
    if (step.baseBranch && refToId[step.baseBranch]) {
      const depTaskId = refToId[step.baseBranch];
      const depTitle = refToTitle[step.baseBranch];
      const sanitizedTitle = depTitle
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .substring(0, 30);
      const taskIdShort = depTaskId.substring(0, 8);

      let predictedBranch: string;
      if (gitConfig?.branchingStrategy === 'none') {
        predictedBranch = `task-${taskIdShort}`;
      } else if (gitConfig?.branchPrefix) {
        predictedBranch = `${gitConfig.branchPrefix}${taskIdShort}-${sanitizedTitle}`;
      } else {
        predictedBranch = `buildd/${taskIdShort}-${sanitizedTitle}`;
      }

      // Merge baseBranch into existing context
      const existingCtx = (await db.query.tasks.findFirst({
        where: eq(tasks.id, refToId[step.ref]),
        columns: { context: true },
      }))?.context as Record<string, unknown> || {};

      updates.context = { ...existingCtx, baseBranch: predictedBranch };
    }

    if (Object.keys(updates).length > 1) { // more than just updatedAt
      await db
        .update(tasks)
        .set(updates as any)
        .where(eq(tasks.id, refToId[step.ref]));
    }
  }

  return { taskIds: createdTaskIds };
}

/**
 * Detect circular dependencies in plan steps using DFS.
 * Returns the cycle path if found, null otherwise.
 */
export function detectCircularDeps(
  steps: Array<{ ref: string; dependsOn?: string[] }>
): string[] | null {
  const graph = new Map<string, string[]>();
  for (const step of steps) {
    graph.set(step.ref, step.dependsOn ?? []);
  }

  const visited = new Set<string>();
  const inStack = new Set<string>();

  function dfs(node: string, path: string[]): string[] | null {
    if (inStack.has(node)) {
      const cycleStart = path.indexOf(node);
      return [...path.slice(cycleStart), node];
    }
    if (visited.has(node)) return null;

    visited.add(node);
    inStack.add(node);
    path.push(node);

    for (const dep of graph.get(node) ?? []) {
      if (graph.has(dep)) {
        const cycle = dfs(dep, path);
        if (cycle) return cycle;
      }
    }

    path.pop();
    inStack.delete(node);
    return null;
  }

  for (const ref of graph.keys()) {
    const cycle = dfs(ref, []);
    if (cycle) return cycle;
  }
  return null;
}
