import { db } from '@buildd/core/db';
import { tasks, workers, workspaces } from '@buildd/core/db/schema';
import { desc, eq } from 'drizzle-orm';
import { generateTaskBranchName, type BranchNameGitConfig } from '@buildd/core/branch-names';
import type { PlanStep } from '@buildd/shared';

// PlanStep is defined once in @buildd/shared (the planning contract). Re-exported
// here for the existing internal importers (task-dependencies, mission-loop, etc.).
export type { PlanStep } from '@buildd/shared';

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

  const gitConfig = (workspace?.gitConfig as BranchNameGitConfig) || null;

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
        taskClass: 'work',
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

    // Resolve baseBranch ref to the dependency's actual branch
    if (step.baseBranch && refToId[step.baseBranch]) {
      const resolvedBase = await resolveDependencyBranch(
        refToId[step.baseBranch],
        refToTitle[step.baseBranch],
        gitConfig,
      );

      // Merge baseBranch into existing context
      const existingCtx = (await db.query.tasks.findFirst({
        where: eq(tasks.id, refToId[step.ref]),
        columns: { context: true },
      }))?.context as Record<string, unknown> || {};

      updates.context = { ...existingCtx, baseBranch: resolvedBase };
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
 * The branch a plan step should stack on top of: the branch of the dependency
 * task it named via `baseBranch`.
 *
 * Read, do not re-derive. In order:
 *
 *  1. `workers.branch` — the observed branch. Once a worker row exists this is
 *     the branch that IS checked out, including names no formula reproduces:
 *     the claim route's shared mission branch, or the runner's
 *     `<branch>-w<workerId8>` fallback when the requested branch was already
 *     held by another worktree (`git-operations.ts` shared-branch guard).
 *  2. `context.headBranch` — the shared mission working branch (seeded from
 *     `missions.workingBranch`). The claim route uses it verbatim and never
 *     consults the generator, so reading the dependency's persisted context is
 *     how the mission branch is honoured. Today nothing stamps `headBranch`
 *     onto approve-plan's children — only the organizer's own planning task
 *     carries it (`mission-run.ts`) — so this is the branch that starts
 *     mattering the moment a mission integration branch does.
 *  3. Only if neither exists: predict, via the SAME generator the claim route
 *     calls. This is genuinely unavoidable here — pass 1 has only just created
 *     the dependency, so no worker can exist yet — but it is now one function,
 *     not a copy that can drift.
 */
async function resolveDependencyBranch(
  depTaskId: string,
  depTitle: string,
  gitConfig: BranchNameGitConfig | null,
): Promise<string> {
  const worker = await db.query.workers.findFirst({
    where: eq(workers.taskId, depTaskId),
    orderBy: desc(workers.createdAt),
    columns: { branch: true },
  });
  if (worker?.branch) return worker.branch;

  const depContext = (await db.query.tasks.findFirst({
    where: eq(tasks.id, depTaskId),
    columns: { context: true },
  }))?.context as Record<string, unknown> | null | undefined;

  return generateTaskBranchName({
    taskId: depTaskId,
    title: depTitle,
    gitConfig,
    sharedHeadBranch: depContext?.headBranch,
  });
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
