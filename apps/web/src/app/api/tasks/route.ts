import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { tasks, workspaces, accountWorkspaces, type WorkspaceWebhookConfig } from '@buildd/core/db/schema';
import { desc, eq, inArray } from 'drizzle-orm';
import { triggerEvent, channels, events } from '@/lib/pusher';
import { getCurrentUser } from '@/lib/auth-helpers';
import { resolveCreatorContext } from '@/lib/task-service';
import { authenticateApiKey } from '@/lib/api-auth';

/**
 * Dispatch task to external webhook (e.g., OpenClaw)
 */
async function dispatchToWebhook(
  webhookConfig: WorkspaceWebhookConfig,
  task: { id: string; title: string; description: string | null; workspaceId: string }
): Promise<boolean> {
  if (!webhookConfig.enabled || !webhookConfig.url) {
    return false;
  }

  try {
    // Build message for OpenClaw-style webhook
    const message = `Work on Buildd task: ${task.title}

${task.description || 'No description provided.'}

---
Task ID: ${task.id}
Report progress: POST ${process.env.NEXT_PUBLIC_APP_URL || 'https://app.buildd.dev'}/api/workers/{workerId}`;

    const response = await fetch(webhookConfig.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${webhookConfig.token}`,
      },
      body: JSON.stringify({
        message,
        sessionKey: `buildd-${task.id}`,
        name: 'buildd',
      }),
    });

    if (!response.ok) {
      console.error(`Webhook dispatch failed: ${response.status} ${await response.text()}`);
      return false;
    }

    console.log(`Task ${task.id} dispatched to webhook: ${webhookConfig.url}`);
    return true;
  } catch (error) {
    console.error('Webhook dispatch error:', error);
    return false;
  }
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
      mode,  // 'execution' (default) or 'planning'
      runnerPreference,
      requiredCapabilities,
      attachments,
      // New creator tracking fields
      createdByWorkerId,
      parentTaskId,
      creationSource: requestedSource,
      // Direct assignment to a specific local-ui instance
      assignToLocalUiUrl,
    } = body;

    if (!workspaceId || !title) {
      return NextResponse.json({ error: 'Workspace and title are required' }, { status: 400 });
    }

    // Validate workspace exists and fetch webhook config in one query
    const targetWorkspace = await db.query.workspaces.findFirst({
      where: eq(workspaces.id, workspaceId),
    });
    if (!targetWorkspace) {
      return NextResponse.json({ error: 'Workspace not found' }, { status: 400 });
    }

    // Resolve creator context using the service
    const creatorContext = await resolveCreatorContext({
      apiAccount,
      userId: user?.id,
      createdByWorkerId,
      parentTaskId,
      creationSource: requestedSource,
    });

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
        mode: mode || 'execution',  // Default to execution mode
        runnerPreference: runnerPreference || 'any',
        requiredCapabilities: requiredCapabilities || [],
        context: processedAttachments.length > 0 ? { attachments: processedAttachments } : {},
        // Creator tracking (from service)
        ...creatorContext,
      })
      .returning();

    // Trigger realtime event (no-op if Pusher not configured)
    await triggerEvent(
      channels.workspace(workspaceId),
      events.TASK_CREATED,
      { task }
    );

    // If assigning to a specific local-ui, trigger assignment event
    if (assignToLocalUiUrl) {
      await triggerEvent(
        channels.workspace(workspaceId),
        events.TASK_ASSIGNED,
        { task, targetLocalUiUrl: assignToLocalUiUrl }
      );
    }

    // Check if workspace has webhook config for external dispatch (e.g., OpenClaw)
    // Only dispatch if not already assigned to a specific local-ui
    if (!assignToLocalUiUrl) {
      if (targetWorkspace?.webhookConfig) {
        const webhookConfig = targetWorkspace.webhookConfig as WorkspaceWebhookConfig;
        // Check runner preference filter
        const shouldDispatch = !webhookConfig.runnerPreference ||
          webhookConfig.runnerPreference === 'any' ||
          webhookConfig.runnerPreference === (runnerPreference || 'any');

        if (shouldDispatch) {
          await dispatchToWebhook(webhookConfig, task);
        }
      }
    }

    return NextResponse.json(task);
  } catch (error) {
    console.error('Create task error:', error);
    return NextResponse.json({ error: 'Failed to create task' }, { status: 500 });
  }
}
