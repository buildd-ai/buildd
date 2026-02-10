import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { tasks, workspaces, accountWorkspaces } from '@buildd/core/db/schema';
import { desc, eq, and, inArray } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { resolveCreatorContext } from '@/lib/task-service';
import { authenticateApiKey } from '@/lib/api-auth';
import { dispatchNewTask } from '@/lib/task-dispatch';
import { getUserWorkspaceIds, verifyAccountWorkspaceAccess } from '@/lib/team-access';

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
      // For session auth, get user's workspaces via team membership
      workspaceIds = await getUserWorkspaceIds(user!.id);
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
      // Skill reference
      skillRef,
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

    // Verify workspace access
    if (apiAccount) {
      const hasAccess = await verifyAccountWorkspaceAccess(apiAccount.id, workspaceId, 'canCreate');
      if (!hasAccess) {
        return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
      }
    }

    // Resolve creator context using the service
    const creatorContext = await resolveCreatorContext({
      apiAccount,
      userId: user?.id,
      createdByWorkerId,
      parentTaskId,
      creationSource: requestedSource,
    });

    // TODO: Resolve skill reference if provided — skills table not yet implemented
    let resolvedSkillRef: { skillId: string; slug: string; contentHash: string } | undefined;
    // if (skillRef?.slug) {
    //   if (!targetWorkspace.teamId) {
    //     return NextResponse.json(
    //       { error: 'Workspace has no team — cannot resolve skills' },
    //       { status: 400 }
    //     );
    //   }
    //   const skill = await db.query.skills.findFirst({
    //     where: and(eq(skills.teamId, targetWorkspace.teamId), eq(skills.slug, skillRef.slug)),
    //   });
    //   if (!skill) {
    //     return NextResponse.json(
    //       { error: `Skill "${skillRef.slug}" not registered` },
    //       { status: 400 }
    //     );
    //   }
    //   resolvedSkillRef = {
    //     skillId: skill.id,
    //     slug: skill.slug,
    //     contentHash: skill.contentHash,
    //   };
    // }

    // Process attachments - accept both R2 references and legacy inline base64
    const processedAttachments: Array<
      { filename: string; mimeType: string; storageKey: string } |
      { filename: string; mimeType: string; data: string }
    > = [];
    if (attachments && Array.isArray(attachments)) {
      for (const att of attachments) {
        if (att.storageKey && att.mimeType && att.filename) {
          // R2 reference (new format)
          processedAttachments.push({
            filename: att.filename,
            mimeType: att.mimeType,
            storageKey: att.storageKey,
          });
        } else if (att.data && att.mimeType && att.filename) {
          // Inline base64 data URL (legacy format)
          processedAttachments.push({
            filename: att.filename,
            mimeType: att.mimeType,
            data: att.data,
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
        context: {
          ...(processedAttachments.length > 0 ? { attachments: processedAttachments } : {}),
          ...(resolvedSkillRef ? { skillRef: resolvedSkillRef } : {}),
        },
        // Creator tracking (from service)
        ...creatorContext,
      })
      .returning();

    // Dispatch via Pusher + webhook
    await dispatchNewTask(task, targetWorkspace, {
      assignToLocalUiUrl,
      runnerPreference,
    });

    return NextResponse.json(task);
  } catch (error) {
    console.error('Create task error:', error);
    return NextResponse.json({ error: 'Failed to create task' }, { status: 500 });
  }
}
