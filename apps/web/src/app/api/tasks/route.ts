import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { accounts, tasks, workspaces, accountWorkspaces, workers } from '@buildd/core/db/schema';
import { desc, eq, inArray, or } from 'drizzle-orm';
import { triggerEvent, channels, events } from '@/lib/pusher';
import { getCurrentUser } from '@/lib/auth-helpers';

type CreationSource = 'dashboard' | 'api' | 'mcp' | 'github' | 'local_ui';

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
  const apiAccount = await authenticateApiKey(apiKey);

  // Fall back to session auth
  const user = await getCurrentUser();

  if (!apiAccount && !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    // Get workspace IDs based on auth type
    let workspaceIds: string[] = [];

    if (apiAccount) {
      // For API key auth, get:
      // 1. Workspaces explicitly linked to the account
      // 2. Open workspaces (accessMode = 'open')
      const [linkedWorkspaces, openWorkspaces] = await Promise.all([
        db.query.accountWorkspaces.findMany({
          where: eq(accountWorkspaces.accountId, apiAccount.id),
          columns: { workspaceId: true },
        }),
        db.query.workspaces.findMany({
          where: eq(workspaces.accessMode, 'open'),
          columns: { id: true },
        }),
      ]);
      const linkedIds = linkedWorkspaces.map(aw => aw.workspaceId);
      const openIds = openWorkspaces.map(w => w.id);
      workspaceIds = [...new Set([...linkedIds, ...openIds])];
    } else {
      // For session auth, get user's workspaces
      const userWorkspaces = await db.query.workspaces.findMany({
        where: eq(workspaces.ownerId, user!.id),
        columns: { id: true },
      });
      workspaceIds = userWorkspaces.map(w => w.id);
    }

    // Get tasks from the resolved workspace IDs
    const allTasks = workspaceIds.length > 0
      ? await db.query.tasks.findMany({
          where: inArray(tasks.workspaceId, workspaceIds),
          orderBy: desc(tasks.createdAt),
          with: { workspace: true },
        })
      : [];

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
  const apiAccount = await authenticateApiKey(apiKey);

  // Fall back to session auth
  const user = await getCurrentUser();

  if (!apiAccount && !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await req.json();
    const {
      workspaceId,
      title,
      description,
      priority,
      runnerPreference,
      requiredCapabilities,
      attachments,
      // New creator tracking fields
      createdByWorkerId,
      parentTaskId,
      creationSource: requestedSource,
    } = body;

    if (!workspaceId || !title) {
      return NextResponse.json({ error: 'Workspace and title are required' }, { status: 400 });
    }

    // Determine creator account ID
    let createdByAccountId: string | null = null;
    if (apiAccount) {
      createdByAccountId = apiAccount.id;
    } else if (user) {
      // For session auth, get the user's first account (primary)
      const userAccount = await db.query.accounts.findFirst({
        where: eq(accounts.ownerId, user.id),
      });
      createdByAccountId = userAccount?.id || null;
    }

    // Determine creation source
    let creationSource: CreationSource = 'api';
    if (requestedSource && ['dashboard', 'api', 'mcp', 'github', 'local_ui'].includes(requestedSource)) {
      creationSource = requestedSource as CreationSource;
    } else if (!apiAccount && user) {
      // Session auth typically means dashboard
      creationSource = 'dashboard';
    }

    // Validate createdByWorkerId if provided
    let validatedWorkerId: string | null = null;
    let derivedParentTaskId: string | null = parentTaskId || null;
    if (createdByWorkerId) {
      const worker = await db.query.workers.findFirst({
        where: eq(workers.id, createdByWorkerId),
      });
      if (worker) {
        // Validate worker belongs to the authenticated account
        if (apiAccount && worker.accountId === apiAccount.id) {
          validatedWorkerId = createdByWorkerId;
          // Auto-derive parentTaskId from worker's current task if not provided
          if (!derivedParentTaskId && worker.taskId) {
            derivedParentTaskId = worker.taskId;
          }
        }
        // For session auth, allow if worker is in a workspace owned by user
        else if (user) {
          const workspace = await db.query.workspaces.findFirst({
            where: eq(workspaces.id, worker.workspaceId),
          });
          if (workspace?.ownerId === user.id) {
            validatedWorkerId = createdByWorkerId;
            if (!derivedParentTaskId && worker.taskId) {
              derivedParentTaskId = worker.taskId;
            }
          }
        }
      }
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
        // Creator tracking
        createdByAccountId,
        createdByWorkerId: validatedWorkerId,
        creationSource,
        parentTaskId: derivedParentTaskId,
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
