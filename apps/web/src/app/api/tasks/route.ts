import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { accounts, tasks } from '@buildd/core/db/schema';
import { desc, eq } from 'drizzle-orm';
import { auth } from '@/auth';
import { triggerEvent, channels, events } from '@/lib/pusher';

async function authenticateApiKey(apiKey: string | null) {
  if (!apiKey) return null;
  const account = await db.query.accounts.findFirst({
    where: eq(accounts.apiKey, apiKey),
  });
  return account || null;
}

export async function GET(req: NextRequest) {
  // Dev mode returns empty
  if (process.env.NODE_ENV === 'development') {
    return NextResponse.json({ tasks: [] });
  }

  // Check API key auth first
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  const account = await authenticateApiKey(apiKey);

  // Fall back to session auth
  const session = await auth();

  if (!account && !session?.user) {
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

  // Check API key auth first
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  const account = await authenticateApiKey(apiKey);

  // Fall back to session auth
  const session = await auth();

  if (!account && !session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await req.json();
    const { workspaceId, title, description, priority, runnerPreference, requiredCapabilities, attachments } = body;

    if (!workspaceId || !title) {
      return NextResponse.json({ error: 'Workspace and title are required' }, { status: 400 });
    }

    // Process attachments - store as base64 in context
    const processedAttachments: Array<{ filename: string; mimeType: string; data: string }> = [];
    if (attachments && Array.isArray(attachments)) {
      for (const att of attachments) {
        if (att.data && att.mimeType && att.filename) {
          // data is already base64 data URL from client
          processedAttachments.push({
            filename: att.filename,
            mimeType: att.mimeType,
            data: att.data, // data:image/png;base64,...
          });
        }
      }
    }

    const [task] = await db
      .insert(tasks)
      .values({
        workspaceId,
        title,
        description: description || null,
        priority: priority || 0,
        status: 'pending',
        runnerPreference: runnerPreference || 'any',
        requiredCapabilities: requiredCapabilities || [],
        context: processedAttachments.length > 0 ? { attachments: processedAttachments } : {},
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
