import { db } from '@buildd/core/db';
import { tasks, workers, workspaces, githubRepos } from '@buildd/core/db/schema';
import type { WorkspaceReleaseConfig, ReleaseResult } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { githubApi } from '@/lib/github';
import { resolveReleaseStrategy } from '@buildd/core/release-strategy';

// Vercel deployment readback — polls until terminal state
async function pollVercelDeployment(
  projectId: string,
  teamId: string | undefined,
  prodBranch: string,
  timeoutMs = 5 * 60 * 1000
): Promise<{ state: string; url: string | null }> {
  const token = process.env.VERCEL_TOKEN;
  if (!token) {
    throw new Error('VERCEL_TOKEN not configured');
  }

  const teamQuery = teamId ? `&teamId=${encodeURIComponent(teamId)}` : '';
  const deadline = Date.now() + timeoutMs;
  const pollIntervalMs = 10_000;

  while (Date.now() < deadline) {
    const resp = await fetch(
      `https://api.vercel.com/v6/deployments?projectId=${encodeURIComponent(projectId)}&target=production&limit=5${teamQuery}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Vercel API error ${resp.status}: ${text}`);
    }
    const data = await resp.json();
    const deployments: Array<{ uid: string; state: string; url: string; meta?: { githubCommitRef?: string } }> =
      data.deployments ?? [];

    // Find latest production deployment on the prod branch
    const candidate = deployments.find(
      (d) => !d.meta?.githubCommitRef || d.meta.githubCommitRef === prodBranch
    ) ?? deployments[0];

    if (candidate) {
      const state: string = candidate.state;
      if (state === 'READY' || state === 'ERROR' || state === 'CANCELED') {
        return { state, url: candidate.url ? `https://${candidate.url}` : null };
      }
    }

    await new Promise((res) => setTimeout(res, pollIntervalMs));
  }

  return { state: 'TIMEOUT', url: null };
}

