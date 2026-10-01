/**
 * POST /api/workspaces/[id]/onboarding/spec
 *
 * Guided spec authoring (docs/design/workspace-onboarding.md §4). The caller
 * sends the interview answers; the route renders ONE draft spec in the repo's
 * own format and, only on `confirm: true`, creates ONE builder task that opens
 * a PR with that file.
 *
 *   - `dryRun` (default true) → the rendered markdown and target path, nothing created
 *   - `confirm: true`         → one `pr_required` task based on the default branch
 *
 * The route never writes to the repository: the agent does, on a task branch,
 * and the task is tagged `requiresReview` so no merge path takes the PR
 * unattended. Q8 (what must never change without the owner) is returned for
 * the merge-policy decision and is written nowhere here.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { tasks, workspaces } from '@buildd/core/db/schema';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { OPEN_TASK_STATUSES, validateInterviewAnswers } from '@buildd/shared';
import type { SpecInterviewAnswers } from '@buildd/shared';
import { authorSpec, buildAuthorSpecTaskDescription, resolveSpecsRoot } from '@buildd/core/onboarding-spec';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { verifyWorkspaceAccess } from '@/lib/team-access';
import { gatherReadinessInput } from '@/lib/workspace-readiness-io';
import { resolveCreatorContext } from '@/lib/task-service';
import { dispatchNewTask } from '@/lib/task-dispatch';

const GITHUB_HANDLE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const MAX_MIRRORS = 2;

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

  const issues = validateInterviewAnswers(body.answers);
  if (issues.length > 0) {
    return NextResponse.json({ error: 'The answers need another pass.', issues }, { status: 400 });
  }
  const answers = body.answers as SpecInterviewAnswers;

  if (body.owner !== undefined && (typeof body.owner !== 'string' || !GITHUB_HANDLE.test(body.owner))) {
    return NextResponse.json({ error: 'owner must be a GitHub handle without the @' }, { status: 400 });
  }

  const workspace = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, id),
    with: { githubRepo: { with: { installation: true } } },
  });
  if (!workspace) {
    return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
  }
  if (!workspace.githubRepo) {
    return NextResponse.json({ error: 'Link a GitHub repository to this workspace before authoring a spec.' }, { status: 400 });
  }

  const defaultBranch = workspace.gitConfig?.defaultBranch || workspace.githubRepo.defaultBranch || 'main';
  const owner = (body.owner as string | undefined) ?? workspace.githubRepo.fullName.split('/')[0];

  let input;
  try {
    input = await gatherReadinessInput({
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
  } catch (err) {
    console.warn(`[onboarding-spec] Could not read repo for workspace ${id}:`, err);
    return NextResponse.json(
      { error: `Could not read the repository: ${err instanceof Error ? err.message : 'unknown'}` },
      { status: 502 },
    );
  }

  const files = input.files;
  const specsRoot = files ? resolveSpecsRoot(files, workspace.gitConfig?.specConformance?.specsRoot) : null;
  const mirrorSpecs = specsRoot
    ? Object.entries(input.manifests ?? {})
        .filter(([path]) => path.startsWith(`${specsRoot}/`) && path.toLowerCase().endsWith('.md'))
        .slice(0, MAX_MIRRORS)
        .map(([, text]) => text)
    : [];

  const result = authorSpec({
    answers,
    files,
    truncated: input.truncated === true,
    specsRoot,
    mirrorSpecs,
    owner,
    today: new Date().toISOString().slice(0, 10),
  });
  if (!result.ok) {
    return NextResponse.json(
      { error: result.errors[0]?.message ?? 'The answers need another pass.', issues: result.errors },
      { status: result.conflict ? 409 : 400 },
    );
  }

  const view = {
    path: result.path,
    markdown: result.markdown,
    format: result.format,
    warnings: result.warnings,
    dropped: result.dropped,
    mergePolicy: result.mergePolicy,
  };

  if (dryRun) {
    return NextResponse.json({ dryRun: true, ...view });
  }

  const inFlight = await db.query.tasks.findFirst({
    where: and(
      eq(tasks.workspaceId, id),
      inArray(tasks.status, [...OPEN_TASK_STATUSES]),
      sql`${tasks.context} -> 'onboardingSpec' ->> 'path' = ${result.path}`,
    ),
    columns: { id: true },
  });
  if (inFlight) {
    return NextResponse.json(
      { error: `A task to add ${result.path} is already in flight.`, taskId: inFlight.id },
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
      title: `Spec: add draft spec ${result.path}`,
      description: buildAuthorSpecTaskDescription({ path: result.path, markdown: result.markdown, defaultBranch }),
      status: 'pending',
      roleSlug: 'builder',
      outputRequirement: 'pr_required',
      requiresReview: true,
      priority: 0,
      context: {
        baseBranch: defaultBranch,
        onboardingSpec: { path: result.path, slug: result.slug },
      },
      ...creator,
    })
    .returning();

  try {
    await dispatchNewTask(task, workspace);
  } catch (err) {
    console.warn(`[onboarding-spec] Task ${task.id} created but dispatch failed:`, err);
  }

  return NextResponse.json({ dryRun: false, ...view, task: { id: task.id, baseBranch: defaultBranch } }, { status: 201 });
}
