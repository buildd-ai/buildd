import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { tasks } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { verifyWorkspaceAccess, verifyAccountWorkspaceAccess } from '@/lib/team-access';
import { approvePlan, type PlanStep } from '@/lib/approve-plan';

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
      columns: { id: true, workspaceId: true, mode: true, status: true, result: true },
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
    const plan = structuredOutput?.plan as PlanStep[] | undefined;

    if (!plan || !Array.isArray(plan) || plan.length === 0) {
      return NextResponse.json({ error: 'No plan found in task result' }, { status: 400 });
    }

    const { taskIds } = await approvePlan(id, plan);

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
