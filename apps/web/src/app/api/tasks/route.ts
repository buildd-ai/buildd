import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { tasks, workspaces, accountWorkspaces, skills, workspaceSkills } from '@buildd/core/db/schema';
import { desc, eq, and, inArray, not } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { resolveCreatorContext } from '@/lib/task-service';
import { authenticateApiKey } from '@/lib/api-auth';
import { dispatchNewTask } from '@/lib/task-dispatch';
import { getUserWorkspaceIds, verifyAccountWorkspaceAccess } from '@/lib/team-access';
import { classifyTask } from '@/lib/task-category';
import { TaskCategory } from '@buildd/shared';

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
      // Skill slugs
      skillSlugs: rawSkillSlugs,
      // JSON Schema for structured output
      outputSchema,
      // Task category
      category: rawCategory,
      // Output requirement — what deliverables are enforced on completion
      outputRequirement: rawOutputRequirement,
      // Task dependency — blocked tasks start as 'blocked' and auto-unblock
      blockedByTaskIds: rawBlockedByTaskIds,
      // Project scoping
      project,
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

    const skillSlugs: string[] = Array.isArray(rawSkillSlugs) ? [...rawSkillSlugs] : [];

    // Resolve skill references if any slugs provided
    const resolvedSkillRefs: Array<{ skillId: string; slug: string; contentHash: string }> = [];

    if (skillSlugs.length > 0) {
      if (!targetWorkspace.teamId) {
        return NextResponse.json(
          { error: 'Workspace has no team — cannot resolve skills' },
          { status: 400 }
        );
      }

      for (const slug of skillSlugs) {
        // Check workspace-level skills first (enabled only)
        const wsSkill = await db.query.workspaceSkills.findFirst({
          where: and(
            eq(workspaceSkills.workspaceId, workspaceId),
            eq(workspaceSkills.slug, slug),
            eq(workspaceSkills.enabled, true),
          ),
        });

        if (wsSkill) {
          resolvedSkillRefs.push({
            skillId: wsSkill.id,
            slug: wsSkill.slug,
            contentHash: wsSkill.contentHash,
          });
          continue;
        }

        // Fall back to team-level skill registry
        const teamSkill = await db.query.skills.findFirst({
          where: and(eq(skills.teamId, targetWorkspace.teamId), eq(skills.slug, slug)),
        });

        if (!teamSkill) {
          return NextResponse.json(
            { error: `Skill "${slug}" not registered` },
            { status: 400 }
          );
        }

        resolvedSkillRefs.push({
          skillId: teamSkill.id,
          slug: teamSkill.slug,
          contentHash: teamSkill.contentHash,
        });
      }

    }

    // Process attachments - R2 storage references only
    const processedAttachments: Array<{ filename: string; mimeType: string; storageKey: string }> = [];
    if (attachments && Array.isArray(attachments)) {
      for (const att of attachments) {
        if (att.storageKey && att.mimeType && att.filename) {
          processedAttachments.push({
            filename: att.filename,
            mimeType: att.mimeType,
            storageKey: att.storageKey,
          });
        }
      }
    }

    // Validate outputSchema is a valid JSON Schema object if provided
    if (outputSchema && (typeof outputSchema !== 'object' || Array.isArray(outputSchema))) {
      return NextResponse.json({ error: 'outputSchema must be a JSON Schema object' }, { status: 400 });
    }

    // Validate blockedByTaskIds if provided
    const blockedByTaskIds: string[] = [];
    if (rawBlockedByTaskIds && Array.isArray(rawBlockedByTaskIds) && rawBlockedByTaskIds.length > 0) {
      // Validate UUIDs
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      for (const id of rawBlockedByTaskIds) {
        if (typeof id !== 'string' || !uuidRegex.test(id)) {
          return NextResponse.json({ error: `Invalid task ID in blockedByTaskIds: ${id}` }, { status: 400 });
        }
      }

      // Verify all referenced tasks exist in the same workspace
      const blockerTasks = await db.query.tasks.findMany({
        where: and(
          inArray(tasks.id, rawBlockedByTaskIds),
          eq(tasks.workspaceId, workspaceId)
        ),
        columns: { id: true, blockedByTaskIds: true },
      });

      if (blockerTasks.length !== rawBlockedByTaskIds.length) {
        const foundIds = new Set(blockerTasks.map(t => t.id));
        const missing = rawBlockedByTaskIds.filter((id: string) => !foundIds.has(id));
        return NextResponse.json(
          { error: `Blocker tasks not found in workspace: ${missing.join(', ')}` },
          { status: 400 }
        );
      }

      blockedByTaskIds.push(...rawBlockedByTaskIds);
    }

    // Resolve category: use provided value, or auto-classify
    type CategoryType = 'bug' | 'feature' | 'refactor' | 'chore' | 'docs' | 'test' | 'infra' | 'design';
    const validCategories = Object.values(TaskCategory) as string[];
    let category: CategoryType | null = null;
    if (rawCategory && validCategories.includes(rawCategory)) {
      category = rawCategory as CategoryType;
    } else if (!rawCategory) {
      category = classifyTask(title, description) as CategoryType | null;
    }

    // Validate outputRequirement if provided
    const validOutputRequirements = ['pr_required', 'artifact_required', 'none', 'auto'];
    const outputRequirement = rawOutputRequirement && validOutputRequirements.includes(rawOutputRequirement)
      ? rawOutputRequirement as 'pr_required' | 'artifact_required' | 'none' | 'auto'
      : undefined;

    const initialStatus = blockedByTaskIds.length > 0 ? 'blocked' : 'pending';

    const [task] = await db
      .insert(tasks)
      .values({
        workspaceId,
        title,
        description: description || null,
        priority: priority || 0,
        status: initialStatus,
        mode: mode || 'execution',  // Default to execution mode
        runnerPreference: runnerPreference || 'any',
        requiredCapabilities: requiredCapabilities || [],
        context: {
          ...(processedAttachments.length > 0 ? { attachments: processedAttachments } : {}),
          ...(skillSlugs.length > 0 ? { skillSlugs } : {}),
          ...(resolvedSkillRefs.length > 0 ? { skillRefs: resolvedSkillRefs } : {}),
        },
        ...(project ? { project } : {}),
        ...(category ? { category } : {}),
        ...(outputRequirement ? { outputRequirement } : {}),
        ...(outputSchema ? { outputSchema } : {}),
        ...(blockedByTaskIds.length > 0 ? { blockedByTaskIds } : {}),
        // Creator tracking (from service)
        ...creatorContext,
      })
      .returning();

    // Only dispatch if task is pending (not blocked)
    if (initialStatus === 'pending') {
      await dispatchNewTask(task, targetWorkspace, {
        assignToLocalUiUrl,
        runnerPreference,
      });
    }

    return NextResponse.json(task);
  } catch (error) {
    console.error('Create task error:', error);
    return NextResponse.json({ error: 'Failed to create task' }, { status: 500 });
  }
}
