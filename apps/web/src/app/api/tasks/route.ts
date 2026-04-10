import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { tasks, workspaces, accountWorkspaces, workspaceSkills, missions } from '@buildd/core/db/schema';
import { desc, eq, and, or, inArray, notInArray, gte } from 'drizzle-orm';
import { jsonResponse } from '@/lib/api-response';
import { getCurrentUser } from '@/lib/auth-helpers';
import { resolveCreatorContext } from '@/lib/task-service';
import { authenticateApiKey } from '@/lib/api-auth';
import { getAccountWorkspacePermissions } from '@/lib/account-workspace-cache';
import { dispatchNewTask } from '@/lib/task-dispatch';
import { getUserWorkspaceIds, verifyAccountWorkspaceAccess } from '@/lib/team-access';
import { classifyTask } from '@/lib/task-category';
import { TaskCategory } from '@buildd/shared';
import { resolveWorkspace, autoResolveAccountWorkspace } from '@/lib/workspace-resolver';

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
      const [permissions, openWorkspaces] = await Promise.all([
        getAccountWorkspacePermissions(apiAccount.id),
        db.query.workspaces.findMany({
          where: eq(workspaces.accessMode, 'open'),
          columns: { id: true },
        }),
      ]);
      const linkedIds = permissions.map(p => p.workspaceId);
      const openIds = openWorkspaces.map(w => w.id);
      workspaceIds = [...new Set([...linkedIds, ...openIds])];
    } else {
      // For session auth, get user's workspaces via team membership
      workspaceIds = await getUserWorkspaceIds(user!.id);
    }

    // Get tasks from the resolved workspace IDs (lightweight list view)
    // Returns: all active tasks + completed/failed from the last 24h
    const terminalStatuses = ['completed', 'failed'];
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const allTasks = workspaceIds.length > 0
      ? await db.query.tasks.findMany({
          where: and(
            inArray(tasks.workspaceId, workspaceIds),
            or(
              // Active tasks (pending, assigned, in_progress, etc.)
              notInArray(tasks.status, terminalStatuses),
              // Terminal tasks from the last 24h
              and(
                inArray(tasks.status, terminalStatuses),
                gte(tasks.updatedAt, oneDayAgo),
              ),
            ),
          ),
          orderBy: desc(tasks.createdAt),
          limit: 200,
          columns: {
            id: true,
            workspaceId: true,
            externalId: true,
            externalUrl: true,
            title: true,
            status: true,
            priority: true,
            mode: true,
            runnerPreference: true,
            requiredCapabilities: true,
            claimedBy: true,
            claimedAt: true,
            expiresAt: true,
            createdByAccountId: true,
            createdByWorkerId: true,
            creationSource: true,
            parentTaskId: true,
            category: true,
            project: true,
            outputRequirement: true,
            missionId: true,
            dependsOn: true,
            createdAt: true,
            updatedAt: true,
          },
          with: {
            workspace: {
              columns: {
                id: true,
                name: true,
                repo: true,
              },
            },
          },
        })
      : [];

    return jsonResponse({ tasks: allTasks });
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
      workspaceId: rawWorkspaceId,
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
      // Direct assignment to a specific runner instance
      assignToLocalUiUrl,
      // Skill slugs
      skillSlugs: rawSkillSlugs,
      // JSON Schema for structured output
      outputSchema,
      // Task category
      category: rawCategory,
      // Output requirement — what deliverables are enforced on completion
      outputRequirement: rawOutputRequirement,
      // Project scoping
      project,
      // Mission linking
      missionId,
      // Workflow DAG: task IDs that must complete before this task is claimable
      dependsOn,
      // Role routing — only runners with this skill can claim the task
      roleSlug,
      // Incoming context (from MCP or API callers — baseBranch, iteration, failureContext, etc.)
      context: incomingContext,
    } = body;

    if (!title) {
      return NextResponse.json({ error: 'Title is required' }, { status: 400 });
    }

    // Resolve workspace: explicit param → auto-resolve for API accounts
    let workspaceId: string | undefined;

    if (rawWorkspaceId) {
      // Resolve by UUID, repo name, or workspace name
      const resolved = await resolveWorkspace(rawWorkspaceId);
      if (!resolved) {
        return NextResponse.json(
          { error: `No workspace found matching "${rawWorkspaceId}"` },
          { status: 400 }
        );
      }
      workspaceId = resolved.id;
    } else if (apiAccount) {
      // Auto-resolve: if account linked to exactly one workspace, use it
      const result = await autoResolveAccountWorkspace(apiAccount.id, apiAccount.name);
      if ('error' in result) {
        return NextResponse.json({ error: result.error }, { status: result.status });
      }
      workspaceId = result.workspaceId;
    }

    if (!workspaceId) {
      return NextResponse.json({ error: 'workspaceId is required' }, { status: 400 });
    }

    // Validate workspace exists and fetch webhook config in one query
    const targetWorkspace = await db.query.workspaces.findFirst({
      where: eq(workspaces.id, workspaceId),
    });
    if (!targetWorkspace) {
      return NextResponse.json({ error: 'Workspace not found' }, { status: 400 });
    }

    // Verify workspace access with actionable errors
    if (apiAccount) {
      const hasAccess = await verifyAccountWorkspaceAccess(apiAccount.id, workspaceId, 'canCreate');
      if (!hasAccess) {
        return NextResponse.json(
          { error: `Account "${apiAccount.name}" does not have permission to create tasks in this workspace.` },
          { status: 403 }
        );
      }
    }

    // Validate dependsOn references exist in the same workspace
    if (Array.isArray(dependsOn) && dependsOn.length > 0) {
      const depTasks = await db.query.tasks.findMany({
        where: and(inArray(tasks.id, dependsOn), eq(tasks.workspaceId, workspaceId)),
        columns: { id: true },
      });
      const foundIds = new Set(depTasks.map(t => t.id));
      const missing = dependsOn.filter((id: string) => !foundIds.has(id));
      if (missing.length > 0) {
        return NextResponse.json(
          { error: `dependsOn references unknown tasks in this workspace: ${missing.join(', ')}` },
          { status: 400 }
        );
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
      for (const slug of skillSlugs) {
        // Look up workspace-level skills (enabled only)
        const wsSkill = await db.query.workspaceSkills.findFirst({
          where: and(
            eq(workspaceSkills.workspaceId, workspaceId),
            eq(workspaceSkills.slug, slug),
            eq(workspaceSkills.enabled, true),
          ),
        });

        if (!wsSkill) {
          return NextResponse.json(
            { error: `Skill "${slug}" not registered in workspace` },
            { status: 400 }
          );
        }

        resolvedSkillRefs.push({
          skillId: wsSkill.id,
          slug: wsSkill.slug,
          contentHash: wsSkill.contentHash,
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
    const explicitOutputRequirement = rawOutputRequirement && validOutputRequirements.includes(rawOutputRequirement)
      ? rawOutputRequirement as 'pr_required' | 'artifact_required' | 'none' | 'auto'
      : undefined;

    // Inherit outputRequirement from mission if not explicitly set
    let outputRequirement = explicitOutputRequirement;
    if (!outputRequirement && missionId) {
      const mission = await db.query.missions.findFirst({
        where: eq(missions.id, missionId),
        columns: { defaultOutputRequirement: true },
      });
      outputRequirement = mission?.defaultOutputRequirement ?? 'auto';
    }

    const [task] = await db
      .insert(tasks)
      .values({
        workspaceId,
        title,
        description: description || null,
        priority: priority || 0,
        status: 'pending',
        mode: 'execution',
        runnerPreference: runnerPreference || 'any',
        requiredCapabilities: requiredCapabilities || [],
        context: {
          // Merge incoming context (MCP sends baseBranch, iteration, failureContext, model, effort, etc.)
          ...(typeof incomingContext === 'object' && incomingContext !== null && !Array.isArray(incomingContext) ? incomingContext : {}),
          // Route-computed fields take precedence
          ...(processedAttachments.length > 0 ? { attachments: processedAttachments } : {}),
          ...(skillSlugs.length > 0 ? { skillSlugs } : {}),
          ...(resolvedSkillRefs.length > 0 ? { skillRefs: resolvedSkillRefs } : {}),
        },
        ...(project ? { project } : {}),
        ...(category ? { category } : {}),
        ...(outputRequirement ? { outputRequirement } : {}),
        ...(outputSchema ? { outputSchema } : {}),
        ...(missionId ? { missionId } : {}),
        ...(Array.isArray(dependsOn) && dependsOn.length > 0 ? { dependsOn } : {}),
        ...(roleSlug && typeof roleSlug === 'string' ? { roleSlug } : {}),
        // Creator tracking (from service)
        ...creatorContext,
      })
      .returning();

    await dispatchNewTask(task, targetWorkspace, {
      assignToLocalUiUrl,
      runnerPreference,
    });

    return NextResponse.json(task);
  } catch (error) {
    console.error('Create task error:', error);
    const detail = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: 'Failed to create task', detail }, { status: 500 });
  }
}
