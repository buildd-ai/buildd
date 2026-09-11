import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { workers, githubRepos, missions, tasks, workspaces } from '@buildd/core/db/schema';
import { eq, and, isNull, isNotNull, inArray } from 'drizzle-orm';
import { githubApi, mergePullRequest } from '@/lib/github';
// One implementation of the primary-PR claim and of "what counts as trunk",
// shared with the mission-PR opener. Two copies of a base-ref rule is how
// the branch-name generator drifted (P8).
import { claimMissionPrimaryPr, trunkBranches, MISSION_PR_TASK_PREFIX, guardMissionPrMerge, finalizeMissionPrMerge } from '@/lib/mission-pr';
import { buildMissionBaseGuard } from '@/lib/mission-base-guard';
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
import { escalateConflictExhaustion, evaluateAutoMergeSafety } from '@/lib/auto-merge';
import { resolvePolicy, RESOLVE_POLICY_MISSION_COLUMNS } from '@/lib/merge-policy';
import { readPrReviewStatus, listWorkspaceRoles } from '@/lib/pr-review-request';
import { createReviewerTask, findLiveReviewerTaskForHead } from '@/lib/reviewer';
import { dispatchNewTask } from '@/lib/task-dispatch';
import { appendPrActivity } from '@/lib/pr-activity-comment';
import { pickReviewerRole } from '@/lib/pr-review-status';
// One resolver for "which worker owns PR #N", shared with the `explain` MCP read.
import { resolveWorkerByPrNumber } from '@/lib/pr-resolve';


/**
 * Request a review for a task PR that targets a mission's integration branch.
 *
 * Callers gate this on `missionBaseGuard.enforced` (see `@/lib/mission-base-guard`,
 * the shared source of truth for "is this PR's base the mission's integration
 * branch"), so this function does not re-derive that — it only decides which
 * reviewer role to use and dedupes against an already in-flight review. This
 * exists because a manual-orchestration mission has no heartbeat loop to
 * notice an open task PR sitting unreviewed, so the request is fired here,
 * at the moment the PR is created or adopted, instead.
 *
 * Best-effort: any failure is logged and swallowed. Requesting a review must
 * never fail PR creation/adoption itself.
 */
