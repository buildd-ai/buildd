/**
 * POST /api/workspaces/[id]/policy-init
 *
 * Scans the workspace's GitHub repo and returns a proposed WorkspacePolicyConfig
 * with detected paths per semantic risk class.
 *
 * The response is a proposal only — caller decides whether to apply it via
 * PATCH /api/workspaces/[id] with gitConfig.policyConfig.
 *
 * Body params:
 *   preset?: WorkspacePolicyPreset  — defaults to 'balanced'
 *   reviewerRole?: string           — slug of reviewer skill
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { workspaces } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { verifyWorkspaceAccess } from '@/lib/team-access';
import { githubApi } from '@/lib/github';
import { detectAllRiskClasses, inferPolicyConfigFromLegacy } from '@/lib/workspace-policy';
import type { WorkspacePolicyPreset, WorkspacePolicyConfig } from '@/lib/workspace-policy';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  // Auth — accept both session and API key
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  const apiAccount = await authenticateApiKey(apiKey);
  const user = await getCurrentUser();

  if (!apiAccount && !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (user && !apiAccount) {
    const access = await verifyWorkspaceAccess(user.id, id);
    if (!access) {
      return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
    }
  }

  let body: { preset?: WorkspacePolicyPreset; reviewerRole?: string } = {};
  try {
    const raw = await req.text();
    if (raw) body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const preset: WorkspacePolicyPreset = body.preset ?? 'balanced';
  if (!['cautious', 'balanced', 'autonomous'].includes(preset)) {
    return NextResponse.json({ error: 'preset must be cautious | balanced | autonomous' }, { status: 400 });
  }

  // Load workspace with linked GitHub repo + installation
  const workspace = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, id),
    with: {
      githubRepo: {
        with: { installation: true },
      },
    },
  });
  if (!workspace) {
    return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
  }

  const githubRepo = workspace.githubRepo;
  if (!githubRepo?.installation) {
    return NextResponse.json(
      { error: 'No GitHub repository linked to this workspace. Link a repo first.' },
      { status: 422 },
    );
  }

  const installationId = githubRepo.installation.installationId;
  const repoFullName = githubRepo.fullName;
  const defaultBranch = workspace.gitConfig?.defaultBranch ?? 'main';

  // Fetch the full repo tree from GitHub
  let files: string[] = [];
  try {
    const treeData = await githubApi(
      installationId,
      `/repos/${repoFullName}/git/trees/${defaultBranch}?recursive=1`,
    );
    if (Array.isArray(treeData?.tree)) {
      files = (treeData.tree as Array<{ path: string; type: string }>)
        .filter((item) => item.type === 'blob')
        .map((item) => item.path);
    }
  } catch (err) {
    console.warn(`[policy-init] Could not fetch repo tree for ${repoFullName}:`, err);
    return NextResponse.json(
      { error: `Could not fetch repo file tree: ${err instanceof Error ? err.message : 'unknown'}` },
      { status: 502 },
    );
  }

  if (files.length === 0) {
    return NextResponse.json(
      { error: 'Repository appears empty or tree fetch returned no blobs' },
      { status: 422 },
    );
  }

  // Detect risk classes from the file tree
  const riskClasses = detectAllRiskClasses(files);

  // Reviewer role: from body, or existing policyConfig, or existing mergePolicy, or default
  const existingReviewerRole =
    body.reviewerRole ??
    workspace.gitConfig?.policyConfig?.reviewerRole ??
    workspace.gitConfig?.mergePolicy?.agentReview?.reviewerRole ??
    'reviewer';

  // AC-6: If detection finds nothing but legacy escalateToPaths exist, migrate them
  const existingEscalatePaths = workspace.gitConfig?.mergePolicy?.agentReview?.escalateToPaths ?? [];
  let proposed: WorkspacePolicyConfig;

  if (riskClasses.every((c) => c.detectedPaths.length === 0) && existingEscalatePaths.length > 0) {
    proposed = inferPolicyConfigFromLegacy(existingEscalatePaths, existingReviewerRole, preset);
  } else {
    proposed = { preset, riskClasses, reviewerRole: existingReviewerRole };
  }

  // Carry forward any userPaths from the current policyConfig so they're not lost
  const current = workspace.gitConfig?.policyConfig;
  if (current) {
    for (const entry of proposed.riskClasses) {
      const existingEntry = current.riskClasses.find((c) => c.name === entry.name);
      if (existingEntry?.userPaths?.length) {
        entry.userPaths = [...(entry.userPaths ?? []), ...existingEntry.userPaths];
      }
    }
  }

  return NextResponse.json({
    proposed,
    repoFullName,
    fileCount: files.length,
    detectedClassCount: riskClasses.filter((c) => c.detectedPaths.length > 0).length,
    hint: `Apply with: PATCH /api/workspaces/${id} body: { gitConfig: { policyConfig: <proposed> } }`,
  });
}
