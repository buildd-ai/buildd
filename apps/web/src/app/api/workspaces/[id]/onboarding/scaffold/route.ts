/**
 * POST /api/workspaces/[id]/onboarding/scaffold
 *
 * Makes a repo buildd-friendly (docs/design/workspace-onboarding.md §3). The
 * caller names the readiness items to scaffold; the route renders them and, only
 * on `confirm: true`, creates ONE builder task that opens the PR(s).
 *
 *   - no `itemIds`            → no-op; nothing is read or written
 *   - `dryRun` (default true) → the rendered files and target paths, nothing created
 *   - `confirm: true`         → one `pr_required` task based on the default branch
 *
 * The route never writes to the repository: the agent does, on a task branch,
 * and the task is tagged `requiresReview` so no merge path takes the PR
 * unattended (see `tryAutoMergeWorkerPr`). A human merges every scaffold PR.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { tasks, workspaces } from '@buildd/core/db/schema';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { OPEN_TASK_STATUSES } from '@buildd/shared';
import { SCAFFOLD_ITEM_IDS, SCAFFOLD_SKILL_SLUG, buildScaffoldTaskDescription, planScaffold } from '@buildd/core/onboarding-scaffold';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { verifyWorkspaceAccess } from '@/lib/team-access';
import { gatherReadinessInput } from '@/lib/workspace-readiness-io';
import { resolveCreatorContext } from '@/lib/task-service';
import { dispatchNewTask } from '@/lib/task-dispatch';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  const apiAccount = await authenticateApiKey(apiKey, req);
  const user = await getCurrentUser();

  if (!apiAccount && !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // 404, not 403, so a workspace in another team looks like one that does not exist.
  if (apiAccount) {
    const owner = await db.query.workspaces.findFirst({
      where: eq(workspaces.id, id),
      columns: { teamId: true },
    });
    if (!owner || owner.teamId !== apiAccount.teamId) {
      return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
    }
  } else if (user) {
    const access = await verifyWorkspaceAccess(user.id, id);
    if (!access) {
      return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
    }
  }

  let body: Record<string, unknown> = {};
  try {
    const text = await req.text();
    if (text.trim()) body = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return NextResponse.json({ error: 'Body must be an object' }, { status: 400 });
  }

  const rawIds = body.itemIds;
  if (rawIds !== undefined && (!Array.isArray(rawIds) || rawIds.some((i) => typeof i !== 'string'))) {
    return NextResponse.json({ error: 'itemIds must be an array of strings' }, { status: 400 });
  }
  const itemIds = [...new Set((rawIds ?? []) as string[])];
  const confirm = body.confirm === true;
  if (body.dryRun !== undefined && typeof body.dryRun !== 'boolean') {
    return NextResponse.json({ error: 'dryRun must be a boolean' }, { status: 400 });
  }
  const dryRun = typeof body.dryRun === 'boolean' ? body.dryRun : !confirm;

  if (!dryRun && !confirm) {
    return NextResponse.json(
      { error: 'dryRun: false needs confirm: true. Review the dry run, then confirm.' },
      { status: 400 },
    );
  }

  if (itemIds.length === 0) {
    return NextResponse.json({
      dryRun,
      files: [],
      skipped: [],
      prs: [],
      skill: SCAFFOLD_SKILL_SLUG,
      note: `Nothing to scaffold: pass itemIds (${SCAFFOLD_ITEM_IDS.join(', ')}).`,
    });
  }

  const workspace = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, id),
    with: { githubRepo: { with: { installation: true } } },
  });
  if (!workspace) {
    return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
  }
  if (!workspace.githubRepo) {
    return NextResponse.json({ error: 'Link a GitHub repository to this workspace before scaffolding.' }, { status: 400 });
  }

  const defaultBranch = workspace.gitConfig?.defaultBranch || workspace.githubRepo.defaultBranch || 'main';

  let plan;
  try {
    const readiness = await gatherReadinessInput({
      id: workspace.id,
      gitConfig: workspace.gitConfig,
      configStatus: workspace.configStatus,
      releaseConfig: workspace.releaseConfig,
      githubRepo: {
        fullName: workspace.githubRepo.fullName,
        defaultBranch: workspace.githubRepo.defaultBranch ?? null,
        installation: workspace.githubRepo.installation
          ? { installationId: workspace.githubRepo.installation.installationId }
          : null,
      },
    });
    plan = planScaffold({
      itemIds,
      readiness,
      projectName: workspace.githubRepo.name || workspace.name,
      defaultBranch,
      isPublic: workspace.githubRepo.private === false,
    });
  } catch (err) {
    console.warn(`[onboarding-scaffold] Could not read repo for workspace ${id}:`, err);
    return NextResponse.json(
      { error: `Could not read the repository: ${err instanceof Error ? err.message : 'unknown'}` },
      { status: 502 },
    );
  }

  const view = {
    files: plan.files.map((f) => ({
      path: f.path,
      group: f.group,
      itemIds: f.itemIds,
      commitMessage: f.commitMessage,
      content: f.content,
    })),
    skipped: plan.skipped,
    prs: plan.prs,
    skill: SCAFFOLD_SKILL_SLUG,
  };

  if (dryRun) {
    return NextResponse.json({ dryRun: true, ...view });
  }

  if (plan.files.length === 0) {
    return NextResponse.json(
      { error: 'Nothing to scaffold for the selected items.', skipped: plan.skipped },
      { status: 409 },
    );
  }

  const inFlight = await db.query.tasks.findFirst({
    where: and(
      eq(tasks.workspaceId, id),
      inArray(tasks.status, [...OPEN_TASK_STATUSES]),
      sql`${tasks.context} -> 'onboardingScaffold' IS NOT NULL`,
    ),
    columns: { id: true },
  });
  if (inFlight) {
    return NextResponse.json(
      { error: 'An onboarding scaffold task is already in flight for this workspace.', taskId: inFlight.id },
      { status: 409 },
    );
  }

  const creator = await resolveCreatorContext({
    apiAccount,
    userId: user?.id ?? null,
    creationSource: apiAccount ? 'api' : 'dashboard',
  });

  const [task] = await db
    .insert(tasks)
    .values({
      workspaceId: id,
      title: `Onboard repo: add ${plan.files.map((f) => f.path).join(', ')}`,
      description: buildScaffoldTaskDescription(plan, { defaultBranch }),
      status: 'pending',
      roleSlug: 'builder',
      outputRequirement: 'pr_required',
      requiresReview: true,
      priority: 0,
      context: {
        baseBranch: defaultBranch,
        skillSlugs: [SCAFFOLD_SKILL_SLUG],
        onboardingScaffold: {
          itemIds: plan.files.flatMap((f) => f.itemIds),
          paths: plan.files.map((f) => f.path),
        },
      },
      ...creator,
    })
    .returning();

  try {
    await dispatchNewTask(task, workspace);
  } catch (err) {
    console.warn(`[onboarding-scaffold] Task ${task.id} created but dispatch failed:`, err);
  }

  return NextResponse.json({ dryRun: false, ...view, task: { id: task.id, baseBranch: defaultBranch } }, { status: 201 });
}
