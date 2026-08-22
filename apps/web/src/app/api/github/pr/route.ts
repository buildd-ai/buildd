import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { workers, githubRepos, missions, tasks, workspaces } from '@buildd/core/db/schema';
import { eq, and, isNull, isNotNull, inArray } from 'drizzle-orm';
import { githubApi, mergePullRequest } from '@/lib/github';
import { authenticateApiKey } from '@/lib/api-auth';
import { getTeamWorkspaceIds } from '@/lib/team-access';
import { supersedeAncestorEscalations } from '@/lib/escalation-supersession';
import {
  resolveMatchedSurfaces,
  recordChangeIntents,
  findConflictingIntents,
  postConflictWarnings,
} from '@/lib/change-intent';
import { classifyMergeFailure, dispatchConflictRetry } from '@/lib/conflict-retry';

/**
 * Resolve a worker by PR number across the account's accessible workspaces.
 *
 * Used by GET and PUT when workerId is not provided. Mirrors the pattern in
 * prs/[prNumber]/merge/route.ts but uses team-based workspace access for
 * API-key accounts (getTeamWorkspaceIds) instead of user-session access.
 *
 * Returns the worker row (with workspace) or an error descriptor.
 */
async function resolveWorkerByPrNumber(
  account: { teamId: string },
  prNumber: number,
  workspaceId: string | null | undefined,
): Promise<{ error: string; status: number; candidates?: string[] } | Record<string, any>> {
  const wsIds = await getTeamWorkspaceIds(account.teamId);
  if (wsIds.length === 0) {
    return { error: 'No workspaces found for account', status: 403 };
  }

  // Resolve workspaceId to a UUID — callers may pass a repo name (e.g. "moa-ops")
  // rather than a UUID. wsIds only contains UUIDs, so a direct includes() check
  // misses name-based inputs and silently falls back to searching all workspaces.
  let narrowedWsId: string | null = null;
  if (workspaceId) {
    if (wsIds.includes(workspaceId)) {
      narrowedWsId = workspaceId;
    } else {
      const allWs = await db.query.workspaces.findMany({
        where: inArray(workspaces.id, wsIds),
        columns: { id: true, name: true, repo: true },
      });
      const lower = workspaceId.toLowerCase();
      const match = allWs.find(ws =>
        ws.name.toLowerCase() === lower ||
        ws.repo?.toLowerCase() === lower ||
        ws.repo?.toLowerCase().endsWith('/' + lower)
      );
      if (match) narrowedWsId = match.id;
    }
  }

  const searchIds = narrowedWsId ? [narrowedWsId] : wsIds;

  const matchingWorkers = await db.query.workers.findMany({
    where: and(
      inArray(workers.workspaceId, searchIds),
      eq(workers.prNumber, prNumber),
      isNotNull(workers.prUrl),
      isNull(workers.mergedAt),
    ),
    with: { workspace: true },
  });

  if (matchingWorkers.length === 0) {
    return { error: 'PR not found or already merged', status: 404 };
  }

  const distinctWorkspaceIds = new Set(matchingWorkers.map((w) => w.workspaceId));
  if (distinctWorkspaceIds.size > 1) {
    return {
      error: `PR #${prNumber} exists in multiple workspaces — pass workspaceId to disambiguate`,
      status: 409,
      candidates: [...distinctWorkspaceIds],
    };
  }

  return matchingWorkers[0];
}