// Run a single post-deploy hook
async function runHook(
  hook: NonNullable<WorkspaceReleaseConfig['postDeployHooks']>[number]
): Promise<{ description: string; success: boolean; error?: string }> {
  try {
    if (hook.type === 'http') {
      if (!hook.url) throw new Error('Hook missing url');
      const resp = await fetch(hook.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(hook.headers ?? {}) },
        body: hook.params ? JSON.stringify(hook.params) : undefined,
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return { description: hook.description, success: true };
    }

    if (hook.type === 'buildd_mcp') {
      // Buildd MCP HTTP transport — posts action to the buildd MCP endpoint
      const mcpUrl = process.env.BUILDD_MCP_URL || 'https://buildd.dev/api/mcp';
      const mcpKey = process.env.BUILDD_API_KEY;
      if (!mcpKey) throw new Error('BUILDD_API_KEY not set for buildd_mcp hook');
      if (!hook.action) throw new Error('Hook missing action');

      const resp = await fetch(mcpUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${mcpKey}`,
        },
        body: JSON.stringify({
          action: hook.action,
          params: hook.params ?? {},
        }),
      });
      if (!resp.ok) throw new Error(`Buildd MCP ${resp.status}`);
      return { description: hook.description, success: true };
    }

    throw new Error(`Unknown hook type: ${(hook as any).type}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { description: hook.description, success: false, error: msg };
  }
}

// Merge a feature branch into prodBranch via GitHub API.
// Strategy: create/update a PR from the worker's branch to prodBranch, then merge it.
// Falls back to direct push merge if no PR exists.
async function mergeIntoProd(
  installationId: number,
  repoFullName: string,
  workerBranch: string,
  prNumber: number | null | undefined,
  prodBranch: string
): Promise<{ merged: boolean; sha?: string; message: string }> {
  // If the worker already has a tracked PR, merge it
  if (prNumber) {
    try {
      const mergeResp = await githubApi(
        installationId,
        `/repos/${repoFullName}/pulls/${prNumber}/merge`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ merge_method: 'squash' }),
        }
      );
      return { merged: true, sha: mergeResp?.sha, message: 'PR merged via squash' };
    } catch (err) {
      // PR may already be merged or in a non-mergeable state — try direct merge
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('405') && !msg.includes('already been merged')) {
        return { merged: false, message: `PR merge failed: ${msg}` };
      }
      // Already merged — treat as success
      if (msg.includes('already been merged')) {
        return { merged: true, message: 'PR already merged' };
      }
    }
  }

  // No PR — use GitHub merge API to merge the branch into prodBranch
  // This handles conflicts properly: GitHub will reject with 409 if conflicted
  try {
    const mergeResp = await githubApi(
      installationId,
      `/repos/${repoFullName}/merges`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          base: prodBranch,
          head: workerBranch,
          commit_message: `chore: release ${workerBranch} → ${prodBranch}`,
        }),
      }
    );
    // 204 = already up-to-date
    const sha = mergeResp?.sha;
    return { merged: true, sha, message: `Branch merged into ${prodBranch}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Treat 204 (no content, already up-to-date) as success
    if (msg.includes('204')) {
      return { merged: true, message: `${prodBranch} already up-to-date` };
    }
    return { merged: false, message: `Merge failed: ${msg}` };
  }
}

export interface ReleaseInput {
  taskId: string;
  workerId: string;
  workspaceId: string;
}

export async function executeRelease(input: ReleaseInput): Promise<ReleaseResult> {
  const { taskId, workerId, workspaceId } = input;

  // Fetch task release flag and worker PR info
  const [task, worker, workspace] = await Promise.all([
    db.query.tasks.findFirst({
      where: eq(tasks.id, taskId),
      columns: { release: true },
    }),
    db.query.workers.findFirst({
      where: eq(workers.id, workerId),
      columns: { branch: true, prNumber: true, prUrl: true },
    }),
    db.query.workspaces.findFirst({
      where: eq(workspaces.id, workspaceId),
      columns: { releaseConfig: true, githubRepoId: true },
    }),
  ]);

  const releaseFlag = (task?.release ?? 'inherit') as 'true' | 'false' | 'inherit';
  const releaseConfig = workspace?.releaseConfig ?? null;

  // Determine if release should run
  if (releaseFlag === 'false') {
    return { status: 'skipped', message: 'Release: not requested (suppressed by task flag)' };
  }

  // Resolve the workspace's declared strategy. executeRelease is the
  // on-task-completion merge path, so it only handles 'branch_merge'; other
  // strategies (workflow_dispatch/script) run via the standalone trigger.
  const resolution = resolveReleaseStrategy(releaseConfig);
  if (!resolution.ok) {
    if (releaseFlag === 'true') {
      // Explicit request but unusable config — fail loudly.
      return {
        status: 'failed',
        message: `Release: FAILED — task requested release but ${resolution.message}.`,
        error: resolution.message,
      };
    }
    return { status: 'not_configured', message: `Release: ${resolution.message}` };
  }

  if (resolution.strategy.kind !== 'branch_merge') {
    return {
      status: 'skipped',
      message: `Release: workspace uses the ${resolution.strategy.kind} strategy — not run on task completion (use trigger_release).`,
    };
  }

  const branchMerge = resolution.strategy;
  const { prodBranch } = branchMerge;

  // Step 1: Merge into prodBranch
  let mergedAt: string | undefined;
  let mergeSha: string | undefined;

  if (worker?.branch) {
    // Get GitHub repo for this workspace
    const repo = workspace?.githubRepoId
      ? await db.query.githubRepos.findFirst({
          where: eq(githubRepos.id, workspace.githubRepoId),
          with: { installation: true },
        })
      : null;

    if (!repo?.installation) {
      return {
        status: 'failed',
        message: 'Release: FAILED — workspace has no linked GitHub repo/installation',
        error: 'No GitHub installation',
      };
    }

    const mergeResult = await mergeIntoProd(
      repo.installation.installationId,
      repo.fullName,
      worker.branch,
      worker.prNumber,
      prodBranch
    );

    if (!mergeResult.merged) {
      return {
        status: 'failed',
        message: `Release: FAILED — could not merge to ${prodBranch}: ${mergeResult.message}`,
        error: mergeResult.message,
      };
    }

    mergedAt = new Date().toISOString();
    mergeSha = mergeResult.sha;
  }

  // Step 2: Poll Vercel for deployment
  let deployUrl: string | null = null;
  let deployState: string | undefined;

  if (branchMerge.deployTarget?.type === 'vercel') {
    const { projectId, teamId } = branchMerge.deployTarget;
    if (!projectId) {
      return {
        status: 'failed',
        message: 'Release: FAILED — deployTarget.projectId is required for Vercel deploys',
        error: 'Missing Vercel projectId',
      };
    }

    try {
      // Brief delay to let Vercel pick up the push
      await new Promise((res) => setTimeout(res, 8_000));
      const deploy = await pollVercelDeployment(projectId, teamId, prodBranch);
      deployState = deploy.state;
      deployUrl = deploy.url;

      if (deploy.state !== 'READY') {
        const hookResults: ReleaseResult['hooksRan'] = [];
        return {
          status: 'failed',
          message: `Release: FAILED — Vercel deploy ${deploy.state}${deploy.url ? ` at ${deploy.url}` : ''}`,
          mergedAt,
          deployUrl: deploy.url ?? undefined,
          deployState: deploy.state,
          hooksRan: hookResults,
          error: `Deploy state: ${deploy.state}`,
        };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        status: 'failed',
        message: `Release: FAILED — Vercel polling error: ${msg}`,
        mergedAt,
        error: msg,
      };
    }
  }

  // Step 3: Post-deploy hooks
  const hooksRan: NonNullable<ReleaseResult['hooksRan']> = [];
  let hookFailed = false;

  if (branchMerge.postDeployHooks && branchMerge.postDeployHooks.length > 0) {
    for (const hook of branchMerge.postDeployHooks) {
      const result = await runHook(hook);
      hooksRan.push(result);
      if (!result.success) hookFailed = true;
    }
  }

  // Compose final result
  const vercelLine = deployUrl ? ` at ${deployUrl}` : '';
  const summaryLine = hookFailed
    ? `Release: completed with hook errors — prod READY${vercelLine}`
    : `Release: completed, prod READY${vercelLine}`;

  return {
    status: 'completed',
    message: summaryLine,
    mergedAt,
    deployUrl: deployUrl ?? undefined,
    deployState: deployState ?? 'READY',
    hooksRan: hooksRan.length > 0 ? hooksRan : undefined,
  };
}