async function requestIntegrationBranchReview(params: {
  workspace: { id: string; gitConfig?: unknown };
  teamId: string;
  task: {
    id: string;
    title: string;
    description: string | null;
    backend: 'claude' | 'codex';
    missionId: string | null;
    pathManifest?: string[] | null;
    requiresReview?: boolean | null;
  };
  head: string;
  prNumber: number;
  prUrl: string;
  headSha: string;
  baseRef: string;
  installationId: number;
  repoFullName: string;
}): Promise<void> {
  try {
    const existingReview = await findLiveReviewerTaskForHead(
      params.workspace.id,
      params.prNumber,
      params.headSha,
    );
    if (existingReview) return;

    const mission = params.task.missionId
      ? await db.query.missions.findFirst({
          where: eq(missions.id, params.task.missionId),
          columns: RESOLVE_POLICY_MISSION_COLUMNS,
        })
      : null;

    const policy = resolvePolicy(
      params.workspace as never,
      mission,
      { requiresReview: params.task.requiresReview ?? false },
      { baseRef: params.baseRef },
    );
    const roles = await listWorkspaceRoles(params.workspace.id, params.teamId);
    const picked = pickReviewerRole({
      requested: null,
      policyRole: policy.agentReview?.reviewerRole ?? null,
      available: roles,
    });
    if (!picked.role) return;

    const reviewerTask = await createReviewerTask({
      workspaceId: params.workspace.id,
      originalTaskId: params.task.id,
      originalTask: {
        title: params.task.title,
        description: params.task.description,
        backend: params.task.backend,
        missionId: params.task.missionId,
        pathManifest: params.task.pathManifest ?? null,
      },
      worker: { branch: params.head },
      prNumber: params.prNumber,
      prUrl: params.prUrl,
      headSha: params.headSha,
      reviewerRole: picked.role,
      installationId: params.installationId,
      repoFullName: params.repoFullName,
    });

    if (reviewerTask?.id && !reviewerTask.deduplicated) {
      await dispatchNewTask(
        {
          id: reviewerTask.id,
          title: `Review PR #${params.prNumber}: ${params.task.title}`,
          description: null,
          workspaceId: params.workspace.id,
          missionId: params.task.missionId,
        },
        params.workspace as never,
      );

      await appendPrActivity({
        installationId: params.installationId,
        repoFullName: params.repoFullName,
        prNumber: params.prNumber,
        entry: { kind: 'reviewing', detail: `reviewer role \`${picked.role}\`` },
        workspaceId: params.workspace.id,
      }).catch(() => {});
    }
  } catch (err) {
    console.error(`[create_pr] auto-review request failed (non-fatal) for PR #${params.prNumber}:`, err);
  }
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

    // Option A′ derivation — read once, used everywhere below that a PR's head
    // or base needs to be checked against a mission's integration branch:
    // adoption of an out-of-band PR, the HEAD guard, and the DERIVE-DON'T-ACCEPT
    // checks at PR creation. `missionIntegrationBase` returns null for a mission
    // that has not opted in, which is what makes every check below inert for
    // such a mission (and for a task with no mission at all).
    const mission = worker.task?.missionId
      ? await db.query.missions.findFirst({
          where: eq(missions.id, worker.task.missionId),
          columns: { workingBranch: true, integrationBranchEnabled: true },
        })
      : null;
    // The same guard object every other door uses (completion auto-detect,
    // webhook retarget), so a base this route refuses cannot be acquired by
    // walking in through one of them instead.
    const missionBaseGuard = buildMissionBaseGuard({ mission, task: worker.task, head });
    const integrationBase = missionBaseGuard.integrationBase;
    const isMissionPrOwner = missionBaseGuard.isMissionPrOwner;
    const taskContext = worker.task?.context as Record<string, unknown> | null;
    const contextBaseBranch = taskContext?.baseBranch as string | undefined;
    const isStackedPhase = missionBaseGuard.isStackedPhase;

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

      // ── Mission-integration legality gate on adoption ──────────────────────
      // A PR adopted through this path was opened OUTSIDE buildd (e.g. `gh pr
      // create`), so `create_pr` never derived its base — the caller's `base`
      // here is the only claim we have. Refuse rather than record-and-move-on:
      // the whole point of Option A′ is that a mission task PR MUST target the
      // integration branch, and silently accepting an adoption whose claimed
      // base disagrees (or omits it) would let exactly that gate quietly
      // vanish on a PR buildd never got to derive. The caller can retarget
      // the real PR on GitHub and retry.
      const prNumberMatch = existingPrUrl.match(/\/pull\/(\d+)/);
      const prNumber = prNumberMatch ? parseInt(prNumberMatch[1], 10) : null;
      // Hoisted out of the `enforced` branch below so a successful review-status
      // read there can be reused afterwards to request a review — the whole
      // point of fetching the real PR here is that it's the only place on this
      // path that ever calls GitHub, so re-fetching it just for the review
      // request would be wasted work on the common (non-mission) path too.
      let adoptRepo: { fullName: string; installation: { installationId: number } | null } | undefined;
      let realPr: { head?: { sha?: string | null }; base?: { ref?: string | null } } | null = null;
      if (missionBaseGuard.enforced) {
        // Prefer GitHub's answer over the caller's. The caller-supplied `base`
        // is a *claim* about a PR buildd never opened, and a claim is exactly
        // what this gate exists to stop being load-bearing: an agent can pass
        // `base: <integration branch>` while the real PR targets trunk, and the
        // check would pass on the strength of the sentence rather than the
        // pull request. When the workspace has a GitHub App installation we can
        // simply read the real base ref; when it does not (the case this whole
        // path was added for) we fall back to the claim, which is still better
        // than recording the violation and moving on.
        let observedBase: string | null = typeof base === 'string' ? base : null;
        if (prNumber && worker.workspace?.githubRepoId) {
          adoptRepo = await db.query.githubRepos.findFirst({
            where: eq(githubRepos.id, worker.workspace.githubRepoId),
            with: { installation: true },
          });
          if (adoptRepo?.installation && existingPrUrl.includes(`/${adoptRepo.fullName}/pull/`)) {
            try {
              realPr = await githubApi(
                adoptRepo.installation.installationId,
                `/repos/${adoptRepo.fullName}/pulls/${prNumber}`,
              );
              if (typeof realPr?.base?.ref === 'string' && realPr.base.ref) {
                observedBase = realPr.base.ref;
              }
            } catch {
              // Unreadable — keep the claim. Unknown still refuses below.
              realPr = null;
            }
          }
        }
        const refusal = missionBaseGuard.refusal(observedBase, { prNumber, action: 'adopt' });
        if (refusal) {
          return NextResponse.json(refusal, { status: 400 });
        }
      }
      // NOTE: prBaseRef is deliberately NOT set here. This path registers a PR
      // that was opened outside buildd (e.g. via gh CLI), so the only base we have
      // is the caller-supplied `base` — an unverified claim about a PR we never
      // saw. Recording it would let a wrong value drop a human merge gate; leaving
      // it null keeps today's behaviour until the pull_request webhook reports the
      // real base ref. Unknown degrades to the gate, never away from it.
      await db.update(workers).set({
        prUrl: existingPrUrl,
        prNumber,
        updatedAt: new Date(),
      }).where(eq(workers.id, workerId));
      if (prNumber) {
        await claimMissionPrimaryPr(worker.task?.missionId, prNumber, existingPrUrl, {
          baseRef: typeof base === 'string' ? base : null,
          trunk: trunkBranches(worker.workspace?.gitConfig),
        });
        await supersedeAncestorEscalations(db, worker.task?.parentTaskId, prNumber);

        // Same review request as the fresh-creation path below, for a PR
        // adopted onto the integration branch instead of created by buildd.
        // Needs the real PR fetched above (head SHA, draft state) — an
        // adoption we could only verify via the caller's claim never reaches
        // here, since missionBaseGuard.refusal already rejected it above.
        if (
          missionBaseGuard.enforced &&
          !draft &&
          realPr?.head?.sha &&
          !(realPr as { draft?: boolean }).draft &&
          adoptRepo?.installation &&
          worker.workspace &&
          worker.task
        ) {
          await requestIntegrationBranchReview({
            workspace: { id: worker.workspace.id, gitConfig: worker.workspace.gitConfig },
            teamId: account.teamId,
            task: {
              id: worker.task.id,
              title: worker.task.title,
              description: worker.task.description,
              backend: worker.task.backend,
              missionId: worker.task.missionId,
              pathManifest: worker.task.pathManifest as string[] | null,
              requiresReview: worker.task.requiresReview,
            },
            head,
            prNumber,
            prUrl: existingPrUrl,
            headSha: realPr.head.sha,
            baseRef: realPr.base?.ref ?? integrationBase!,
            installationId: adoptRepo.installation.installationId,
            repoFullName: adoptRepo.fullName,
          });
        }
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
        columns: { prUrl: true, prNumber: true, id: true, prBaseRef: true },
      });
      if (siblingWorkerWithPr?.prUrl && siblingWorkerWithPr.prNumber) {
        // Mirror the PR onto this worker too so future calls hit the fast path.
        // The base ref is copied from the sibling because it is literally the same
        // PR — but only when the sibling actually has one recorded. A sibling from
        // before this column existed has null, and null must stay null rather than
        // become a guess (see workers.prBaseRef).
        await db
          .update(workers)
          .set({
            prUrl: siblingWorkerWithPr.prUrl,
            prNumber: siblingWorkerWithPr.prNumber,
            ...(siblingWorkerWithPr.prBaseRef ? { prBaseRef: siblingWorkerWithPr.prBaseRef } : {}),
            updatedAt: new Date(),
          })
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

        // ── Mission-integration legality gate on dedup-adoption ─────────────
        // This branch adopts a PR buildd did NOT open — that is the whole point
        // of it, and it is also the exact shape of the bypass: an agent runs
        // `gh pr create --base <trunk>` and then calls create_pr, which finds
        // the PR here and records it, returning 200 long before the
        // derive-don't-accept checks further down ever run. Ask the same
        // question those checks ask, against the base GitHub reports.
        const dedupBaseRef = (typeof prDetail.base?.ref === 'string' && prDetail.base.ref)
          ? prDetail.base.ref
          : (typeof existing.base?.ref === 'string' ? existing.base.ref : null);
        const dedupRefusal = missionBaseGuard.refusal(dedupBaseRef, {
          prNumber: existing.number,
          action: 'adopt',
        });
        if (dedupRefusal) {
          return NextResponse.json(dedupRefusal, { status: 400 });
        }

        // Update worker with the existing PR info and diff stats
        await db
          .update(workers)
          .set({
            prUrl: existing.html_url,
            prNumber: existing.number,
            ...(typeof prDetail.additions === 'number' ? { linesAdded: prDetail.additions } : {}),
            ...(typeof prDetail.deletions === 'number' ? { linesRemoved: prDetail.deletions } : {}),
            ...(typeof prDetail.changed_files === 'number' ? { filesChanged: prDetail.changed_files } : {}),
            // Backfill base SHA if not yet recorded — needed by base-rewrite detector
            ...(typeof prDetail.base?.sha === 'string' && !worker.prOpenedBaseSha
              ? { prOpenedBaseSha: prDetail.base.sha }
              : {}),
            // prBaseRef is deliberately NOT set here — see the guarded backfill
            // immediately below. This UPDATE is keyed on the worker id alone, so
            // anything in it wins unconditionally, and prBaseRef is the one
            // column here whose stale value removes a safety gate.
            updatedAt: new Date(),
          })
          .where(eq(workers.id, workerId));

        // ── prBaseRef: BACKFILL only, never overwrite ────────────────────────
        // Our value comes from a `GET /pulls/{n}` taken earlier in this request,
        // and the base ref is mutable — a retarget changes it and the
        // `pull_request` webhook records that within the same seconds. We hold no
        // ordering signal (no ETag, no updated_at comparison), so we cannot tell
        // our snapshot from a fresher one, and "newest observation wins" is not a
        // rule this path can actually implement.
        //
        // The two error directions are not symmetric. A NULL prBaseRef leaves the
        // merge-policy chain untouched and the PR keeps the gate it already had.
        // A WRONG prBaseRef — a mission integration branch on a PR that has since
        // been retargeted to trunk — makes handleCheckSuiteEvent resolve Option
        // A′, drop the tier to auto-threshold, and auto-merge into trunk with the
        // human gate removed. So when in doubt: do not write.
        //
        // `isNull` in the WHERE (not just the in-memory check) is what makes that
        // atomic: it is the same shape as the webhook's guarded write, which
        // excludes its own no-op case in SQL and uses .returning() as the
        // did-anything-change signal.
        const adoptedBaseRefValue = prDetail.base?.ref ?? existing.base?.ref;
        const adoptedBaseRef = typeof adoptedBaseRefValue === 'string' && adoptedBaseRefValue
          ? adoptedBaseRefValue
          : null;
        if (adoptedBaseRef && !worker.prBaseRef) {
          try {
            const filled = await db
              .update(workers)
              .set({ prBaseRef: adoptedBaseRef, updatedAt: new Date() })
              .where(and(eq(workers.id, workerId), isNull(workers.prBaseRef)))
              .returning({ id: workers.id });
            if (filled.length > 0) {
              console.log(
                `[create_pr] backfilled prBaseRef='${adoptedBaseRef}' on worker ${workerId} from adopted PR #${existing.number}`,
              );
            } else {
              // Someone recorded a base ref between our read and this write.
              // Theirs is newer than ours by construction; leaving it is correct.
              console.log(
                `[create_pr] prBaseRef already recorded for worker ${workerId} — adopt-path value '${adoptedBaseRef}' not applied`,
              );
            }
          } catch (err) {
            // Never fail PR adoption over bookkeeping: a missed backfill leaves
            // the column null, which degrades to the existing merge gate, and the
            // next pull_request event for this PR fills it in.
            console.error(`[create_pr] failed to backfill prBaseRef for worker ${workerId}:`, err);
          }
        }

        await claimMissionPrimaryPr(worker.task?.missionId, existing.number, existing.html_url, {
          baseRef: prDetail.base?.ref ?? existing.base?.ref ?? null,
          trunk: trunkBranches(workspace.gitConfig, repo.defaultBranch),
        });
        await supersedeAncestorEscalations(db, worker.task?.parentTaskId, existing.number);

        // Stamp retry attempt on the existing PR body so the attempt count is
        // visible on the PR itself (not just the reviewer task).
        if (retryIteration > 0) {
          try {
            const currentBody: string = prDetail.body ?? existing.body ?? '';
            const attemptLine = `_Attempt ${retryIteration + 1}/${maxIterations} — resume failed; new branch._`;
            // Replace an existing attempt line or append a new one.
            const attemptPattern = /_Attempt \d+\/\d+ — resume failed; new branch\._/;
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
      ? `\n\n---\n_Attempt ${retryIteration}/${maxIterations} — resume failed; new branch._`
      : '';
    const effectivePrBody = (prBody || `Created by buildd worker ${worker.name}`) + lineageSuffix;

    // Mission integration guard: a task worker must NEVER open a PR with the
    // mission integration branch as its HEAD. Only the mission PR owner may do that.
    // When context.baseBranch is a mission integration branch and the runner created
    // a worktree directly on that branch (a bug), this guard catches the bad PR before
    // it bypasses mission-PR coordination.
    if (integrationBase && head === integrationBase && !isMissionPrOwner) {
      // Task worker opened PR with head = mission integration branch (wrong).
      // Only the mission PR owner may do that.
      const recoveryPath = `1. Cut a new task branch from the mission integration branch: git checkout -b buildd/<taskid>-<slug> origin/${integrationBase}\n2. Cherry-pick or re-apply the changes there\n3. Open the PR against the mission branch as base`;
      return NextResponse.json({
        error: `Task PR cannot target the mission integration branch (${integrationBase}) as its HEAD. The mission PR is the coordination unit between trunk and the integration branch. Task PRs must be based on the integration branch, not be the integration branch itself.`,
        hint: `Cut a task branch FROM the mission integration branch and open the PR from there. Recovery: ${recoveryPath}`,
      }, { status: 400 });
    }

    // ── DERIVE, DON'T ACCEPT (Option A′) ────────────────────────────────────
    // For a task whose mission has an integration base, both the head and the
    // base of its PR are already known to the server — head is the worker's
    // own branch (workers.branch), base is the mission's integration branch —
    // so a caller-supplied value is checked against the derived one rather
    // than trusted. Before this, a caller passing base='dev' silently
    // overrode its own mission's integration base (the production incident
    // this closes: one mission produced six separate trunk merges from task
    // PRs that should all have gone through a single mission PR).
    //
    // Exempt: the mission PR owner (handled above — its head IS the
    // integration branch and its base is trunk, by design) and a genuine
    // stacked-plan phase (`isStackedPhaseBase` — its correct base is a
    // sibling task's own branch, not the integration branch).
    if (integrationBase && !isMissionPrOwner && !isStackedPhase) {
      if (worker.branch && head !== worker.branch) {
        return NextResponse.json({
          error: `Task PR head '${head}' does not match this worker's own branch ('${worker.branch}'). A task PR's head must be the branch this worker actually committed to.`,
          hint: `Open the PR with head='${worker.branch}'.`,
        }, { status: 400 });
      }
      if (typeof base === 'string' && base && base !== integrationBase) {
        const recoveryPath = `1. This mission uses an integration branch — task PRs base on it, not on '${base}'.\n2. Open the PR with base='${integrationBase}' (or omit base and let the server derive it).`;
        return NextResponse.json({
          error: `Task PR base '${base}' disagrees with this mission's integration branch (${integrationBase}). A mission task PR must target the mission's integration branch, not '${base}'.`,
          hint: `Drop the explicit base (the server derives it), or pass base='${integrationBase}'. Recovery: ${recoveryPath}`,
        }, { status: 400 });
      }
    }

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
          base: (integrationBase && !isMissionPrOwner && !isStackedPhase)
            ? integrationBase
            : base
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
        // Base branch SHA at PR open time — used by the base-history-rewrite detector
        ...(typeof prData.base?.sha === 'string' ? { prOpenedBaseSha: prData.base.sha } : {}),
        // Base REF as GitHub resolved it — deliberately GitHub's value, not the
        // `base` we sent, because that input goes through a 7-way fallback below
        // and GitHub is the only authority on where the PR actually points.
        // Decides whether the merge-policy tier applies to this PR (resolvePolicy).
        ...(typeof prData.base?.ref === 'string' && prData.base.ref
          ? { prBaseRef: prData.base.ref }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(workers.id, workerId));

    await claimMissionPrimaryPr(worker.task?.missionId, prData.number, prData.html_url, {
      baseRef: prData.base?.ref ?? null,
      trunk: trunkBranches(workspace.gitConfig, repo.defaultBranch),
    });
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

    // Task PRs based on a mission integration branch have no heartbeat loop to
    // notice them sitting open — request a review now rather than leaving them
    // to age. `missionBaseGuard.enforced` is the same predicate the base checks
    // above already used, so this fires exactly when the derived base is the
    // integration branch.
    if (missionBaseGuard.enforced && !draft && worker.task) {
      await requestIntegrationBranchReview({
        workspace: { id: workspace.id, gitConfig: workspace.gitConfig },
        teamId: account.teamId,
        task: {
          id: worker.task.id,
          title: worker.task.title,
          description: worker.task.description,
          backend: worker.task.backend,
          missionId: worker.task.missionId,
          pathManifest: worker.task.pathManifest as string[] | null,
          requiresReview: worker.task.requiresReview,
        },
        head,
        prNumber: prData.number,
        prUrl: prData.html_url,
        headSha: prData.head?.sha ?? '',
        baseRef: prData.base?.ref ?? integrationBase!,
        installationId: repo.installation.installationId,
        repoFullName: repo.fullName,
      });
    }

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

    // Idempotent: already-merged PR returns success with existing metadata rather
    // than attempting a re-merge (which would fail with 405 "not mergeable").
    // Check BOTH mergedAt and prLifecycleStatus — webhook can set one before the other.
    const alreadyMergedInDb = !!(worker.mergedAt || worker.prLifecycleStatus === 'merged');
    if (alreadyMergedInDb) {
      const dbMergedAtStr = worker.mergedAt instanceof Date
        ? worker.mergedAt.toISOString()
        : (worker.mergedAt ? String(worker.mergedAt) : null);
      let idemMergedAt: string | null = dbMergedAtStr;
      let idemMergedBy: string | null = null;
      let idemMergeCommitSha: string | null = null;
      try {
        const prData = await githubApi(
          repo.installation.installationId,
          `/repos/${repo.fullName}/pulls/${prNumber}`,
        );
        if (prData.merged) {
          idemMergedAt = prData.merged_at ?? idemMergedAt;
          idemMergedBy = prData.merged_by?.login ?? null;
          idemMergeCommitSha = prData.merge_commit_sha ?? null;
        }
      } catch { /* non-fatal — return DB-only metadata */ }
      return NextResponse.json({
        ok: true,
        merged: true,
        message: 'Pull request was already merged',
        alreadyMerged: true,
        pr: {
          number: prNumber,
          url: worker.prUrl ?? null,
          mergedAt: idemMergedAt,
          mergedBy: idemMergedBy,
          mergeCommitSha: idemMergeCommitSha,
        },
      });
    }

    // ── Merge-policy gate ────────────────────────────────────────────────────
    //
    // Until this existed, `merge_pr` was the ONLY route to a merge that
    // evaluated no policy at all: authenticate, check tenancy, merge. Both
    // other routes — auto-merge on green CI, and the reviewer `approve` path —
    // run `evaluateAutoMergeSafety` first. And `merge_pr` sits in
    // `workerActions`, so every worker token can call it. An agent could
    // therefore bypass CI, deny paths, the migration operation-class inspector
    // and the size cap by calling the tool directly, and under `agent-review`
    // it could merge its own PR without a reviewer ever seeing it.
    //
    // The workspace's merge policy tier decides, because the tier already
    // encodes who is allowed to end a PR:
    //
    //   auto-threshold — the platform may merge unattended, so an agent asking
    //                    for the same thing is permitted *if* the same safety
    //                    check passes.
    //   agent-review   — the reviewer's verdict is the gate. A self-merge
    //                    routes around the reviewer entirely, so it is refused
    //                    no matter how green the PR is.
    //   human          — refused, which is what the tier means.
    const force = body.force === true;
    if (force && account.level !== 'admin') {
      return NextResponse.json({
        error: 'force merge requires an admin token',
        hint: '`force` bypasses the workspace merge policy, so it is reserved for a human-held admin token. Drop `force` to merge under policy.',
      }, { status: 403 });
    }

    if (!force) {
      let policyPr: { head?: { sha?: string | null }; base?: { ref?: string | null } } | null = null;
      try {
        policyPr = await githubApi(
          repo.installation.installationId,
          `/repos/${repo.fullName}/pulls/${prNumber}`,
        );
      } catch (err) {
        console.warn(`[merge_pr] Could not read ${repo.fullName}#${prNumber} for policy:`, err);
      }

      const headSha = policyPr?.head?.sha ?? null;
      if (!headSha) {
        // Fail closed. This read is what identifies the commit the policy is
        // evaluated against; merging without it would be a merge with no
        // policy, which is the hole this gate closes.
        return NextResponse.json({
          error: 'could not read the PR head to evaluate merge policy — refusing the merge',
          hint: 'Retry, or have a human merge from the escalation inbox.',
        }, { status: 403 });
      }

      const task = worker.taskId
        ? await db.query.tasks.findFirst({
            where: eq(tasks.id, worker.taskId),
            columns: { id: true, requiresReview: true, missionId: true },
          })
        : null;
      const mission = task?.missionId
        ? await db.query.missions.findFirst({
            where: eq(missions.id, task.missionId),
            columns: RESOLVE_POLICY_MISSION_COLUMNS,
          })
        : null;

      const policy = resolvePolicy(workspace, mission, task, {
        baseRef: policyPr?.base?.ref ?? null,
      });

      if (policy.tier === 'human') {
        return NextResponse.json({
          error: `merge policy tier is 'human' — this PR must be merged by a person`,
          tier: policy.tier,
          hint: 'Report completion and let the owner merge from the escalation inbox.',
        }, { status: 403 });
      }

      if (policy.tier === 'agent-review') {
        // The reviewer's verdict is the gate — but `tryAutoMergeWorkerPr`'s own
        // merge-on-approve is bounded to quarantined branches (see
        // evaluateModelApproveBound), so an ordinary PR based on trunk never
        // auto-merges from that path even once approved. This is the intended
        // recourse: consult the stored verdict rather than refusing on tier
        // alone. A terminal approve whose confidence clears the workspace
        // threshold makes the PR self-mergeable, subject to the SAME safety
        // rails auto-threshold uses below (CI, escalateToPaths as deny paths,
        // the migration operation-class inspector).
        const reviewStatus = await readPrReviewStatus({ workspaceId: workspace.id, prNumber });
        const threshold = policy.agentReview?.maxConfidenceThreshold ?? 0.6;
        const selfMergeable =
          reviewStatus.state === 'approved' &&
          reviewStatus.verdict === 'approve' &&
          typeof reviewStatus.confidence === 'number' &&
          reviewStatus.confidence >= threshold;

        if (!selfMergeable) {
          return NextResponse.json({
            error: `merge policy tier is 'agent-review' — a reviewer decides this PR, so it cannot be self-merged`,
            tier: policy.tier,
            hint: 'Use request_pr_review to dispatch the reviewer, then get_pr_review for the verdict. An approve merges the PR for you when policy permits.',
          }, { status: 403 });
        }
      }

      const safety = await evaluateAutoMergeSafety(
        repo.installation.installationId,
        repo.fullName,
        prNumber,
        headSha,
        policy,
      );
      if (!safety.ok) {
        return NextResponse.json({
          error: `merge policy refused this merge: ${safety.reason}`,
          tier: policy.tier,
          hint: 'Fix the cause and retry, or report completion and let a human merge.',
        }, { status: 403 });
      }
    }

    // ── Mission-PR branch-lifecycle gate (P3) ───────────────────────────────
    // Applies even under `force`: this guards data integrity (deleting the
    // integration branch out from under sibling PRs still targeting it), not
    // the review policy `force` exists to bypass.
    const mergingTask = worker.taskId
      ? await db.query.tasks.findFirst({
          where: eq(tasks.id, worker.taskId),
          columns: { id: true, title: true, taskClass: true, missionId: true },
        })
      : null;
    const mergeGate = await guardMissionPrMerge(mergingTask);
    if (mergeGate.blocks) {
      return NextResponse.json({
        error: `cannot merge the mission PR yet: ${mergeGate.reason}`,
        hint: 'Wait for the remaining task PRs to merge into the integration branch, then retry.',
      }, { status: 409 });
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
      await finalizeMissionPrMerge(mergingTask, repo.installation.installationId, repo.fullName);
    } else if (/resource not accessible by integration/i.test(result.message)) {
      // The GitHub App installation lacks the required permissions.
      // Merging requires pull_requests:write AND contents:write.
      // Closing (close_pr) only needs pull_requests:write, which explains why close
      // succeeds but merge fails on a fresh installation.
      return NextResponse.json({
        error: result.message,
        hint: 'GitHub App merge requires contents:write permission in addition to pull_requests:write. Update the App permissions at github.com/settings/apps and have org admins re-accept.',
      }, { status: 403 });
    } else if (/not mergeable/i.test(result.message)) {
      // "Not mergeable" can mean already merged (race window: merged externally just
      // before this call) OR unresolved conflicts. Verify with GitHub to distinguish.
      try {
        const prCheck = await githubApi(
          repo.installation.installationId,
          `/repos/${repo.fullName}/pulls/${prNumber}`,
        );
        if (prCheck.merged === true) {
          // Merged externally during the race window — stamp DB if not yet set and
          // return idempotent success so the caller can distinguish this from a real failure.
          if (!worker.mergedAt) {
            await db
              .update(workers)
              .set({ mergedAt: new Date(), prLifecycleStatus: 'merged', updatedAt: new Date() })
              .where(eq(workers.id, worker.id));
          }
          return NextResponse.json({
            ok: true,
            merged: true,
            message: 'Pull request was already merged',
            alreadyMerged: true,
            pr: {
              number: prNumber,
              url: worker.prUrl ?? null,
              mergedAt: prCheck.merged_at ?? null,
              mergedBy: prCheck.merged_by?.login ?? null,
              mergeCommitSha: prCheck.merge_commit_sha ?? null,
            },
          });
        }
      } catch { /* non-fatal — fall through to conflict classification */ }
    }
    if (classifyMergeFailure(result.message) === 'conflict' && worker.taskId) {
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
        if (dispatchResult.superseded) {
          // escalateSupersession already fired inside dispatchConflictRetry
        } else if (dispatchResult.exhausted && worker.taskId) {
          await escalateConflictExhaustion(worker.taskId, repo.fullName, prNumber, headSha);
        }
        const message = dispatchResult.dispatched
          ? `PR #${prNumber} has merge conflicts. Conflict-resolution task dispatched (${dispatchResult.taskId}).`
          : dispatchResult.superseded
          ? `PR #${prNumber} appears superseded — its changes are already in base. Escalated for human review.`
          : dispatchResult.exhausted
          ? `PR #${prNumber} has merge conflicts and conflict-resolution retries are exhausted. Human action required.`
          : result.message;
        return NextResponse.json({
          ok: false,
          merged: false,
          message,
          conflictRetryDispatched: dispatchResult.dispatched,
          conflictSuperseded: dispatchResult.superseded,
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

    // Determine canonical state — GitHub is authoritative for merge detection;
    // DB fills the gap when prLifecycleStatus='merged' but mergedAt raced to null.
    const githubMerged = pr.merged === true;
    const githubClosed = pr.state === 'closed';
    const dbMerged = !!(worker.mergedAt || worker.prLifecycleStatus === 'merged');
    let canonicalState: 'open' | 'merged' | 'closed_unmerged';
    if (githubMerged || (dbMerged && githubClosed)) {
      canonicalState = 'merged';
    } else if (githubClosed) {
      canonicalState = 'closed_unmerged';
    } else {
      canonicalState = 'open';
    }

    const dbMergedAt = worker.mergedAt
      ? (worker.mergedAt instanceof Date ? worker.mergedAt.toISOString() : String(worker.mergedAt))
      : null;

    return NextResponse.json({
      ok: true,
      pr: {
        number: prNumber,
        title: pr.title ?? null,
        body: pr.body ?? null,
        state: canonicalState,
        url: pr.html_url ?? worker.prUrl ?? null,
        mergeable: canonicalState === 'open' ? (pr.mergeable ?? null) : null,
        mergeableState: canonicalState === 'open' ? (pr.mergeable_state ?? null) : null,
        headSha: headSha ?? worker.lastCommitSha ?? null,
        baseRef: pr.base?.ref ?? null,
        additions: pr.additions ?? null,
        deletions: pr.deletions ?? null,
        changedFiles: pr.changed_files ?? null,
        mergedAt: canonicalState === 'merged' ? (pr.merged_at ?? dbMergedAt) : null,
        mergeCommitSha: canonicalState === 'merged' ? (pr.merge_commit_sha ?? null) : null,
        mergedBy: canonicalState === 'merged' ? (pr.merged_by?.login ?? null) : null,
        mergedVia: canonicalState === 'merged' ? 'unknown' : null,
        closedAt: canonicalState === 'closed_unmerged' ? (pr.closed_at ?? null) : null,
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
