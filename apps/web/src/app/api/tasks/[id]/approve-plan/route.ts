import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { tasks } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateTaskScopedCaller, taskScopeAllowsMissionTask } from '@/lib/task-token-auth';
import { verifyWorkspaceAccess, verifyAccountWorkspaceAccess } from '@/lib/team-access';
import { approvePlan, type PlanStep } from '@/lib/approve-plan';
import { isUuid } from '@/lib/uuid';
import { requestingPerson } from '@/lib/request-person';
import { sqlWhere } from '@buildd/core/db/relational-sql';

// POST /api/tasks/[id]/approve-plan - Approve a planning task's plan and create child execution tasks
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!isUuid(id)) {
    return NextResponse.json({ error: `Invalid task id: expected a UUID, got "${id}". Pass the full UUID.` }, { status: 404 });
  }

  const user = await getCurrentUser();
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  // A per-task token decides a plan only as an orchestration run (admin
  // level), and only a planning task on its own task's mission, never its own.
  const apiAccount = await authenticateTaskScopedCaller(apiKey, req);

  if (!user && !apiAccount) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const task = await db.query.tasks.findFirst({
      where: sqlWhere(eq(tasks.id, id)),
      columns: { id: true, workspaceId: true, missionId: true, mode: true, status: true, result: true, context: true },
    });

    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }
    // taskScopeAllowsMissionTask admits a sibling task for an orchestration
    // (admin) token only; its own task is refused here.
    if (apiAccount?.taskScope && (
      task.id === apiAccount.taskScope.taskId
      || !(await taskScopeAllowsMissionTask(apiAccount, task))
    )) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }
    // A plan marked for a person's review stays a person's call: a dashboard
    // session or the person's own OAuth session, never an API key, a per-task
    // token or an 'agent' grant (spec 7702c32a AC-3).
    const person = requestingPerson(user, apiAccount);
    if (!person && (task.context as Record<string, unknown> | null)?.requiresPlanApproval === true) {
      return NextResponse.json({ error: 'This plan requires approval by a person; an agent or API key cannot approve it' }, { status: 403 });
    }

    // Verify access
    if (user && !apiAccount) {
      const access = await verifyWorkspaceAccess(user.id, task.workspaceId);
      if (!access) return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    } else if (apiAccount) {
      const hasAccess = await verifyAccountWorkspaceAccess(apiAccount, task.workspaceId);
      if (!hasAccess) return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    // Validate task state
    if (task.mode !== 'planning') {
      return NextResponse.json({ error: 'Task is not a planning task' }, { status: 400 });
    }

    if (task.status !== 'completed') {
      return NextResponse.json({ error: 'Planning task has not completed yet' }, { status: 400 });
    }

    // A rejected plan is not approvable. The reviewer's verdict stands until a
    // revised planning task produces a new plan (POST /reject-plan links the two
    // via context.previousPlanTaskId).
    const taskContext = (task.context as Record<string, unknown> | null) || {};
    if (taskContext.planRejection) {
      return NextResponse.json(
        { error: 'Plan was rejected — approve the revised plan instead' },
        { status: 409 },
      );
    }

    // Extract plan from structured output
    const result = task.result as Record<string, unknown> | null;
    const structuredOutput = result?.structuredOutput as Record<string, unknown> | undefined;
    const plan = structuredOutput?.plan as PlanStep[] | undefined;

    if (!plan || !Array.isArray(plan) || plan.length === 0) {
      return NextResponse.json({ error: 'No plan found in task result' }, { status: 400 });
    }

    const { taskIds } = await approvePlan(id, plan, { approvedBy: planApprover(person, apiAccount) });

    return NextResponse.json({ tasks: taskIds });
  } catch (error: any) {
    if (error.message?.includes('already approved')) {
      return NextResponse.json({ error: 'Plan already approved' }, { status: 409 });
    }
    if (error.message?.includes('Circular dependency')) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error('Approve plan error:', error);
    return NextResponse.json({ error: 'Failed to approve plan' }, { status: 500 });
  }
}

/**
 * Who approved, as a kernel-style actor: `human:<userId>` for a person,
 * `agent:task:<taskId>` for an orchestration run, `agent:account:<id>` for a
 * plain key. Recorded on each child, apart from who the work is for.
 */
function planApprover(person: string | null, apiAccount: { id: string; taskScope?: { taskId: string } } | null): string {
  if (person) return `human:${person}`;
  if (apiAccount?.taskScope) return `agent:task:${apiAccount.taskScope.taskId}`;
  return `agent:account:${apiAccount?.id ?? 'unknown'}`;
}
