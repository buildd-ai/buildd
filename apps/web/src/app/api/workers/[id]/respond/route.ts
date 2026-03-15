import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { workers, tasks } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { verifyWorkspaceAccess } from '@/lib/team-access';

// POST /api/workers/[id]/respond - Respond to a worker's question, creating a retry task
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  // Dual auth: session OR API key
  const user = await getCurrentUser();
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  const account = await authenticateApiKey(apiKey);

  if (!user && !account) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Load worker with its task
  const worker = await db.query.workers.findFirst({
    where: eq(workers.id, id),
    with: { workspace: true, task: true },
  });

  if (!worker) {
    return NextResponse.json({ error: 'Worker not found' }, { status: 404 });
  }

  // Verify access: API key checks account ownership, session checks workspace membership
  if (account) {
    if (worker.accountId !== account.id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
  } else if (user) {
    const access = await verifyWorkspaceAccess(user.id, worker.workspaceId);
    if (!access) {
      return NextResponse.json({ error: 'Worker not found' }, { status: 404 });
    }
  }

  // Worker must have waitingFor set (status failed with needs_input or waiting_input)
  if (!worker.waitingFor) {
    return NextResponse.json(
      { error: 'Worker is not waiting for input' },
      { status: 400 }
    );
  }

  const body = await req.json();
  const { message } = body;

  if (!message || typeof message !== 'string') {
    return NextResponse.json(
      { error: 'Message is required' },
      { status: 400 }
    );
  }

  const task = (worker as any).task;
  const milestones = (worker.milestones as Array<{ label: string; timestamp: number }>) || [];
  const question = (worker.waitingFor as { prompt: string }).prompt;
  const taskContext = (task?.context as Record<string, unknown>) || {};
  const currentIteration = (taskContext.iteration as number) || 1;

  // Build structured description
  const milestonesText = milestones.length > 0
    ? milestones.map(m => `- ${m.label}`).join('\n')
    : 'No milestones recorded';

  const description = [
    '## Original Task',
    task?.description || '',
    '',
    '## What Was Accomplished',
    milestonesText,
    '',
    '## Question Asked',
    question,
    '',
    '## User Response',
    message,
  ].join('\n');

  // Create the new retry task
  const [newTask] = await db
    .insert(tasks)
    .values({
      workspaceId: worker.workspaceId,
      title: `Continue: ${task?.title || 'Unknown task'}`,
      description,
      status: 'pending',
      parentTaskId: task?.id,
      objectiveId: task?.objectiveId,
      context: {
        baseBranch: worker.branch,
        userInput: message,
        previousAttempt: {
          question,
          milestones,
          branch: worker.branch,
          workerId: worker.id,
        },
        iteration: currentIteration + 1,
      },
    })
    .returning();

  // Mark original worker as completed (superseded)
  await db
    .update(workers)
    .set({
      status: 'completed',
      waitingFor: null,
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(workers.id, id))
    .returning();

  return NextResponse.json({ taskId: newTask.id });
}
