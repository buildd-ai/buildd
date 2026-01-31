import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { tasks } from '@buildd/core/db/schema';
import { desc } from 'drizzle-orm';
import { auth } from '@/auth';
import { triggerEvent, channels, events } from '@/lib/pusher';

export async function GET() {
  // Dev mode returns empty
  if (process.env.NODE_ENV === 'development') {
    return NextResponse.json({ tasks: [] });
  }

  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const allTasks = await db.query.tasks.findMany({
      orderBy: desc(tasks.createdAt),
      with: { workspace: true },
    });

    return NextResponse.json({ tasks: allTasks });
  } catch (error) {
    console.error('Get tasks error:', error);
    return NextResponse.json({ error: 'Failed to get tasks' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  // Dev mode returns mock
  if (process.env.NODE_ENV === 'development') {
    return NextResponse.json({ id: 'dev-task', title: 'Dev Task' });
  }

  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await req.json();
    const { workspaceId, title, description, priority } = body;

    if (!workspaceId || !title) {
      return NextResponse.json({ error: 'Workspace and title are required' }, { status: 400 });
    }

    const [task] = await db
      .insert(tasks)
      .values({
        workspaceId,
        title,
        description: description || null,
        priority: priority || 0,
        status: 'pending',
      })
      .returning();

    // Trigger realtime event (no-op if Pusher not configured)
    await triggerEvent(
      channels.workspace(workspaceId),
      events.TASK_CREATED,
      { task }
    );

    return NextResponse.json(task);
  } catch (error) {
    console.error('Create task error:', error);
    return NextResponse.json({ error: 'Failed to create task' }, { status: 500 });
  }
}