// POST /api/github/pr - Create a pull request
export async function POST(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;

  const account = await authenticateApiKey(apiKey);
  if (!account) {
    return NextResponse.json({ error: 'Invalid API key' }, { status: 401 });
  }

  try {
    const body = await req.json();
    const { workerId, title, body: prBody, head, base, draft, prUrl: existingPrUrl } = body;

    if (!workerId) {
      return NextResponse.json({ error: 'workerId required' }, { status: 400 });
    }

    if (!title || !head) {
      return NextResponse.json({ error: 'title and head branch required' }, { status: 400 });
    }

    // Get the worker with its workspace and task
    const worker = await db.query.workers.findFirst({
      where: eq(workers.id, workerId),
      with: { workspace: true, task: true },
    });

    if (!worker) {
      return NextResponse.json({ error: 'Worker not found' }, { status: 404 });
    }

    // Verify the account's team has access to this worker's workspace.
    // accountId equality is wrong for multi-account teams — the runner's account
    // differs from the MCP OAuth account. Team membership is the correct boundary.
    if (worker.workspace?.teamId !== account.teamId) {
      return NextResponse.json({ error: 'Worker belongs to different account' }, { status: 403 });
    }

    // If an existing PR URL is provided, register it directly without going through GitHub API.
    // This allows agents to satisfy pr_required even when the workspace has no GitHub App installation
    // (e.g. the PR was created via gh CLI in a different repo).
    if (existingPrUrl) {
      if (worker.prUrl && worker.prNumber) {
        await db
          .update(workers)
          .set({ updatedAt: new Date() })
          .where(eq(workers.id, workerId));
        return NextResponse.json({
          ok: true,
          pr: { number: worker.prNumber, url: worker.prUrl, state: 'open', title },
          deduplicated: true,
        });
      }
      const prNumberMatch = existingPrUrl.match(/\/pull\/(\d+)/);
      const prNumber = prNumberMatch ? parseInt(prNumberMatch[1], 10) : null;
      await db.update(workers).set({
        prUrl: existingPrUrl,
        prNumber,
        updatedAt: new Date(),
      }).where(eq(workers.id, workerId));
      if (prNumber) {
        await persistMissionPrIfFirst(worker.task?.missionId, prNumber, existingPrUrl);
        await supersedeAncestorEscalations(db, worker.task?.parentTaskId, prNumber);
      }
      return NextResponse.json({
        ok: true,
        pr: { number: prNumber, url: existingPrUrl, state: 'open', title },
      });
    }

    // Dedup: if another worker on the SAME TASK already has an open PR, reuse it.
    // This covers refires/retries where a new worker is created for the same task —
    // ONE task = ONE branch = ONE PR, even across worker instances.
    // Checked before workspace/repo lookup to short-circuit without hitting GitHub.
    if (worker.taskId) {
      const siblingWorkerWithPr = await db.query.workers.findFirst({
        where: and(
          eq(workers.taskId, worker.taskId),
          isNotNull(workers.prUrl),
          isNotNull(workers.prNumber),
        ),
        columns: { prUrl: true, prNumber: true, id: true },
      });
      if (siblingWorkerWithPr?.prUrl && siblingWorkerWithPr.prNumber) {
        // Mirror the PR onto this worker too so future calls hit the fast path
        await db
          .update(workers)
          .set({ prUrl: siblingWorkerWithPr.prUrl, prNumber: siblingWorkerWithPr.prNumber, updatedAt: new Date() })
          .where(eq(workers.id, workerId));
        await supersedeAncestorEscalations(
          db,
          worker.task?.parentTaskId,
          siblingWorkerWithPr.prNumber,
        );
        return NextResponse.json({
          ok: true,
          pr: {
            number: siblingWorkerWithPr.prNumber,
            url: siblingWorkerWithPr.prUrl,
            state: 'open',
            title,
          },
          deduplicated: true,
        });
      }
    }

    const workspace = worker.workspace;
    if (!workspace?.githubRepoId || !workspace?.githubInstallationId) {
      return NextResponse.json({ error: 'Workspace not linked to GitHub repo' }, { status: 400 });
    }

    // Get the GitHub repo details
    const repo = await db.query.githubRepos.findFirst({
      where: eq(githubRepos.id, workspace.githubRepoId),
      with: { installation: true },
    });

    if (!repo || !repo.installation) {
      return NextResponse.json({ error: 'GitHub repo not found' }, { status: 404 });
    }

    // Dedup: if worker already has a PR, return the existing one
    if (worker.prUrl && worker.prNumber) {
      await db
        .update(workers)
        .set({ updatedAt: new Date() })
        .where(eq(workers.id, workerId));
      return NextResponse.json({
        ok: true,
        pr: {
          number: worker.prNumber,
          url: worker.prUrl,
          state: 'open',
          title: title,
        },
        deduplicated: true,
      });
    }

    const taskContext = worker.task?.context as Record<string, unknown> | null;
    const contextBaseBranch = taskContext?.baseBranch as string | undefined;
    const retryIteration = typeof taskContext?.iteration === 'number' ? taskContext.iteration : 0;
    const maxIterations = typeof taskContext?.maxIterations === 'number' ? taskContext.maxIterations : 3;

    // Dedup: check if a PR already exists for this head branch
    try {
      const existingPrs = await githubApi(
        repo.installation.installationId,
        `/repos/${repo.fullName}/pulls?head=${encodeURIComponent(repo.fullName.split('/')[0] + ':' + head)}&state=open`,
      );
      if (Array.isArray(existingPrs) && existingPrs.length > 0) {
        const existing = existingPrs[0];
        // Fetch individual PR to get diff stats (list endpoint omits additions/deletions/changed_files)
        let prDetail = existing;
        try {
          prDetail = await githubApi(
            repo.installation.installationId,
            `/repos/${repo.fullName}/pulls/${existing.number}`,
          );
        } catch {}
        // Update worker with the existing PR info and diff stats
        await db
          .update(workers)
          .set({
            prUrl: existing.html_url,
            prNumber: existing.number,
            ...(typeof prDetail.additions === 'number' ? { linesAdded: prDetail.additions } : {}),
            ...(typeof prDetail.deletions === 'number' ? { linesRemoved: prDetail.deletions } : {}),
            ...(typeof prDetail.changed_files === 'number' ? { filesChanged: prDetail.changed_files } : {}),
            updatedAt: new Date(),
          })
          .where(eq(workers.id, workerId));

        await persistMissionPrIfFirst(worker.task?.missionId, existing.number, existing.html_url);
        await supersedeAncestorEscalations(db, worker.task?.parentTaskId, existing.number);

        // Stamp retry attempt on the existing PR body so the attempt count is
        // visible on the PR itself (not just the reviewer task).
        if (retryIteration > 0) {
          try {
            const currentBody: string = prDetail.body ?? existing.body ?? '';
            const attemptLine = `_Attempt ${retryIteration + 1}/${maxIterations} — retry task \`${worker.taskId}\`._`;
            // Replace an existing attempt line or append a new one.
            const attemptPattern = /_Attempt \d+\/\d+ — retry task `[^`]+`\._/;
            const updatedBody = attemptPattern.test(currentBody)
              ? currentBody.replace(attemptPattern, attemptLine)
              : `${currentBody}\n\n---\n${attemptLine}`;
            await githubApi(
              repo.installation.installationId,
              `/repos/${repo.fullName}/pulls/${existing.number}`,
              { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body: updatedBody }) },
            );
          } catch {
            // Non-fatal — attempt stamp is best-effort
          }
        }

        return NextResponse.json({
          ok: true,
          pr: {
            number: existing.number,
            url: existing.html_url,
            state: existing.state,
            title: existing.title,
          },
          deduplicated: true,
        });
      }
    } catch {
      // If the check fails, proceed with creation (GitHub will reject duplicates anyway)
    }

    // Stamp retry lineage into the PR body when this is a fresh fallback PR
    // (resume branch was gone/diverged and a new branch was opened instead of
    // updating the existing one).  Lets humans disambiguate duplicate-looking
    // PRs in the list without reading the diff.
    const lineageSuffix = retryIteration > 0
      ? `\n\n---\n_Attempt ${retryIteration}/${maxIterations} — retry task \`${worker.taskId}\`. Resume branch was unavailable; new PR opened._`
      : '';
    const effectivePrBody = (prBody || `Created by buildd worker ${worker.name}`) + lineageSuffix;

    // Create the PR via GitHub API
    const prData = await githubApi(
      repo.installation.installationId,
      `/repos/${repo.fullName}/pulls`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title,
          body: effectivePrBody,
          head,
          base: base
            // Stacked plan phases store predecessor branch in context.baseBranch
            // Recovery tasks may instead store the current head there, which
            // cannot be used as a PR base.
            || (contextBaseBranch !== head ? contextBaseBranch : undefined)
            || taskContext?.targetBranch as string
            || workspace.gitConfig?.targetBranch
            || workspace.gitConfig?.defaultBranch
            || repo.defaultBranch
            || 'main',
          draft: draft || false,
        }),
      }
    );

    // Update worker with PR info and diff stats from GitHub's response
    await db
      .update(workers)
      .set({
        prUrl: prData.html_url,
        prNumber: prData.number,
        ...(typeof prData.additions === 'number' ? { linesAdded: prData.additions } : {}),
        ...(typeof prData.deletions === 'number' ? { linesRemoved: prData.deletions } : {}),
        ...(typeof prData.changed_files === 'number' ? { filesChanged: prData.changed_files } : {}),
        updatedAt: new Date(),
      })
      .where(eq(workers.id, workerId));

    await persistMissionPrIfFirst(worker.task?.missionId, prData.number, prData.html_url);
    await supersedeAncestorEscalations(db, worker.task?.parentTaskId, prData.number);

    // Guaranteed supersede: when a fallback creates a new PR (resume branch was
    // unavailable), close any open ancestor PRs so at most one PR is mergeable.
    // This is platform-enforced — not left to agent initiative.
    if (retryIteration > 0 && worker.task?.parentTaskId && repo.installation?.installationId) {
      closeAncestorRetryPrs({
        parentTaskId: worker.task.parentTaskId,
        successorPrNumber: prData.number,
        installationId: repo.installation.installationId,
        repoFullName: repo.fullName,
      }).catch(err => console.error('[create_pr] closeAncestorRetryPrs failed (non-fatal):', err));
    }

    // Change-intent: record surface intents + post conflict warnings (best-effort, non-blocking)
    try {
      const taskPathManifest = (worker.task?.pathManifest as string[] | null) ?? [];
      const matchedSurfaces = resolveMatchedSurfaces(taskPathManifest, workspace.gitConfig ?? null);

      if (matchedSurfaces.length > 0) {
        // Record intent rows first (so we don't find ourselves as a conflict)
        await recordChangeIntents({
          workspaceId: workspace.id,
          taskId: worker.taskId ?? null,
          prNumber: prData.number,
          branch: head,
          headSha: prData.head?.sha ?? null,
          matchedSurfaces,
        });

        // Find other open PRs on the same surfaces
        const conflicting = await findConflictingIntents(
          workspace.id,
          matchedSurfaces,
          worker.taskId ?? null,
        );

        if (conflicting.length > 0) {
          await postConflictWarnings({
            currentTaskId: worker.taskId ?? null,
            currentPrNumber: prData.number,
            currentPrUrl: prData.html_url,
            currentSurfaces: matchedSurfaces,
            conflicting,
          });
        }
      }
    } catch (err) {
      // Non-fatal: conflict detection must never fail PR creation
      console.error('[changeIntent] PR conflict detection failed (non-fatal):', err);
    }

    // Auto-merge intent flag: Buildd will merge the PR via webhook when all CI checks pass
    const autoMergeEnabled = !!(workspace.gitConfig?.autoMergeOnGreenCI ?? workspace.gitConfig?.autoMergePR);

    return NextResponse.json({
      ok: true,
      pr: {
        number: prData.number,
        url: prData.html_url,
        state: prData.state,
        title: prData.title,
      },
      ...(autoMergeEnabled ? { autoMergeEnabled: true } : {}),
    });
  } catch (error) {
    console.error('Create PR error:', error);
    const message = error instanceof Error ? error.message : 'Failed to create PR';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// PATCH /api/github/pr - Close a pull request
export async function PATCH(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;

  const account = await authenticateApiKey(apiKey);
  if (!account) {
    return NextResponse.json({ error: 'Invalid API key' }, { status: 401 });
  }

  try {
    const body = await req.json();
    const { workerId, prNumber } = body;

    if (!workerId) {
      return NextResponse.json({ error: 'workerId required' }, { status: 400 });
    }
    if (!prNumber || typeof prNumber !== 'number') {
      return NextResponse.json({ error: 'prNumber required' }, { status: 400 });
    }

    const worker = await db.query.workers.findFirst({
      where: eq(workers.id, workerId),
      with: { workspace: true },
    });

    if (!worker) {
      return NextResponse.json({ error: 'Worker not found' }, { status: 404 });
    }

    if (worker.workspace?.teamId !== account.teamId) {
      return NextResponse.json({ error: 'Worker belongs to different account' }, { status: 403 });
    }

    const workspace = worker.workspace;
    if (!workspace?.githubRepoId || !workspace?.githubInstallationId) {
      return NextResponse.json({ error: 'Workspace not linked to GitHub repo' }, { status: 400 });
    }

    const repo = await db.query.githubRepos.findFirst({
      where: eq(githubRepos.id, workspace.githubRepoId),
      with: { installation: true },
    });

    if (!repo || !repo.installation) {
      return NextResponse.json({ error: 'GitHub repo not found' }, { status: 404 });
    }

    const prData = await githubApi(
      repo.installation.installationId,
      `/repos/${repo.fullName}/pulls/${prNumber}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state: 'closed' }),
      }
    );

    return NextResponse.json({
      ok: true,
      pr: {
        number: prData.number,
        url: prData.html_url,
        state: prData.state,
        title: prData.title,
      },
    });
  } catch (error) {
    console.error('Close PR error:', error);
    const message = error instanceof Error ? error.message : 'Failed to close PR';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// PUT /api/github/pr - Merge a pull request
export async function PUT(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;

  const account = await authenticateApiKey(apiKey);
  if (!account) {
    return NextResponse.json({ error: 'Invalid API key' }, { status: 401 });
  }

  try {
    const body = await req.json();
    const { workerId, prNumber, mergeMethod = 'squash', workspaceId } = body;

    if (!prNumber || typeof prNumber !== 'number') {
      return NextResponse.json({ error: 'prNumber required' }, { status: 400 });
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let worker: any;

    if (workerId) {
      worker = await db.query.workers.findFirst({
        where: eq(workers.id, workerId),
        with: { workspace: true },
      });
      if (!worker) {
        return NextResponse.json({ error: 'Worker not found' }, { status: 404 });
      }
      if (worker.workspace?.teamId !== account.teamId) {
        return NextResponse.json({ error: 'Worker belongs to different account' }, { status: 403 });
      }
    } else {
      // workerId absent — resolve worker from prNumber across the account's workspaces.
      // Accepts optional workspaceId for disambiguation when multiple workspaces share a prNumber.
      const resolved = await resolveWorkerByPrNumber(account, prNumber, workspaceId);
      if (typeof resolved.status === 'number') {
        return NextResponse.json(
          { error: resolved.error, ...(resolved.candidates ? { candidates: resolved.candidates } : {}) },
          { status: resolved.status },
        );
      }
      worker = resolved;
    }

    const workspace = worker.workspace;
    if (!workspace?.githubRepoId || !workspace?.githubInstallationId) {
      return NextResponse.json({ error: 'Workspace not linked to GitHub repo' }, { status: 400 });
    }

    const repo = await db.query.githubRepos.findFirst({
      where: eq(githubRepos.id, workspace.githubRepoId),
      with: { installation: true },
    });

    if (!repo || !repo.installation) {
      return NextResponse.json({ error: 'GitHub repo not found' }, { status: 404 });
    }

    const result = await mergePullRequest(
      repo.installation.installationId,
      repo.fullName,
      prNumber,
      mergeMethod as 'merge' | 'squash' | 'rebase',
    );

    if (result.merged) {
      await db
        .update(workers)
        .set({ mergedAt: new Date(), prLifecycleStatus: 'merged', updatedAt: new Date() })
        .where(eq(workers.id, worker.id));
    } else if (/resource not accessible by integration/i.test(result.message)) {
      // The GitHub App installation lacks the required permissions.
      // Merging requires pull_requests:write AND contents:write.
      // Closing (close_pr) only needs pull_requests:write, which explains why close
      // succeeds but merge fails on a fresh installation.
      return NextResponse.json({
        error: result.message,
        hint: 'GitHub App merge requires contents:write permission in addition to pull_requests:write. Update the App permissions at github.com/settings/apps and have org admins re-accept.',
      }, { status: 403 });
    } else if (classifyMergeFailure(result.message) === 'conflict' && worker.taskId) {
      // PR has conflicts — dispatch a same-branch resolution retry instead of surfacing
      // a useless retry-the-merge button.
      let headSha = worker.lastCommitSha ?? '';
      if (!headSha) {
        try {
          const prData = await githubApi(repo.installation.installationId, `/repos/${repo.fullName}/pulls/${prNumber}`);
          headSha = prData?.head?.sha ?? '';
        } catch { /* non-fatal */ }
      }
      if (headSha && worker.taskId) {
        const dispatchResult = await dispatchConflictRetry({
          workerId: worker.id,
          taskId: worker.taskId,
          prNumber,
          headSha,
          repoFullName: repo.fullName,
          workspaceId: worker.workspaceId,
        }).catch(err => {
          console.error(`[github/pr] conflict-retry dispatch failed for PR #${prNumber}:`, err);
          return { dispatched: false } as import('@/lib/conflict-retry').DispatchConflictRetryResult;
        });
        const message = dispatchResult.dispatched
          ? `PR #${prNumber} has merge conflicts. Conflict-resolution task dispatched (${dispatchResult.taskId}).`
          : dispatchResult.exhausted
          ? `PR #${prNumber} has merge conflicts and conflict-resolution retries are exhausted. Human action required.`
          : result.message;
        return NextResponse.json({
          ok: false,
          merged: false,
          message,
          conflictRetryDispatched: dispatchResult.dispatched,
          conflictExhausted: dispatchResult.exhausted,
          pr: { number: prNumber, url: worker.prUrl ?? null },
        });
      }
    }

    return NextResponse.json({
      ok: result.merged,
      merged: result.merged,
      message: result.message,
      pr: {
        number: prNumber,
        url: worker.prUrl ?? null,
      },
    });
  } catch (error) {
    console.error('Merge PR error:', error);
    const message = error instanceof Error ? error.message : 'Failed to merge PR';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// GET /api/github/pr?workerId=...&prNumber=... - Read PR details
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;

  const account = await authenticateApiKey(apiKey);
  if (!account) {
    return NextResponse.json({ error: 'Invalid API key' }, { status: 401 });
  }

  try {
    const { searchParams } = new URL(req.url);
    const workerId = searchParams.get('workerId');
    const prNumberParam = searchParams.get('prNumber');
    const workspaceIdParam = searchParams.get('workspaceId');

    if (!workerId && !prNumberParam) {
      return NextResponse.json({ error: 'workerId or prNumber required' }, { status: 400 });
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let worker: any;
    let resolvedPrNumber: number;

    if (workerId) {
      worker = await db.query.workers.findFirst({
        where: eq(workers.id, workerId),
        with: { workspace: true },
      });
      if (!worker) {
        return NextResponse.json({ error: 'Worker not found' }, { status: 404 });
      }
      if (worker.workspace?.teamId !== account.teamId) {
        return NextResponse.json({ error: 'Worker belongs to different account' }, { status: 403 });
      }
      const parsed = prNumberParam ? parseInt(prNumberParam, 10) : worker.prNumber;
      if (!parsed) {
        return NextResponse.json(
          { error: 'prNumber required — pass ?prNumber= or ensure worker has a PR' },
          { status: 400 },
        );
      }
      resolvedPrNumber = parsed;
    } else {
      // No workerId — resolve worker from prNumber across the account's workspaces.
      const prNum = parseInt(prNumberParam!, 10);
      if (isNaN(prNum)) {
        return NextResponse.json({ error: 'Invalid prNumber' }, { status: 400 });
      }
      const resolved = await resolveWorkerByPrNumber(account, prNum, workspaceIdParam);
      // Discriminate on numeric status: error descriptors carry { error: string, status: number }
      // while Drizzle worker rows carry status as a text column ('idle', 'active', etc.).
      // 'error' in resolved is always true for DB rows because the error column always exists.
      if (typeof resolved.status === 'number') {
        return NextResponse.json(
          { error: resolved.error, ...(resolved.candidates ? { candidates: resolved.candidates } : {}) },
          { status: resolved.status },
        );
      }
      worker = resolved;
      resolvedPrNumber = prNum;
    }

    const workspace = worker.workspace;
    if (!workspace?.githubRepoId || !workspace?.githubInstallationId) {
      return NextResponse.json({ error: 'Workspace not linked to GitHub repo' }, { status: 400 });
    }

    const repo = await db.query.githubRepos.findFirst({
      where: eq(githubRepos.id, workspace.githubRepoId),
      with: { installation: true },
    });

    if (!repo || !repo.installation) {
      return NextResponse.json({ error: 'GitHub repo not found' }, { status: 404 });
    }

    const prNumber = resolvedPrNumber;

    const installationId = repo.installation.installationId;
    const fullName = repo.fullName;

    // Fetch PR first to get headSha for the check-runs query
    const pr = await githubApi(installationId, `/repos/${fullName}/pulls/${prNumber}`);
    const headSha = pr.head?.sha;

    // Fetch CI checks and reviews in parallel
    const [checksResult, reviewsResult] = await Promise.allSettled([
      headSha
        ? githubApi(installationId, `/repos/${fullName}/commits/${headSha}/check-runs?per_page=100`)
        : Promise.resolve(null),
      githubApi(installationId, `/repos/${fullName}/pulls/${prNumber}/reviews`),
    ]);

    const checksData = checksResult.status === 'fulfilled' ? checksResult.value : null;
    const reviewsData = reviewsResult.status === 'fulfilled' ? reviewsResult.value : null;

    // Summarise CI checks
    const checkRuns = Array.isArray(checksData?.check_runs) ? checksData.check_runs : [];
    const terminal = (c: any) => c.status === 'completed';
    const passing = (c: any) => terminal(c) && (c.conclusion === 'success' || c.conclusion === 'skipped' || c.conclusion === 'neutral');
    const failing = (c: any) => terminal(c) && (c.conclusion === 'failure' || c.conclusion === 'timed_out' || c.conclusion === 'cancelled' || c.conclusion === 'action_required');
    const ciSummary = {
      total: checkRuns.length,
      passed: checkRuns.filter(passing).length,
      failed: checkRuns.filter(failing).length,
      pending: checkRuns.filter((c: any) => !terminal(c)).length,
      state: checkRuns.length === 0 ? 'none' as const
        : checkRuns.every(passing) ? 'success' as const
        : checkRuns.some(failing) ? 'failure' as const
        : 'pending' as const,
    };

    // Summarise reviews — count only the latest actionable review per user.
    // Skip COMMENTED (comment-only submits) so a follow-up comment after an
    // approval doesn't overwrite the approval in the Map.
    const ACTIONABLE_REVIEW_STATES = new Set(['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED', 'PENDING']);
    const reviewList = Array.isArray(reviewsData) ? reviewsData : [];
    const latestByUser = new Map<string, string>();
    for (const r of reviewList) {
      if (r.user?.login && ACTIONABLE_REVIEW_STATES.has(r.state)) {
        latestByUser.set(r.user.login, r.state);
      }
    }
    const reviewStates = [...latestByUser.values()];
    const reviewSummary = {
      approved: reviewStates.filter(s => s === 'APPROVED').length,
      changesRequested: reviewStates.filter(s => s === 'CHANGES_REQUESTED').length,
      pending: reviewStates.filter(s => s === 'PENDING').length,
    };

    return NextResponse.json({
      ok: true,
      pr: {
        number: prNumber,
        title: pr.title ?? null,
        body: pr.body ?? null,
        state: pr.state ?? null,
        url: pr.html_url ?? worker.prUrl ?? null,
        mergeable: pr.mergeable ?? null,
        mergeableState: pr.mergeable_state ?? null,
        headSha: headSha ?? worker.lastCommitSha ?? null,
        additions: pr.additions ?? null,
        deletions: pr.deletions ?? null,
        changedFiles: pr.changed_files ?? null,
      },
      checks: ciSummary,
      reviews: reviewSummary,
    });
  } catch (error) {
    console.error('Get PR error:', error);
    const message = error instanceof Error ? error.message : 'Failed to get PR';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

async function persistMissionPrIfFirst(
  missionId: string | null | undefined,
  prNumber: number,
  prUrl: string,
): Promise<void> {
  if (!missionId) return;
  await db
    .update(missions)
    .set({ primaryPrNumber: prNumber, primaryPrUrl: prUrl, updatedAt: new Date() })
    .where(and(eq(missions.id, missionId), isNull(missions.primaryPrNumber)));
}

/**
 * Close open PRs from ancestor retry tasks when a fallback opens a new PR.
 *
 * Walk the parentTaskId chain, collect all ancestor task IDs, find workers
 * with open PRs on those tasks, and close each via GitHub API with a comment
 * linking the successor. Best-effort — errors are logged but not fatal.
 */
async function closeAncestorRetryPrs(opts: {
  parentTaskId: string;
  successorPrNumber: number;
  installationId: number;
  repoFullName: string;
}): Promise<void> {
  const { parentTaskId, successorPrNumber, installationId, repoFullName } = opts;

  // Walk task ancestry to collect all ancestor task IDs
  const ancestorTaskIds: string[] = [];
  const visited = new Set<string>();
  let taskId: string | null = parentTaskId;
  while (taskId && !visited.has(taskId)) {
    visited.add(taskId);
    ancestorTaskIds.push(taskId);
    const currentId: string = taskId;
    const parent = await db.query.tasks.findFirst({
      where: eq(tasks.id, currentId),
      columns: { parentTaskId: true },
    });
    taskId = parent?.parentTaskId ?? null;
  }

  if (ancestorTaskIds.length === 0) return;

  // Find workers with open PRs on ancestor tasks
  const ancestorWorkers = await db.query.workers.findMany({
    where: and(
      inArray(workers.taskId, ancestorTaskIds),
      isNotNull(workers.prNumber),
    ),
    columns: { prNumber: true, prUrl: true },
  });

  const prNumbers = [...new Set(
    ancestorWorkers
      .map(w => w.prNumber)
      .filter((n): n is number => typeof n === 'number' && n !== successorPrNumber),
  )];

  for (const prNumber of prNumbers) {
    try {
      // Post supersession comment
      const comment =
        `This pull request has been superseded by #${successorPrNumber} ` +
        `(resume branch was unavailable; new attempt opened a fresh PR). ` +
        `Closing to prevent accidental merge of a rejected attempt.`;
      await githubApi(installationId, `/repos/${repoFullName}/issues/${prNumber}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: comment }),
      });
      // Close the PR
      await githubApi(installationId, `/repos/${repoFullName}/pulls/${prNumber}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state: 'closed' }),
      });
      console.log(`[create_pr] Closed ancestor retry PR #${prNumber} superseded by #${successorPrNumber}`);
    } catch (err) {
      console.error(`[create_pr] Failed to close ancestor PR #${prNumber}:`, err);
    }
  }
}
