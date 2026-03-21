import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { tasks } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { verifyWorkspaceAccess, verifyAccountWorkspaceAccess } from '@/lib/team-access';

// POST /api/tasks/[id]/approve-plan - Approve a planning task's plan and create child execution tasks
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const user = await getCurrentUser();
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  const apiAccount = await authenticateApiKey(apiKey);

  if (!user && !apiAccount) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const task = await db.query.tasks.findFirst({
      where: eq(tasks.id, id),
      with: { workspace: true },
    });

    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    // Verify access
    if (user && !apiAccount) {
      const access = await verifyWorkspaceAccess(user.id, task.workspaceId);
      if (!access) return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    } else if (apiAccount) {
      const hasAccess = await verifyAccountWorkspaceAccess(apiAccount.id, task.workspaceId);
      if (!hasAccess) return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    // Validate task state
    if (task.mode !== 'planning') {
      return NextResponse.json({ error: 'Task is not a planning task' }, { status: 400 });
    }

    if (task.status !== 'completed') {
      return NextResponse.json({ error: 'Planning task has not completed yet' }, { status: 400 });
    }

    // Extract plan from structured output
    const result = task.result as Record<string, unknown> | null;
    const structuredOutput = result?.structuredOutput as Record<string, unknown> | undefined;
    const plan = structuredOutput?.plan as Array<{
      ref: string;
      title: string;
      description: string;
      dependsOn?: string[];
      requiredCapabilities?: string[];
      outputRequirement?: string;
      priority?: number;
    }> | undefined;

    if (!plan || !Array.isArray(plan) || plan.length === 0) {
      return NextResponse.json({ error: 'No plan found in task result' }, { status: 400 });
    }

    // Guard: prevent duplicate approval
    const existingChildren = await db.query.tasks.findMany({
      where: eq(tasks.parentTaskId, id),
      columns: { id: true },
    });
    if (existingChildren.length > 0) {
      return NextResponse.json({ error: 'Plan already approved' }, { status: 409 });
    }

    // Validate: no circular dependencies in plan steps
    const cycle = detectCircularDeps(plan);
    if (cycle) {
      return NextResponse.json(
        { error: `Circular dependency detected: ${cycle.join(' → ')}` },
        { status: 400 }
      );
    }

    // Create child tasks and build ref-to-id mapping
    const refToId: Record<string, string> = {};
    const createdTaskIds: string[] = [];

    // First pass: create all tasks without dependsOn to get their IDs
    for (const step of plan) {
      const [created] = await db
        .insert(tasks)
        .values({
          workspaceId: task.workspaceId,
          title: step.title,
          description: step.description || null,
          parentTaskId: id,
          missionId: task.missionId,
          mode: 'execution',
          creationSource: 'api',
          status: 'pending',
          priority: step.priority ?? 0,
          requiredCapabilities: step.requiredCapabilities ?? [],
          outputRequirement: step.outputRequirement as 'pr_required' | 'artifact_required' | 'none' | 'auto' | undefined,
          dependsOn: [], // Will update in second pass
        })
        .returning();

      refToId[step.ref] = created.id;
      createdTaskIds.push(created.id);
    }

    // Second pass: update dependsOn with resolved task IDs
    for (const step of plan) {
      if (step.dependsOn && step.dependsOn.length > 0) {
        const resolvedDeps = step.dependsOn
          .map((ref) => refToId[ref])
          .filter(Boolean);

        if (resolvedDeps.length > 0) {
          await db
            .update(tasks)
            .set({ dependsOn: resolvedDeps, updatedAt: new Date() })
            .where(eq(tasks.id, refToId[step.ref]));
        }
      }
    }

    return NextResponse.json({ tasks: createdTaskIds });
  } catch (error) {
    console.error('Approve plan error:', error);
    return NextResponse.json({ error: 'Failed to approve plan' }, { status: 500 });
  }
}

/**
 * Detect circular dependencies in plan steps using DFS.
 * Returns the cycle path if found, null otherwise.
 */
function detectCircularDeps(
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
      // Found cycle — return from the cycle start point
      const cycleStart = path.indexOf(node);
      return [...path.slice(cycleStart), node];
    }
    if (visited.has(node)) return null;

    visited.add(node);
    inStack.add(node);
    path.push(node);

    for (const dep of graph.get(node) ?? []) {
      // Only check deps that are in the plan (external refs are fine)
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
