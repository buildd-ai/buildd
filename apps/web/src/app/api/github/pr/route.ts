import { hasTokenRouteAdminAccess } from '@/lib/token-route-policy';
import { reconcileSubjectEvent } from '@/lib/supersession';
import { NextRequest, NextResponse } from 'next/server';
import { failedChecks } from '@/lib/failed-checks';
import { db } from '@buildd/core/db';
import { workers, githubRepos, missions, tasks, workspaces, type WorkspaceGitConfig } from '@buildd/core/db/schema';
import { eq, and, ne, isNull, isNotNull, inArray } from 'drizzle-orm';
import { githubApi, githubAppBotLogin, mergePullRequest } from '@/lib/github';
import { rankPrComments } from '@/lib/pr-comments';
// One implementation of the primary-PR claim and of "what counts as trunk",
// shared with the mission-PR opener. Two copies of a base-ref rule is how
// the branch-name generator drifted (P8).
import { claimMissionPrimaryPr, trunkBranches, MISSION_PR_TASK_PREFIX, guardMissionPrMerge, finalizeMissionPrMerge } from '@/lib/mission-pr';
import { buildMissionBaseGuard } from '@/lib/mission-base-guard';
import { ensureIntegrationBaseForTaskPr, reportMissionBranchUnresolved } from '@/lib/mission-integration-branch';
import { looksLikeMissionIntegrationBranch, resolveTaskPrBase } from '@buildd/core/mission-integration';
import { composeBodyWithLede, deriveLedeFromTitle, normalizeLede } from '@buildd/core/pr-lede';
import { describeProseFindings, scanPrProse } from '@buildd/core/no-prod-data-prose';
import { authenticateApiKey } from '@/lib/api-auth';
import { authenticateTaskScopedCaller, taskScopeAllowsWorkerPr, taskScopeAllowsWorkspace } from '@/lib/task-token-auth';
import { agentRunMayActOnPr, authorizeWorkerPrCapability } from '@/lib/agent-capabilities/worker-pr';
import { ownershipApplies, verifyPrOwnership, type PrOwnershipVerdict, type InteractiveHeadHolder } from '@/lib/agent-capabilities/pr-ownership';
import { INTERACTIVE_RUNNER } from '@/lib/interactive-session';
import { repoProtectedBranches } from '@/lib/agent-capabilities/github';
import { recordCapabilityDecision } from '@/lib/agent-capabilities/audit';
import { getTeamWorkspaceIds, verifyAccountWorkspaceAccess, verifyWorkspaceAccess } from '@/lib/team-access';
// GET only: the dashboard session (in-app chat reads PRs as the signed-in user).
import { getCurrentUser } from '@/lib/auth-helpers';
import { resolveSessionTeamIds, workspaceIdsForTeams } from '@/lib/session-team-scope';
import { resolveWorkerByPrNumberInWorkspaces } from '@/lib/pr-resolve';
import { supersedeAncestorEscalations } from '@/lib/escalation-supersession';
import {
  recordChangeIntents,
  findConflictingIntents,
  postConflictWarnings,
} from '@/lib/change-intent';
import { checkSurfaceOrder, mergeInSurfaceSlot } from '@/lib/surface-ordering-door';
import { resolveIntentSurfaces } from '@/lib/surface-ordering-config';
import { classifyMergeFailure, dispatchConflictRetry } from '@/lib/conflict-retry';
import { recordPrFact } from '@buildd/core/pr-facts';
import { escalateConflictExhaustion, evaluateAutoMergeSafety, isBehindBaseRefusal } from '@/lib/auto-merge';
import { refreshBehindPr, type RefreshOutcome } from '@/lib/base-refresh';
import { updateBehindPrBranch } from '@/lib/pr-branch-update';
import { resolveSemanticRefreshMode } from '@/lib/semantic-refresh';
import { dependencyBotPushRefusal, isDependencyBotPrContext } from '@/lib/dependency-bot-pr';
import { fetchSplitPrStats } from '@/lib/supersession-check';
import { loadPrAttempts } from '@/lib/pr-attempts';
import { resolvePolicy, RESOLVE_POLICY_MISSION_COLUMNS } from '@/lib/merge-policy';
import { openKernelDelivery } from '@/lib/workflow/seam';
import { readPrReviewStatus, listWorkspaceRoles } from '@/lib/pr-review-request';
import { isApprovalSelfMergeable } from '@/lib/pr-review-status';
import { guardReviewVerdict } from '@/lib/review-verdict-gate';
import { landPr, resolveLandingMode, type LandingOutcome } from '@/lib/pr-landing';
import { createReviewerTask, findLiveReviewerTaskForHead } from '@/lib/reviewer';
import { stampTaskKindIfAbsent } from '@/lib/task-kind';
import { announceTaskCreated, wakeTask } from '@/lib/dispatch-authority';
import { appendPrActivity } from '@/lib/pr-activity-comment';
import { pickReviewerRole } from '@/lib/pr-review-status';
// One resolver for "which worker owns PR #N", shared with the `explain` MCP read.
import { resolveWorkerByPrNumber } from '@/lib/pr-resolve';
import { GATE_SLUGS, fireGateEvent } from '@/lib/gate-ledger';
import { closeAncestorRetryPrs, collectRetryLineage, resolveSupersessionCause, type SupersededPr } from '@/lib/retry-pr-supersession';
import { ATTEMPT_FOOTER_PATTERN, checkFreshRetryPr, freshRetryPrRefusal, retryAttemptFooter } from '@/lib/retry-fresh-pr-gate';
import { loadInlineEvidence } from '@/lib/evidence-inline';
import { canActOnWorkerPr } from '@/lib/worker-pr-access';
import { isTerminalPrLifecycle } from '@/lib/dep-gate-contract';


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

    // The workflow kernel owns the review loop of a PR whose first review is
    // dispatched from now on: it queues round 1 when the owner attempt ends.
    const kernel = await openKernelDelivery({
      workspaceId: params.workspace.id,
      ownerTaskId: params.task.id,
      repoFullName: params.repoFullName,
      prNumber: params.prNumber,
      installationId: params.installationId,
      source: 'create_pr',
    }).catch((err) => {
      console.error(`[create_pr] workflow kernel could not open a delivery for PR #${params.prNumber}; legacy review dispatch:`, err);
      return { owned: false };
    });
    if (kernel.owned) return;

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
      confidenceThreshold: policy.agentReview?.maxConfidenceThreshold,
      installationId: params.installationId,
      repoFullName: params.repoFullName,
      // The caller already has the PR base; saves the reviewer context a PR read.
      baseRef: params.baseRef,
    });

    if (reviewerTask?.id && !reviewerTask.deduplicated) {
      await announceTaskCreated(
        {
          id: reviewerTask.id,
          title: `Review PR #${params.prNumber}: ${params.task.title}`,
          description: null,
          workspaceId: params.workspace.id,
          missionId: params.task.missionId,
          backend: params.task.backend,
          roleSlug: picked.role,
        },
        params.workspace as never,
      );
      await wakeTask(reviewerTask.id, 'task.created');

      await appendPrActivity({
        installationId: params.installationId,
        repoFullName: params.repoFullName,
        prNumber: params.prNumber,
        entry: { kind: 'review_queued' },
        workspaceId: params.workspace.id,
      }).catch(() => {});
    }
  } catch (err) {
    console.error(`[create_pr] auto-review request failed (non-fatal) for PR #${params.prNumber}:`, err);
  }
}

// A stored prUrl/prNumber stops being a truthful answer to "does this worker
// have an open PR" the moment the PR merges or closes — the webhook records
// that on `mergedAt`/`prLifecycleStatus`, but nothing previously consulted it
// before the fast dedup paths below echoed the stored PR back as 'open'. Used
// to gate both: a worker's own stored PR, and a sibling worker's on the same
// task.
function isStoredPrStale(pr: { mergedAt?: Date | string | null; prLifecycleStatus?: string | null } | null | undefined): boolean {
  if (!pr) return false;
  return !!pr.mergedAt || isTerminalPrLifecycle(pr.prLifecycleStatus);
}

/**
 * An agent run tried to record a PR its task does not own
 * (lib/agent-capabilities/pr-ownership.ts). One ledger row per refusal, so
 * "why was this refused" and "how often" both have an answer.
 */
/** How the caller relates to the worker, for the capability audit row. */
function auditVia(account: { id: string; taskScope?: unknown }, worker: { accountId?: string | null }) {
  if (account.taskScope) return 'task_token' as const;
  return worker.accountId === account.id ? 'worker_account' as const : null;
}

function refusePrOwnership(
  worker: { id: string; workspaceId: string | null; taskId: string | null; branch: string | null; accountId?: string | null; task?: { missionId?: string | null } | null },
  verdict: Extract<PrOwnershipVerdict, { owned: false }> | { owned: false; reasonCode: 'pr_outside_linked_repo'; error: string },
  capability: 'pr.create' | 'pr.adopt' = 'pr.create',
) {
  void recordCapabilityDecision({
    capability, decision: 'refused', workspaceId: worker.workspaceId, taskId: worker.taskId, workerId: worker.id,
    accountId: worker.accountId ?? null, principalVia: 'worker_account', reasonCode: verdict.reasonCode,
  });
  fireGateEvent({
    gate: GATE_SLUGS.PR_OWNERSHIP,
    surface: 'POST /api/github/pr',
    outcome: 'rejected',
    reason: verdict.reasonCode,
    workspaceId: worker.workspaceId,
    missionId: worker.task?.missionId ?? null,
    taskId: worker.taskId,
    workerId: worker.id,
    callerOrigin: 'worker',
  });
  return NextResponse.json(
    { error: verdict.error, code: verdict.reasonCode, ...(worker.branch ? { hint: `Open the PR with head='${worker.branch}'.` } : {}) },
    { status: 403 },
  );
}

/**
 * Other workers (any task) already recorded on `head` in this workspace —
 * the DB half of the `interactive_head` ownership basis (pr-ownership.ts).
 * Only called for a verified interactive worker, since it is the only caller
 * that basis ever applies to.
 */
async function fetchOtherHeadHolders(workspaceId: string, selfWorkerId: string, head: string): Promise<InteractiveHeadHolder[]> {
  const rows = await db.query.workers.findMany({
    where: and(eq(workers.branch, head), eq(workers.workspaceId, workspaceId), ne(workers.id, selfWorkerId)),
    columns: { id: true, taskId: true, status: true, prUrl: true },
  });
  return rows.map(r => ({ workerId: r.id, taskId: r.taskId, status: r.status, hasPr: r.prUrl != null }));
}

// POST /api/github/pr - Create a pull request
export async function POST(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;

  // A per-task token (cloud container) may open a PR only for its own worker.
  const account = await authenticateTaskScopedCaller(apiKey, req);
  if (!account) {
    return NextResponse.json({ error: 'Invalid API key' }, { status: 401 });
  }

  try {
    const body = await req.json();
    const {
      workerId,
      title,
      body: prBody,
      lede,
      ledeDerived,
      head,
      base,
      draft,
      prUrl: existingPrUrl,
    } = body;

    if (!workerId) {
      return NextResponse.json({ error: 'workerId required' }, { status: 400 });
    }

    if (!title || !head) {
      return NextResponse.json({ error: 'title and head branch required' }, { status: 400 });
    }

    // Computed early (not just at fresh-PR composition time, below) so the
    // dedup-adoption path can also compose a fresh body from caller-supplied
    // content, instead of only ever carrying forward whatever is already
    // stored on GitHub.
    const suppliedLede = normalizeLede(lede);
    const effectiveLede = suppliedLede || deriveLedeFromTitle(String(title));
    const ledeIsDerived = !suppliedLede || ledeDerived === true;

    // Get the worker with its workspace and task
    const worker = await db.query.workers.findFirst({
      where: eq(workers.id, workerId),
      with: { workspace: true, task: true },
    });

    if (!worker) {
      return NextResponse.json({ error: 'Worker not found' }, { status: 404 });
    }

    // workers.runner is client-supplied at claim time, but this value is only
    // ever reached here as 'mcp' after interactive-session.ts's HMAC check
    // passed at claim — an UNVERIFIED claim is stamped 'mcp-unverified'
    // instead and never qualifies. Gates the interactive_head ownership
    // basis below: only a session buildd itself proved was interactive may
    // open a PR from a head that is not its own derived branch.
    const isInteractiveWorker = worker.runner === INTERACTIVE_RUNNER;

    // Team membership OR being the account that runs the worker (see
    // canActOnWorkerPr), and a per-task token only for its own worker. Runs
    // before anything below reads GitHub, creates a ref or records a PR.
    const prAccess = await authorizeWorkerPrCapability(account, worker, existingPrUrl ? 'pr.adopt' : 'pr.create');
    if (!prAccess.allowed) {
      return NextResponse.json({ error: prAccess.error }, { status: prAccess.status });
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
          // Superset of what the base guard needs: the merge-policy columns let
          // the response's `autoMergeEnabled` come from resolvePolicy below.
          columns: RESOLVE_POLICY_MISSION_COLUMNS,
        })
      : null;
    // The same guard object every other door uses (completion auto-detect,
    // webhook retarget), so a base this route refuses cannot be acquired by
    // walking in through one of them instead.
    const missionBaseGuard = buildMissionBaseGuard({ mission, task: worker.task, head });
    const integrationBase = missionBaseGuard.integrationBase;
    const isMissionPrOwner = missionBaseGuard.isMissionPrOwner;
    const taskContext = worker.task?.context as Record<string, unknown> | null;
    const isStackedPhase = missionBaseGuard.isStackedPhase;

    // §6.10 tier 1 (S31): a workspace that opts in has the body and title it is
    // about to open scanned with CI's own prose rule, and a body CI would fail
    // is refused here with the reason instead of after a red check. Only a PR
    // buildd opens: an adopted one already exists, and CI will scan it anyway.
    if (!existingPrUrl) {
      const preflight = (worker.workspace?.gitConfig as WorkspaceGitConfig | null)?.preflight;
      if (preflight?.prProseScan) {
        const composed = composeBodyWithLede(effectiveLede, prBody, { derived: ledeIsDerived });
        const scan = scanPrProse({ title: String(title), body: composed });
        if (scan.findings.length > 0) {
          return NextResponse.json({
            error: `PR not opened: ${describeProseFindings(scan.findings)}`,
            code: 'preflight_failed',
            preflight: { check: 'no_prod_data_prose', findings: scan.findings },
          }, { status: 400 });
        }
      }
    }

    // If an existing PR URL is provided, register it directly without going through GitHub API.
    // This allows agents to satisfy pr_required even when the workspace has no GitHub App installation
    // (e.g. the PR was created via gh CLI in a different repo).
    //
    // LEDE ON THIS PATH: the PR body belongs to whoever opened it — buildd did
    // not write it and, on the case this path exists for, has no installation
    // with which to rewrite it. So nothing is prepended to GitHub here. The
    // deterministic title-derived lede (see `deriveLedeFromTitle`, applied in
    // the `create_pr` action) leads the record buildd stores instead, and the
    // adoption itself never fails for want of a lede.
    if (existingPrUrl) {
      // Only short-circuit when the caller is re-asserting the SAME PR already
      // recorded on this worker — a true idempotent retry. A caller passing a
      // DIFFERENT prUrl is explicitly overriding the stored value (e.g. the
      // worker's stored PR was wrong, or came from an earlier misdirected
      // call), and blindly returning the stale stored PR here silently drops
      // the caller's correction: `create_pr` would report success while
      // pointing at a PR the caller never asked for. Fall through so the new
      // URL goes through the same legality checks and gets recorded below.
      if (worker.prUrl && worker.prNumber && worker.prUrl === existingPrUrl) {
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
      // Same escape hatch as the fresh-create path below (PART 2): a
      // multi-repo mission's integration branch may be real in the mission's
      // home repo and absent from THIS task's own repo, in which case
      // refusing an adopted PR for disagreeing with it would refuse the only
      // base that can actually exist here.
      let adoptionIntegrationBaseMissing = false;
      // An agent run may adopt only a PR its task owns, in the workspace's own
      // repo. With an App installation the head comes from GitHub, not the
      // caller; without one the caller's `head` is all there is.
      if (ownershipApplies(prAccess.actor, account)) {
        const ownRepo = worker.workspace?.githubRepoId
          ? await db.query.githubRepos.findFirst({
              where: eq(githubRepos.id, worker.workspace.githubRepoId),
              with: { installation: true },
            })
          : undefined;
        let observedHead: string = head;
        if (ownRepo?.installation) {
          if (!prNumber || !existingPrUrl.toLowerCase().includes(`/${ownRepo.fullName.toLowerCase()}/pull/`)) {
            return refusePrOwnership(worker, {
              owned: false,
              reasonCode: 'pr_outside_linked_repo',
              error: `Refusing to record ${existingPrUrl}: it is not a pull request in this workspace's repository (${ownRepo.fullName}).`,
            }, 'pr.adopt');
          }
          if (!realPr) {
            try {
              realPr = await githubApi(ownRepo.installation.installationId, `/repos/${ownRepo.fullName}/pulls/${prNumber}`);
            } catch {
              // Unreadable — the caller's head stands in, as it does without an App.
              realPr = null;
            }
          }
          const ref = (realPr as { head?: { ref?: unknown } } | null)?.head?.ref;
          if (typeof ref === 'string' && ref) observedHead = ref;
        }
        const ownership = await verifyPrOwnership({
          head: observedHead,
          prNumber,
          workerBranch: worker.branch,
          task: worker.task,
          protectedBranches: repoProtectedBranches(worker.workspace ?? {}, ownRepo?.defaultBranch),
          interactiveWorker: isInteractiveWorker,
          otherHeadHolders: isInteractiveWorker ? await fetchOtherHeadHolders(worker.workspaceId, worker.id, observedHead) : undefined,
        }, collectRetryLineage);
        if (!ownership.owned) return refusePrOwnership(worker, ownership, 'pr.adopt');
        // Record what was actually adopted: later lookups (get_pr, merge_pr,
        // CI attribution) key off workers.branch, and the generated name
        // claim_task handed this worker was never the real one.
        if (ownership.basis === 'interactive_head' && worker.branch !== observedHead) {
          await db.update(workers).set({ branch: observedHead, updatedAt: new Date() }).where(eq(workers.id, workerId));
          worker.branch = observedHead;
        }
      }
      if (missionBaseGuard.enforced && worker.task?.missionId && integrationBase) {
        const ready = await ensureIntegrationBaseForTaskPr({
          missionId: worker.task.missionId,
          integrationBase,
          taskTitle: worker.task.title,
          fallbackBase: worker.workspace?.gitConfig?.targetBranch || worker.workspace?.gitConfig?.defaultBranch || null,
          workspaceId: worker.workspaceId,
          taskId: worker.taskId,
          workerId: worker.id,
        });
        adoptionIntegrationBaseMissing = !ready.usable;
      }
      if (missionBaseGuard.enforced && !adoptionIntegrationBaseMissing) {
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
              // Already read by the ownership check above when an agent run adopts.
              realPr = realPr ?? await githubApi(
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
      void recordCapabilityDecision({
        capability: 'pr.adopt', decision: 'allowed', workspaceId: worker.workspaceId, taskId: worker.taskId, workerId: worker.id,
        accountId: account.id, principalVia: auditVia(account, worker), resource: prNumber ? `pr:${prNumber}` : null,
        sideEffect: prNumber ? { prNumber } : null,
      });
      await db.update(workers).set({
        prUrl: existingPrUrl,
        prNumber,
        updatedAt: new Date(),
      }).where(eq(workers.id, workerId));
      await stampTaskKindIfAbsent(worker.taskId, 'engineering');
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
    // Only for the SAME head: a task that legitimately ships a second PR from a
    // different branch (e.g. a change to a different base) must not be handed
    // the first PR back as if it were the new one. A sibling whose branch is
    // unrecorded falls through to the head-based GitHub lookup below, which is
    // authoritative either way.
    if (worker.taskId) {
      const siblingWorkerWithPr = await db.query.workers.findFirst({
        where: and(
          eq(workers.taskId, worker.taskId),
          isNotNull(workers.prUrl),
          isNotNull(workers.prNumber),
        ),
        columns: { prUrl: true, prNumber: true, id: true, branch: true, prBaseRef: true, mergedAt: true, prLifecycleStatus: true },
      });
      if (
        siblingWorkerWithPr?.prUrl &&
        siblingWorkerWithPr.prNumber &&
        siblingWorkerWithPr.branch === head &&
        !isStoredPrStale(siblingWorkerWithPr)
      ) {
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

    // Dedup: if worker already has a PR for THIS head branch, and it isn't
    // already known merged/closed, return the existing one. A worker that
    // moves on to a NEW branch after its earlier PR merged still carries that
    // PR's prUrl/prNumber on the row — echoing it back as 'open' here would
    // both misreport the old PR's real state and silently drop the caller's
    // request to open a PR for the new head. Falling through re-runs the
    // head-based GitHub lookup below, which finds nothing for a genuinely new
    // head and proceeds to open a fresh PR.
    if (
      worker.prUrl &&
      worker.prNumber &&
      (!worker.branch || worker.branch === head) &&
      !isStoredPrStale(worker)
    ) {
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

    // An agent run opens or adopts a PR only from a head its task owns. The
    // PR number is not known yet; dedup below re-asks with it, in case the
    // task names the PR it found.
    const ownershipApplied = ownershipApplies(prAccess.actor, account);
    const ownershipInput = ownershipApplied
      ? {
          workerBranch: worker.branch,
          task: worker.task,
          protectedBranches: repoProtectedBranches(workspace, repo.defaultBranch),
          interactiveWorker: isInteractiveWorker,
          otherHeadHolders: isInteractiveWorker ? await fetchOtherHeadHolders(worker.workspaceId, worker.id, head) : undefined,
        }
      : null;
    const headOwnership = ownershipInput
      ? await verifyPrOwnership({ ...ownershipInput, head, prNumber: null }, collectRetryLineage)
      : null;

    // Record what was actually pushed: later lookups (get_pr, merge_pr, CI
    // attribution, and the DERIVE-DON'T-ACCEPT mission-base check just below)
    // all key off workers.branch, and the generated name claim_task handed
    // this worker was never the real one.
    if (headOwnership && headOwnership.owned && headOwnership.basis === 'interactive_head' && worker.branch !== head) {
      await db.update(workers).set({ branch: head, updatedAt: new Date() }).where(eq(workers.id, workerId));
      worker.branch = head;
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
        if (ownershipInput && headOwnership && !headOwnership.owned) {
          const named = await verifyPrOwnership({ ...ownershipInput, head, prNumber: existing.number }, collectRetryLineage);
          if (!named.owned) return refusePrOwnership(worker, named);
        }

        // Diff stats excluding generated paths (e.g. Drizzle snapshots) — a
        // migration snapshot must not inflate the number shown on task/PR cards.
        const dedupSplit = typeof prDetail.additions === 'number'
          ? await fetchSplitPrStats(repo.installation.installationId, repo.fullName, existing.number)
          : null;

        // Update worker with the existing PR info and diff stats
        await db
          .update(workers)
          .set({
            prUrl: existing.html_url,
            prNumber: existing.number,
            ...(dedupSplit ? { linesAdded: dedupSplit.reviewable.additions } : {}),
            ...(dedupSplit ? { linesRemoved: dedupSplit.reviewable.deletions } : {}),
            ...(dedupSplit ? { filesChanged: dedupSplit.reviewable.files } : {}),
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
        await stampTaskKindIfAbsent(worker.taskId, 'engineering');

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
        // visible on the PR itself (not just the reviewer task), and — when
        // the caller supplied fresh content this call — replace the stale
        // body with it instead of only ever appending a footer line underneath
        // it. A retry's whole point is often new verification evidence
        // (screenshots, notes); silently carrying forward the previous
        // attempt's body would bury that evidence under one footer line,
        // with no way to get it onto the PR short of a direct GitHub edit
        // this role does not have.
        const suppliedFreshBody = typeof prBody === 'string' && prBody.trim().length > 0;
        if (retryIteration > 0 || suppliedFreshBody) {
          try {
            const currentBody: string = prDetail.body ?? existing.body ?? '';
            let updatedBody = suppliedFreshBody
              ? composeBodyWithLede(effectiveLede, prBody, { derived: ledeIsDerived })
              : currentBody;
            if (retryIteration > 0) {
              // This PR was adopted, i.e. updated in place — say so, not that a
              // resume failed.
              const attemptLine = retryAttemptFooter({ attempt: retryIteration + 1, maxIterations, decision: 'updated' });
              // Replace an existing attempt line or append a new one.
              updatedBody = ATTEMPT_FOOTER_PATTERN.test(updatedBody)
                ? updatedBody.replace(ATTEMPT_FOOTER_PATTERN, attemptLine)
                : `${updatedBody}\n\n---\n${attemptLine}`;
            }
            if (updatedBody !== currentBody) {
              await githubApi(
                repo.installation.installationId,
                `/repos/${repo.fullName}/pulls/${existing.number}`,
                { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body: updatedBody }) },
              );
            }
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

    if (headOwnership && !headOwnership.owned) return refusePrOwnership(worker, headOwnership);

    // A retry bound to a still-open PR updates that PR. A fresh PR from it is
    // the exceptional fallback — only when the two heads have diverged — and
    // every one let through records why (lib/retry-fresh-pr-gate.ts). The
    // ancestor close further down stays as the backstop.
    const freshPr = await checkFreshRetryPr({
      installationId: repo.installation.installationId,
      repoFullName: repo.fullName,
      task: worker.task,
      head,
      // The runner's own record of why it did not resume: a diverged head is
      // let through only with one (missing/diverged).
      resolveResumeCause: () => resolveSupersessionCause(worker.id),
    });
    if (freshPr.action === 'refuse') {
      const { error, hint } = freshRetryPrRefusal(freshPr, head);
      fireGateEvent({
        gate: GATE_SLUGS.RETRY_PR_SUPERSESSION,
        surface: 'POST /api/github/pr',
        outcome: 'rejected',
        reason: 'fresh retry PR refused: its subject PR is open and can carry the work',
        workspaceId: worker.workspaceId,
        missionId: worker.task?.missionId ?? null,
        taskId: worker.taskId,
        workerId: worker.id,
        detail: { subjectPrNumber: freshPr.subjectPrNumber, compareStatus: freshPr.compareStatus, resumeCause: freshPr.resumeCause ?? null, head },
        callerOrigin: 'worker',
      });
      return NextResponse.json({ error, hint, subjectPr: { number: freshPr.subjectPrNumber, url: freshPr.subjectUrl } }, { status: 409 });
    }
    if (freshPr.action === 'allow_fresh') {
      fireGateEvent({
        gate: GATE_SLUGS.RETRY_PR_SUPERSESSION,
        surface: 'POST /api/github/pr',
        outcome: 'warned',
        reason: `retry opened a fresh PR while its subject PR was open: ${freshPr.reason}`,
        workspaceId: worker.workspaceId,
        missionId: worker.task?.missionId ?? null,
        taskId: worker.taskId,
        workerId: worker.id,
        detail: { subjectPrNumber: freshPr.subjectPrNumber, compareStatus: freshPr.compareStatus, freshPrReason: freshPr.reason, resumeCause: freshPr.resumeCause ?? null, head },
        callerOrigin: 'worker',
      });
    }

    // Stamp retry lineage into the PR body when a retry opens a fresh PR, with
    // the reason the gate above let it through — never a cause nobody observed.
    // Lets humans disambiguate duplicate-looking PRs without reading the diff.
    const lineageSuffix = retryIteration > 0
      ? `\n\n---\n${retryAttemptFooter({ attempt: retryIteration, maxIterations, decision: freshPr })}`
      : '';

    // ── The lede leads ───────────────────────────────────────────────────────
    // Composed into the body here rather than stored in a column of its own, so
    // every reader of the body — GitHub, `get_pr`, the `pr` knowledge corpus —
    // gets the lede first without having to know it exists. See
    // packages/core/pr-lede.ts for the full reasoning.
    //
    // `lede` is required on the agent-facing `create_pr` action, which rejects
    // its absence before this route is ever called. Absence HERE therefore means
    // a non-agent caller, and the answer is the same deterministic title-derived
    // fallback the adoption path uses — never a refusal. Nothing in this feature
    // may fail a PR over its prose, and a PR that reaches this line has already
    // been built, committed and pushed.
    // (suppliedLede/effectiveLede/ledeIsDerived computed earlier — see above.)
    if (!suppliedLede) {
      console.warn(
        `[create_pr] no lede supplied for worker ${workerId} — deriving one from the PR title`,
      );
    }
    const effectivePrBody = composeBodyWithLede(
      effectiveLede,
      (prBody || `Created by buildd worker ${worker.name}`) + lineageSuffix,
      { derived: ledeIsDerived },
    );

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

    // ── PART 2: the integration branch may already be GONE ──────────────────
    //
    // A merging mission PR deletes the integration branch by design
    // (`finalizeMissionPrMerge`). A task of that mission claimed afterwards
    // derives a base that does not exist, and both doors are then shut: this
    // route refuses trunk because the mission HAS an integration base, and
    // GitHub refuses the derived base with a 422 because it is not there. No
    // route out from inside a worker. `guardMissionPrMerge` stops new
    // instances; this is for the missions already in that state.
    //
    // `ensureIntegrationBaseForTaskPr` re-cuts the branch from trunk and
    // records the decision as a mission note, falling back to trunk (also
    // noted) only when it cannot. Existence is read LIVE from GitHub, never
    // from a remote-tracking ref. See that function for why re-cutting is the
    // right answer rather than a trunk fallback.
    let integrationBaseMissing = false;
    if (missionBaseGuard.enforced && worker.task?.missionId && integrationBase) {
      const ready = await ensureIntegrationBaseForTaskPr({
        missionId: worker.task.missionId,
        integrationBase,
        taskTitle: worker.task.title,
        fallbackBase:
          workspace.gitConfig?.targetBranch
          || workspace.gitConfig?.defaultBranch
          || repo.defaultBranch
          || null,
        // The mission may have no workspace of its own; the task always does.
        workspaceId: worker.workspaceId,
        taskId: worker.taskId,
        workerId: worker.id,
      });
      integrationBaseMissing = !ready.usable;
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
        const error = `Task PR head '${head}' does not match this worker's own branch ('${worker.branch}'). A task PR's head must be the branch this worker actually committed to.`;
        // The embedded branch names are exactly what normalizeErrorSignature
        // collapses, so four workers hitting this refusal land on one row
        // instead of four singletons nobody can count.
        fireGateEvent({
          gate: GATE_SLUGS.PR_HEAD_MISMATCH,
          surface: 'POST /api/github/pr',
          outcome: 'rejected',
          reason: error,
          workspaceId: worker.workspaceId,
          missionId: worker.task?.missionId ?? null,
          taskId: worker.taskId,
          workerId: worker.id,
          callerOrigin: 'worker',
        });
        return NextResponse.json({ error, hint: `Open the PR with head='${worker.branch}'.` }, { status: 400 });
      }
      // Skipped when the integration branch is gone: refusing the caller's
      // base there would refuse the only base that can still work.
      if (!integrationBaseMissing && typeof base === 'string' && base && base !== integrationBase) {
        const recoveryPath = `1. This mission uses an integration branch — task PRs base on it, not on '${base}'.\n2. Open the PR with base='${integrationBase}' (or omit base and let the server derive it).`;
        const error = `Task PR base '${base}' disagrees with this mission's integration branch (${integrationBase}). A mission task PR must target the mission's integration branch, not '${base}'.`;
        fireGateEvent({
          gate: GATE_SLUGS.PR_BASE_MISMATCH,
          surface: 'POST /api/github/pr',
          outcome: 'rejected',
          reason: error,
          workspaceId: worker.workspaceId,
          missionId: worker.task?.missionId ?? null,
          taskId: worker.taskId,
          workerId: worker.id,
          callerOrigin: 'worker',
        });
        return NextResponse.json({
          error,
          hint: `Drop the explicit base (the server derives it), or pass base='${integrationBase}'. Recovery: ${recoveryPath}`,
        }, { status: 400 });
      }
    }

    // THE one answer to "what base does this task's PR take" — the same
    // function the runner's Git Workflow prompt block calls, so the instruction
    // the worker read and the base this route opens against cannot disagree.
    // They did: the prompt said trunk (it never looked at the mission) while
    // this route refused trunk, and the worker had no way to tell which side
    // was wrong.
    const prBase = resolveTaskPrBase({
      mission,
      task: worker.task,
      head,
      callerBase: typeof base === 'string' ? base : null,
      fallbacks: [
        // Stacked plan phases store a predecessor branch in context.baseBranch,
        // and recovery tasks store the current head there — resolveTaskPrBase
        // tells those apart; see its doc comment.
        taskContext?.targetBranch as string | undefined,
        workspace.gitConfig?.targetBranch,
        workspace.gitConfig?.defaultBranch,
        repo.defaultBranch,
        'main',
      ],
      integrationBaseMissing,
    });

    // Create the PR via GitHub API
    const effectiveBase = prBase.base ?? 'main';
    let prData: any;
    try {
      prData = await githubApi(
        repo.installation.installationId,
        `/repos/${repo.fullName}/pulls`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title,
            body: effectivePrBody,
            head,
            base: effectiveBase,
            draft: draft || false,
          }),
        }
      );
    } catch (err) {
      // GitHub's answer to a base ref that does not exist is a bare
      // `422 {field: base, code: invalid}`, which used to surface as a 500
      // that never said "branch does not exist". Reachable when the base came
      // from a stale `context.baseBranch` (e.g. a mission integration branch
      // that was never created, on a task whose own missionId is unset so the
      // integration guard above never ran) rather than from the guard.
      const message = err instanceof Error ? err.message : String(err);
      if (/GitHub API error: 422/.test(message) && /"field":"base"/.test(message)) {
        if (looksLikeMissionIntegrationBranch(effectiveBase)) {
          await reportMissionBranchUnresolved({
            missionId: worker.task?.missionId ?? null,
            branch: effectiveBase,
            where: 'create_pr',
            surface: 'POST /api/github/pr',
            cause: 'missing',
            fallback: 'none',
            detail: `base resolved from ${prBase.source}`,
            workspaceId: worker.workspaceId,
            taskId: worker.taskId,
            workerId: worker.id,
          });
        }
        const trunk = workspace.gitConfig?.targetBranch || workspace.gitConfig?.defaultBranch || repo.defaultBranch || 'main';
        return NextResponse.json({
          error: `PR base '${effectiveBase}' does not exist on ${repo.fullName} (resolved from ${prBase.source}). GitHub refused the PR.`,
          hint: `Pass base='${trunk}' (or another existing branch) explicitly. If '${effectiveBase}' is a mission integration branch, the mission's branch was never created or was deleted — see the mission feed.`,
        }, { status: 400 });
      }
      throw err;
    }

    // Diff stats excluding generated paths (e.g. Drizzle snapshots) — a
    // migration snapshot must not inflate the number shown on task/PR cards.
    const createSplit = typeof prData.additions === 'number'
      ? await fetchSplitPrStats(repo.installation.installationId, repo.fullName, prData.number)
      : null;

    void recordCapabilityDecision({
      capability: 'pr.create', decision: 'allowed', workspaceId: worker.workspaceId, taskId: worker.taskId, workerId: worker.id,
      accountId: account.id, principalVia: auditVia(account, worker), resource: `pr:${prData.number}`,
      sideEffect: { prNumber: prData.number, head },
    });
    // Update worker with PR info and diff stats from GitHub's response
    await db
      .update(workers)
      .set({
        prUrl: prData.html_url,
        prNumber: prData.number,
        ...(createSplit ? { linesAdded: createSplit.reviewable.additions } : {}),
        ...(createSplit ? { linesRemoved: createSplit.reviewable.deletions } : {}),
        ...(createSplit ? { filesChanged: createSplit.reviewable.files } : {}),
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

    // Rule K2-19 — the late signal. "This task opened a PR, so it changed code"
    // is a fact LEARNED LATE, not a presentation concern, so it goes in the
    // column where every consumer sees it (usage stats, exports, the model
    // router on a retry) rather than into a render-time derivation only the UI
    // would know about. Guarded by `kind IS NULL`, so a task that declared
    // itself research stays research.
    await stampTaskKindIfAbsent(worker.taskId, 'engineering');

    await claimMissionPrimaryPr(worker.task?.missionId, prData.number, prData.html_url, {
      baseRef: prData.base?.ref ?? null,
      trunk: trunkBranches(workspace.gitConfig, repo.defaultBranch),
    });
    await supersedeAncestorEscalations(db, worker.task?.parentTaskId, prData.number);

    // Guaranteed supersede: when a retry opens a new PR instead of updating its
    // parent's (the resume branch could not be used), close the open ancestor
    // PRs so at most one PR for the fix is mergeable. Platform-enforced, and
    // AWAITED: fired without awaiting, the close could be cut off once the
    // response returned, and nothing recorded that it had not happened. Gated on
    // the task being a retry attempt, not only on context.iteration — an
    // attempt dispatched with iteration 0 is still a retry of its parent.
    // Failures are recorded as gate events and retried by the pr-reconcile
    // sweep (lib/retry-pr-supersession.ts).
    let supersededPrs: SupersededPr[] | undefined;
    const isRetryAttempt = worker.task?.taskClass === 'attempt' || retryIteration > 0;
    if (isRetryAttempt && worker.task?.parentTaskId && repo.installation?.installationId) {
      supersededPrs = await closeAncestorRetryPrs({
        parentTaskId: worker.task.parentTaskId,
        successorPrNumber: prData.number,
        successorBaseBranch: prData.base?.ref ?? null,
        installationId: repo.installation.installationId,
        repoFullName: repo.fullName,
        successorWorkerId: worker.id,
        workspaceId: workspace.id,
        taskId: worker.taskId ?? null,
        via: 'create_pr',
      }).catch(err => {
        console.error('[create_pr] closeAncestorRetryPrs failed:', err);
        fireGateEvent({
          gate: GATE_SLUGS.RETRY_PR_SUPERSESSION,
          surface: 'POST /api/github/pr',
          outcome: 'stranded',
          reason: `ancestor supersession did not run: ${err instanceof Error ? err.message : String(err)}`,
          workspaceId: workspace.id,
          taskId: worker.taskId ?? null,
          workerId: worker.id,
          detail: { successorPrNumber: prData.number },
          callerOrigin: 'worker',
        });
        return [] as SupersededPr[];
      });
    }

    // Change-intent: record surface intents + post conflict warnings (best-effort, non-blocking)
    try {
      const taskPathManifest = (worker.task?.pathManifest as string[] | null) ?? [];
      // Advisory warning surfaces plus opted-in serialized namespaces (schema triggers included).
      const matchedSurfaces = resolveIntentSurfaces(taskPathManifest, workspace.gitConfig ?? null);

      if (matchedSurfaces.length > 0) {
        // Record intent rows first (so we don't find ourselves as a conflict)
        await recordChangeIntents({
          workspaceId: workspace.id,
          taskId: worker.taskId ?? null,
          prNumber: prData.number,
          branch: head,
          headSha: prData.head?.sha ?? null,
          baseRef: typeof prData.base?.ref === 'string' && prData.base.ref ? prData.base.ref : effectiveBase ?? null,
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

    // Auto-merge intent flag: true when the resolved merge policy lets buildd merge
    // this PR unattended once CI is green (tier auto-threshold; the safety check
    // still runs). Derived from resolvePolicy — the same chain the merge gate uses —
    // never from the legacy autoMergeOnGreenCI / autoMergePR flags, which no gate reads.
    const autoMergeEnabled = resolvePolicy(
      workspace as never,
      mission,
      { requiresReview: worker.task?.requiresReview ?? false },
      { baseRef: prData.base?.ref ?? null },
    ).tier === 'auto-threshold';

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
      ...(supersededPrs && supersededPrs.length > 0 ? { supersededPrs } : {}),
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

  // A per-task token may close only the PR its own run opened.
  const account = await authenticateTaskScopedCaller(apiKey, req);
  if (!account) {
    return NextResponse.json({ error: 'Invalid API key' }, { status: 401 });
  }

  try {
    const requestBody = await req.json();
    const { workerId, prNumber, body: newPrBody } = requestBody;
    // Presence of `body` switches this call from closing the PR to rewriting
    // its body — the two things this route's only caller set ever needed
    // from a bare PATCH. See update_pr in mcp-tools.ts.
    const isBodyUpdate = newPrBody !== undefined;
    const capability = isBodyUpdate ? 'pr.update_body' as const : 'pr.close' as const;

    if (!workerId) {
      return NextResponse.json({ error: 'workerId required' }, { status: 400 });
    }
    if (!prNumber || typeof prNumber !== 'number') {
      return NextResponse.json({ error: 'prNumber required' }, { status: 400 });
    }
    if (isBodyUpdate && typeof newPrBody !== 'string') {
      return NextResponse.json({ error: 'body must be a string' }, { status: 400 });
    }

    const worker = await db.query.workers.findFirst({
      where: eq(workers.id, workerId),
      with: { workspace: true, task: { columns: { id: true, roleSlug: true, mode: true, context: true, title: true, description: true, missionId: true, reviewerRetryPrNumber: true, ciRetryPrNumber: true, conflictRetryPrNumber: true } } },
    });

    if (!worker) {
      return NextResponse.json({ error: 'Worker not found' }, { status: 404 });
    }

    if (!(await canActOnWorkerPr(account, worker))) {
      return NextResponse.json({ error: 'Worker belongs to different account' }, { status: 403 });
    }
    // A per-task token, and an agent run on its runner's key, may act only on a
    // PR its task owns: its own worker's PR or one the task names.
    if (!taskScopeAllowsWorkerPr(account, worker, prNumber) && !(await agentRunMayActOnPr(account, worker, prNumber))) {
      void recordCapabilityDecision({ capability, decision: 'refused', workspaceId: worker.workspaceId, taskId: worker.taskId, workerId: worker.id, accountId: account.id, principalVia: auditVia(account, worker), resource: `pr:${prNumber}`, reasonCode: 'pr_not_owned' });
      return NextResponse.json({ error: `A task token may ${isBodyUpdate ? 'update' : 'close'} only its own PR` }, { status: 403 });
    }
    if (!account.taskScope && !(await agentRunMayActOnPr(account, worker, prNumber))) {
      void recordCapabilityDecision({ capability, decision: 'refused', workspaceId: worker.workspaceId, taskId: worker.taskId, workerId: worker.id, accountId: account.id, principalVia: auditVia(account, worker), resource: `pr:${prNumber}`, reasonCode: 'pr_not_owned' });
      return NextResponse.json({ error: `An agent run may ${isBodyUpdate ? 'update' : 'close'} only its own PR (#${worker.prNumber ?? 'none'}) or one its task names` }, { status: 403 });
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

    void recordCapabilityDecision({ capability, decision: 'allowed', workspaceId: worker.workspaceId, taskId: worker.taskId, workerId: worker.id, accountId: account.id, principalVia: auditVia(account, worker), resource: `pr:${prNumber}` });
    const prData = await githubApi(
      repo.installation.installationId,
      `/repos/${repo.fullName}/pulls/${prNumber}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(isBodyUpdate ? { body: newPrBody } : { state: 'closed' }),
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
    console.error('Update PR error:', error);
    const message = error instanceof Error ? error.message : 'Failed to update PR';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * How the `merge_pr` door reports a behind-base refresh (lib/base-refresh.ts).
 * `wait` outcomes are a 409 — retry later, nothing is wrong; the rest are the
 * 403 refusal, naming why the branch was not brought up to date.
 */
function mergePrRefreshResponse(outcome: RefreshOutcome): { kind: RefreshOutcome['kind']; wait: boolean; detail: string; hint: string } {
  const retry = 'Retry merge_pr shortly; nothing else is needed.';
  switch (outcome.kind) {
    case 'updated':
      return { kind: outcome.kind, wait: true, detail: 'the branch has been updated from base', hint: retry };
    case 'in_flight':
      return { kind: outcome.kind, wait: true, detail: 'another refresh of this PR is already in flight', hint: retry };
    case 'head_changed':
      return { kind: outcome.kind, wait: true, detail: `the PR head moved before the refresh (${outcome.reason})`, hint: 'Re-read the PR (get_pr) and retry on the new head.' };
    case 'up_to_date':
      return { kind: outcome.kind, wait: true, detail: 'GitHub reports the branch already has every base commit', hint: retry };
    case 'deferred':
      return { kind: outcome.kind, wait: true, detail: `updating the branch failed (${outcome.failure}), not a conflict; attempt ${outcome.attempts}`, hint: retry };
    case 'semantic_deferred':
      return { kind: outcome.kind, wait: true, detail: `semantic overlap with the base is not verified yet (check ${outcome.rechecks})`, hint: retry };
    case 'conflict':
      return { kind: outcome.kind, wait: false, detail: `updating the branch hit a merge conflict (${outcome.reason})`, hint: 'Merge the base into the branch and resolve the conflict, then retry.' };
    case 'exhausted':
      return { kind: outcome.kind, wait: false, detail: `updating the branch keeps failing (${outcome.failure ?? 'unknown'}): ${outcome.reason}`, hint: 'A diagnostic was posted. Check the GitHub App access, or update the branch by hand.' };
    case 'semantic_conflict':
      return { kind: outcome.kind, wait: false, detail: `the PR and the base edit the same symbols (${outcome.assessment.reason})`, hint: 'Merge the base in and reconcile the named symbols, then retry.' };
    case 'semantic_unverified':
      return { kind: outcome.kind, wait: false, detail: `semantic overlap with the base could not be verified (${outcome.reason})`, hint: 'A diagnostic was posted. Review the overlap and merge by hand, or turn the semantic check off.' };
  }
}

// PUT /api/github/pr - Merge a pull request
/**
 * The `merge_pr` answer for a landing outcome. Only `merged` is a merge; the
 * two in-flight outcomes are 202 because nothing more is asked of the caller —
 * the next green on the named head lands the PR.
 */
function mergePrLandingResponse(
  outcome: LandingOutcome,
  pr: { prNumber: number; prUrl: string | null; tier: string },
): NextResponse {
  const prRef = { number: pr.prNumber, url: pr.prUrl };
  switch (outcome.kind) {
    case 'merged':
      return NextResponse.json({
        ok: true,
        merged: true,
        message: 'Pull request merged',
        landing: outcome,
        pr: { ...prRef, mergeCommitSha: outcome.sha || null },
      });
    case 'updating_branch':
      return NextResponse.json({
        ok: false,
        merged: false,
        branchUpdated: true,
        landing: outcome,
        message: `The branch was behind its base and has been updated (new head ${outcome.newHeadSha.slice(0, 7)}).`,
        hint: 'It merges automatically when CI is green on the new head. No further merge_pr call is needed.',
        pr: prRef,
      }, { status: 202 });
    case 'waiting_ci':
      return NextResponse.json({
        ok: false,
        merged: false,
        landing: outcome,
        message: `Not mergeable yet: waiting on ${outcome.headSha ? `head ${outcome.headSha.slice(0, 7)}` : 'the PR head'}.`,
        hint: 'It merges automatically when the pending checks or review finish green. No further merge_pr call is needed.',
        pr: prRef,
      }, { status: 202 });
    case 'needs_fix':
      return NextResponse.json({
        ok: false,
        merged: false,
        landing: outcome,
        error: `merge refused: ${outcome.reason}`,
        message: `merge refused: ${outcome.reason}`,
        tier: pr.tier,
        fix: outcome.fix,
        fixTaskId: outcome.taskId ?? null,
        hint: outcome.taskId
          ? `A ${outcome.fix} task (${outcome.taskId}) owns the next step.`
          : `Needs a ${outcome.fix} before it can land.`,
        pr: prRef,
      }, { status: 409 });
    case 'needs_human':
      return NextResponse.json({
        ok: false,
        merged: false,
        landing: outcome,
        error: `merge refused: ${outcome.reason}`,
        message: `merge refused: ${outcome.reason}`,
        tier: pr.tier,
        cause: outcome.cause,
        hint: outcome.cause === 'human_tier'
          ? 'Report completion and let the owner merge from the escalation inbox.'
          : 'A person has to decide this one. Report completion and let the owner merge or fix it.',
        pr: prRef,
      }, { status: 403 });
  }
}

export async function PUT(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;

  // A per-task token may merge only the PR its own run opened; the merge
  // policy below still decides whether it lands.
  const account = await authenticateTaskScopedCaller(apiKey, req);
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
        with: { workspace: true, task: { columns: { id: true, roleSlug: true, mode: true, context: true, title: true, description: true, missionId: true, reviewerRetryPrNumber: true, ciRetryPrNumber: true, conflictRetryPrNumber: true } } },
      });
      if (!worker) {
        return NextResponse.json({ error: 'Worker not found' }, { status: 404 });
      }
      if (!(await canActOnWorkerPr(account, worker))) {
        return NextResponse.json({ error: 'Worker belongs to different account' }, { status: 403 });
      }
      // A per-task token is held to the same rule below, with its own message.
      if (!account.taskScope && !(await agentRunMayActOnPr(account, worker, prNumber))) {
        void recordCapabilityDecision({ capability: 'pr.merge', decision: 'refused', workspaceId: worker.workspaceId, taskId: worker.taskId, workerId: worker.id, accountId: account.id, principalVia: auditVia(account, worker), resource: `pr:${prNumber}`, reasonCode: 'pr_not_owned' });
        return NextResponse.json({ error: `An agent run may merge only its own PR (#${worker.prNumber ?? 'none'}) or one its task names` }, { status: 403 });
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
    // A per-task token, and an agent run on its runner's key, may merge only a
    // PR its task owns: its own worker's PR or one the task names.
    if (!taskScopeAllowsWorkerPr(account, worker, prNumber) && !(await agentRunMayActOnPr(account, worker, prNumber))) {
      void recordCapabilityDecision({ capability: 'pr.merge', decision: 'refused', workspaceId: worker.workspaceId, taskId: worker.taskId, workerId: worker.id, accountId: account.id, principalVia: auditVia(account, worker), resource: `pr:${prNumber}`, reasonCode: 'pr_not_owned' });
      return NextResponse.json({ error: 'A task token may merge only its own PR' }, { status: 403 });
    }

    const workspace = worker.workspace;

    // Every merge-policy decision on this handler goes through here, so a new
    // refusal arm cannot be added without a ledger row. `mergePolicyTier` is
    // only known after the policy resolves, hence the optional extras bag.
    const recordMergeGate = (
      outcome: 'rejected' | 'deferred' | 'bypassed',
      reason: string,
      detail?: Record<string, unknown>,
      gate: string = GATE_SLUGS.MERGE_POLICY,
    ) => {
      fireGateEvent({
        gate,
        surface: 'PUT /api/github/pr',
        outcome,
        reason,
        workspaceId: worker.workspaceId ?? null,
        taskId: worker.taskId ?? null,
        workerId: worker.id ?? null,
        callerOrigin: hasTokenRouteAdminAccess(account, req, 'admin') ? 'api' : 'worker',
        detail: { prNumber, ...(detail ?? {}) },
      });
    };

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
    if (force && !hasTokenRouteAdminAccess(account, req, 'admin')) {
      recordMergeGate('rejected', 'force merge requires an admin token', { force: true });
      return NextResponse.json({
        error: 'force merge requires an admin token',
        hint: '`force` bypasses the workspace merge policy, so it is reserved for a human-held admin token. Drop `force` to merge under policy.',
      }, { status: 403 });
    }
    if (force) {
      // An accepted `force` is a policy bypass, and the count of them is the
      // honest read on whether the configured tier matches how the team
      // actually ships. It is not an error, so nothing else would record it.
      recordMergeGate('bypassed', 'merge policy skipped by admin force', { force: true });
    }

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
      recordMergeGate('rejected', 'could not read the PR head to evaluate merge policy — refusing the merge');
      return NextResponse.json({
        error: 'could not read the PR head to evaluate merge policy — refusing the merge',
        hint: 'Retry, or have a human merge from the escalation inbox.',
      }, { status: 403 });
    }

    if (!force) {
      const task = worker.taskId
        ? await db.query.tasks.findFirst({
            where: eq(tasks.id, worker.taskId),
            columns: { id: true, requiresReview: true, missionId: true, context: true },
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

      // The landing function decides once the workspace is in `enforce`: tier,
      // verdict (with carry-forward), rails, and "behind base" as a refresh
      // with a marker — so a behind PR lands on its next green without a
      // second merge_pr call, and a stored terminal approve under agent-review
      // authorises the merge rather than being refused on tier. `shadow`
      // records what it would do, then the legacy gates below decide.
      const landingMode = resolveLandingMode(workspace.gitConfig);
      if (landingMode !== 'off') {
        const outcome = await landPr({
          workspaceId: workspace.id,
          installationId: repo.installation.installationId,
          repoFullName: repo.fullName,
          prNumber,
          eventHeadSha: null,
          door: 'merge_pr',
          actor: { kind: 'agent', workerId: worker.id ?? null },
          mode: landingMode,
          policy,
          owner: { taskId: worker.taskId ?? null, workerId: worker.id ?? null },
          releaseConfig: workspace.releaseConfig ?? null,
          gitConfig: workspace.gitConfig ?? null,
          mergeMethod: mergeMethod as 'merge' | 'squash' | 'rebase',
        });
        if (landingMode === 'enforce') {
          if (outcome.kind === 'merged') {
            await recordPrFact({ workerId: worker.id }, { kind: 'merged', mergedAt: new Date() });
          }
          return mergePrLandingResponse(outcome, { prNumber, prUrl: worker.prUrl ?? null, tier: policy.tier });
        }
      }

      if (policy.tier === 'human') {
        recordMergeGate('rejected', `merge policy tier is 'human' — this PR must be merged by a person`, { tier: policy.tier });
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
        // rails auto-threshold uses below (CI, legacy stored deny paths,
        // the migration operation-class inspector).
        const reviewStatus = await readPrReviewStatus({ workspaceId: workspace.id, prNumber });
        const selfMergeable =
          reviewStatus.state === 'approved' &&
          isApprovalSelfMergeable(
            { verdict: reviewStatus.verdict, confidence: reviewStatus.confidence, merged: reviewStatus.merged },
            policy.agentReview?.maxConfidenceThreshold,
          );

        if (!selfMergeable) {
          recordMergeGate(
            'rejected',
            `merge policy tier is 'agent-review' — a reviewer decides this PR, so it cannot be self-merged`,
            { tier: policy.tier, reviewState: reviewStatus.state },
          );
          return NextResponse.json({
            error: `merge policy tier is 'agent-review' — a reviewer decides this PR, so it cannot be self-merged`,
            tier: policy.tier,
            hint: 'Use request_pr_review to dispatch the reviewer, then get_pr_review for the verdict. An approve merges the PR for you when policy permits.',
          }, { status: 403 });
        }
      }

      // Review-verdict gate — applies at EVERY tier, not just `agent-review`.
      //
      // The tier check above only fires for `agent-review`, and a task PR based
      // on a mission integration branch resolves to `auto-threshold` by
      // construction (resolvePolicy rule 2) while still having a reviewer
      // dispatched against it. Without this, an agent could merge straight past
      // its own reviewer's request-changes on any Option A′ PR.
      const reviewGate = await guardReviewVerdict({
        workspaceId: workspace.id,
        prNumber,
        headSha,
        surface: 'PUT /api/github/pr',
        taskId: worker.taskId ?? null,
        workerId: worker.id ?? null,
        callerOrigin: hasTokenRouteAdminAccess(account, req, 'admin') ? 'api' : 'worker',
        carryForward: policyPr?.base?.ref
          ? { installationId: repo.installation.installationId, repoFullName: repo.fullName, baseRef: policyPr.base.ref }
          : null,
      });
      if (reviewGate.blocks) {
        recordMergeGate(
          'rejected',
          reviewGate.reason ?? 'review verdict blocks this merge',
          {
            tier: policy.tier,
            reviewState: reviewGate.state ?? null,
            reviewKind: reviewGate.kind ?? null,
            reviewTaskId: reviewGate.reviewTaskId ?? null,
          },
          GATE_SLUGS.REVIEW_VERDICT,
        );
        return NextResponse.json({
          error: `merge refused: ${reviewGate.reason}`,
          tier: policy.tier,
          reviewState: reviewGate.state ?? null,
          hint: reviewGate.clearedBy,
        }, { status: 403 });
      }

      const safety = await evaluateAutoMergeSafety(
        repo.installation.installationId,
        repo.fullName,
        prNumber,
        headSha,
        policy,
        {
          // The task's own mission: a task PR into its integration branch
          // skips the size cap, same as the other merge doors.
          mission: mission ?? null,
          releaseConfig: workspace.releaseConfig,
          workspaceId: workspace.id,
          taskId: worker.taskId ?? null,
          workerId: worker.id ?? null,
          gitConfig: workspace.gitConfig ?? null,
        },
      );
      if (!safety.ok) {
        // Behind base but not conflicting: bring the branch up to date here
        // rather than leave the caller a manual rebase. Never merge in the
        // same call — the update is a new head whose CI has not run, which is
        // the very thing the freshness refusal guards against.
        if (isBehindBaseRefusal(safety.reason) && isDependencyBotPrContext(task?.context)) {
          // The bot rebases its own branch; an update-branch commit from us
          // would stop it doing so for good.
          recordMergeGate('rejected', dependencyBotPushRefusal(prNumber), { tier: policy.tier }, GATE_SLUGS.DEPENDENCY_BOT_PR);
        } else if (isBehindBaseRefusal(safety.reason)) {
          // Same door as every other refresh (lib/base-refresh.ts): the per-PR
          // lease, failure classification and, opted in, the semantic check
          // and its enforce-mode hold. This door never dispatches an agent —
          // a conflict or a semantic finding is reported back to the caller.
          // A worker with no task has nowhere to keep refresh state. With the
          // semantic check off there is nothing to hold, so it keeps the old
          // direct update (pinned to the evaluated head); with it on, it is
          // refused rather than let past the check.
          const taskless = !worker.taskId && resolveSemanticRefreshMode(workspace.gitConfig) === 'off'
            ? await updateBehindPrBranch({
                installationId: repo.installation.installationId,
                repoFullName: repo.fullName,
                prNumber,
                headSha,
              })
            : null;
          const update: RefreshOutcome | null = taskless
            ? (taskless.updated ? { kind: 'updated' } : null)
            : worker.taskId
            ? await refreshBehindPr({
                installationId: repo.installation.installationId,
                repoFullName: repo.fullName,
                prNumber,
                headSha,
                workspaceId: workspace.id,
                taskId: worker.taskId,
                workerId: worker.id ?? null,
                missionId: task?.missionId ?? null,
                gitConfig: workspace.gitConfig ?? null,
              })
            : null;
          const refreshed = update ? mergePrRefreshResponse(update) : null;
          if (refreshed?.kind === 'updated') {
            recordMergeGate('deferred', `branch updated from base: ${safety.reason}`, { tier: policy.tier });
            return NextResponse.json({
              error: `${safety.reason} — the branch has been updated from base; CI must re-run on the new head`,
              tier: policy.tier,
              branchUpdated: true,
              hint: 'Wait for CI to go green on the updated head (get_pr), then call merge_pr again.',
            }, { status: 409 });
          }
          if (refreshed?.wait) {
            recordMergeGate('deferred', `${safety.reason} — ${refreshed.detail}`, { tier: policy.tier, refresh: refreshed.kind });
            return NextResponse.json({
              error: `${safety.reason} — ${refreshed.detail}`,
              tier: policy.tier,
              refresh: refreshed.kind,
              hint: refreshed.hint,
            }, { status: 409 });
          }
          if (refreshed) {
            recordMergeGate('rejected', `merge policy refused this merge: ${safety.reason} — ${refreshed.detail}`, { tier: policy.tier, refresh: refreshed.kind });
            return NextResponse.json({
              error: `merge policy refused this merge: ${safety.reason} — ${refreshed.detail}`,
              tier: policy.tier,
              refresh: refreshed.kind,
              hint: refreshed.hint,
            }, { status: 403 });
          }
        }
        recordMergeGate('rejected', `merge policy refused this merge: ${safety.reason}`, { tier: policy.tier });
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
      // Deferred, not rejected: the merge is correct and simply not yet due.
      recordMergeGate(
        'deferred',
        `cannot merge the mission PR yet: ${mergeGate.reason}`,
        { missionId: mergingTask?.missionId ?? null },
        GATE_SLUGS.MISSION_PR_LIFECYCLE,
      );
      return NextResponse.json({
        error: `cannot merge the mission PR yet: ${mergeGate.reason}`,
        hint: 'Wait for the remaining task PRs to merge into the integration branch, then retry.',
      }, { status: 409 });
    }

    // ── Surface merge ordering (conflict-aware-orchestration.md §3) ─────────
    // Off by default. `force` is the existing explicit override: it proceeds
    // past an ordering wait but is ledgered as `bypassed`, never silent.
    const surfaceOrder = await checkSurfaceOrder({
      workspaceId: workspace.id,
      installationId: repo.installation.installationId,
      repoFullName: repo.fullName,
      prNumber,
      headSha,
      gitConfig: workspace.gitConfig ?? null,
      taskId: worker.taskId ?? null,
      workerId: worker.id ?? null,
      door: 'merge_pr',
      callerOrigin: 'worker',
      override: !!force,
    });
    if (surfaceOrder.blocks) {
      return NextResponse.json({
        error: `merge deferred: ${surfaceOrder.reason}`,
        waitingOnPr: surfaceOrder.counterpartPrNumber,
        surface: surfaceOrder.surface,
        hint: 'This PR merges automatically once the earlier PR on the same surface closes. Do not wait for it.',
      }, { status: 409 });
    }

    const slotted = await mergeInSurfaceSlot(surfaceOrder, () => mergePullRequest(
      repo.installation.installationId,
      repo.fullName,
      prNumber,
      mergeMethod as 'merge' | 'squash' | 'rebase',
      headSha,
    ));
    if ('refused' in slotted) {
      return NextResponse.json({
        error: `merge deferred: ${slotted.refused}`,
        hint: 'Another PR on the same serialized surface is merging right now; this one is re-evaluated when it closes.',
      }, { status: 409 });
    }
    const result = slotted.result;
    void recordCapabilityDecision({
      capability: 'pr.merge', decision: result.merged ? 'allowed' : 'refused', workspaceId: worker.workspaceId, taskId: worker.taskId ?? null,
      workerId: worker.id ?? null, accountId: account.id, principalVia: auditVia(account, worker), resource: `pr:${prNumber}`,
      reasonCode: result.merged ? null : 'merge_failed', sideEffect: result.merged ? { prNumber, merged: true } : null,
    });

    if (result.merged) {
      // Through the fact funnel (terminal wins); Slice C moves this door to T16.
      await recordPrFact({ workerId: worker.id }, { kind: 'merged', mergedAt: new Date() });
      await finalizeMissionPrMerge(mergingTask, repo.installation.installationId, repo.fullName);
      // The merge made a live reviewer and any open fix obsolete. The
      // pull_request.closed webhook fires the same event; the CAS keeps it to
      // one cancellation per task whichever door gets there first.
      await reconcileSubjectEvent({
        kind: 'merged',
        workspaceId: worker.workspaceId,
        prNumber,
        originalTaskId: worker.taskId,
        door: 'PUT /api/github/pr',
        pr: { installationId: repo.installation.installationId, repoFullName: repo.fullName },
      });
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
            await recordPrFact({ workerId: worker.id }, { kind: 'merged', mergedAt: new Date() });
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
//
// Auth: API key, or the dashboard session (GET only — merge/close/create stay
// key-only). A session reads a worker's PR when the user is a member of the
// worker workspace's team; by prNumber it searches the user's teams, or just
// `teamId` when given. Anything outside that scope 404s. A key, when present,
// is authoritative and `teamId` is ignored.
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;

  // A per-task token reads PRs only in its own task's workspace.
  const account = await authenticateTaskScopedCaller(apiKey, req);
  const sessionUser = account ? null : await getCurrentUser();
  if (!account && !sessionUser) {
    return NextResponse.json({ error: 'Invalid API key' }, { status: 401 });
  }

  try {
    const { searchParams } = new URL(req.url);
    const workerId = searchParams.get('workerId');
    const prNumberParam = searchParams.get('prNumber');
    const workspaceIdParam = searchParams.get('workspaceId');
    const includeComments = searchParams.get('includeComments') === 'true';
    const includeCiFailures = searchParams.get('includeCiFailures') === 'true';

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
      if (sessionUser) {
        const access = worker.workspaceId ? await verifyWorkspaceAccess(sessionUser.id, worker.workspaceId) : null;
        const pinTeamId = searchParams.get('teamId');
        if (!access || (pinTeamId && access.teamId !== pinTeamId)) {
          return NextResponse.json({ error: 'Worker not found' }, { status: 404 });
        }
      } else if (!(await canActOnWorkerPr(account!, worker))) {
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
      let resolved: Awaited<ReturnType<typeof resolveWorkerByPrNumber>>;
      if (sessionUser) {
        const teamIds = await resolveSessionTeamIds(sessionUser.id, searchParams.get('teamId'));
        if (!teamIds) return NextResponse.json({ error: 'PR not found' }, { status: 404 });
        resolved = await resolveWorkerByPrNumberInWorkspaces(await workspaceIdsForTeams(teamIds), prNum, workspaceIdParam);
      } else {
        resolved = await resolveWorkerByPrNumber(account!, prNum, workspaceIdParam);
      }
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
    if (account && !taskScopeAllowsWorkspace(account, worker.workspaceId)) {
      return NextResponse.json({ error: 'PR not found' }, { status: 404 });
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

    // Fetch CI checks, reviews, and (opt-in) issue comments in parallel. The
    // comments call is skipped entirely — not even queued — when the caller
    // didn't ask, so the default hot-path request makes exactly the same
    // GitHub calls it always has.
    const [checksResult, reviewsResult, commentsResult] = await Promise.allSettled([
      headSha
        ? githubApi(installationId, `/repos/${fullName}/commits/${headSha}/check-runs?per_page=100`)
        : Promise.resolve(null),
      githubApi(installationId, `/repos/${fullName}/pulls/${prNumber}/reviews`),
      includeComments
        ? githubApi(installationId, `/repos/${fullName}/issues/${prNumber}/comments?per_page=100`)
        : Promise.resolve(null),
    ]);

    const checksData = checksResult.status === 'fulfilled' ? checksResult.value : null;
    const reviewsData = reviewsResult.status === 'fulfilled' ? reviewsResult.value : null;
    const commentsData = commentsResult.status === 'fulfilled' ? commentsResult.value : null;
    const comments = includeComments
      ? rankPrComments(Array.isArray(commentsData) ? commentsData : [], githubAppBotLogin())
      : null;

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
      // Which ones, by the latest run of each name (lib/failed-checks.ts).
      failedChecks: failedChecks(checkRuns),
    };

    // Opt-in: why each failing check failed, from its job log. Imported lazily
    // so the default request never loads the log reader, and a failure here
    // costs the excerpts, not the PR.
    let ciFailures: Array<{ name: string; conclusion: string; url: string | null; step: string | null; excerpt: string | null }> | null = null;
    if (includeCiFailures) {
      const failing = ciSummary.failedChecks;
      ciFailures = failing.map(f => ({ ...f, step: null, excerpt: null }));
      if (failing.length > 0) {
        try {
          const { fetchCiFailureExcerpts } = await import('@/lib/ci-failure-excerpts');
          ciFailures = await fetchCiFailureExcerpts(installationId, fullName, failing);
        } catch (err) {
          console.warn(`Could not read CI failure logs for ${fullName}#${prNumber}:`, err);
        }
      }
    }

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

    // Per-file breakdown so a Drizzle snapshot can't read as the diff size.
    // `additions`/`deletions`/`changedFiles` below are the reviewable figures;
    // `generatedAdditions`/`generatedDeletions`/`generatedFiles` carry the rest
    // so it stays visible rather than silently disappearing from the response.
    const splitStats = typeof pr.additions === 'number'
      ? await fetchSplitPrStats(installationId, fullName, prNumber)
      : null;

    // Fix attempts on this PR's chain, with why each ended as it did. A read
    // failure costs the list, not the PR.
    const attempts = await loadPrAttempts(worker.taskId).catch(() => []);
    // The PR read itself is team-wide for a key, but evidence follows the
    // workspace reach rule (restricted = linked accounts only), the same one
    // GET /api/tasks/[id]/evidence applies. A session already passed team
    // membership above.
    const evidenceReachable = !!(worker.taskId && worker.workspaceId) && (
      sessionUser ? true : await verifyAccountWorkspaceAccess(account!.id, worker.workspaceId)
    );
    const evidenceObjects = evidenceReachable
      ? await loadInlineEvidence(worker.workspaceId, worker.taskId, {
        surface: 'get_pr',
        actor: sessionUser ? { userId: sessionUser.id } : { accountId: account!.id },
      })
      : [];

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
        additions: splitStats ? splitStats.reviewable.additions : (pr.additions ?? null),
        deletions: splitStats ? splitStats.reviewable.deletions : (pr.deletions ?? null),
        changedFiles: splitStats ? splitStats.reviewable.files : (pr.changed_files ?? null),
        generatedAdditions: splitStats?.generated.additions ?? 0,
        generatedDeletions: splitStats?.generated.deletions ?? 0,
        generatedFiles: splitStats?.generated.files ?? 0,
        mergedAt: canonicalState === 'merged' ? (pr.merged_at ?? dbMergedAt) : null,
        mergeCommitSha: canonicalState === 'merged' ? (pr.merge_commit_sha ?? null) : null,
        mergedBy: canonicalState === 'merged' ? (pr.merged_by?.login ?? null) : null,
        mergedVia: canonicalState === 'merged' ? 'unknown' : null,
        closedAt: canonicalState === 'closed_unmerged' ? (pr.closed_at ?? null) : null,
        // Supersession edge (task fcaf83d5) — only meaningful on a closed,
        // unmerged PR; recordPrSupersession verified this against GitHub at
        // write time, so it is trusted here without a second round-trip.
        supersededByPrNumber: canonicalState === 'closed_unmerged' ? (worker.supersededByPrNumber ?? null) : null,
        supersededByPrUrl: canonicalState === 'closed_unmerged' ? (worker.supersededByPrUrl ?? null) : null,
        supersededReason: canonicalState === 'closed_unmerged' ? (worker.supersededReason ?? null) : null,
      },
      checks: ciSummary,
      reviews: reviewSummary,
      ...(comments ? { comments } : {}),
      ...(ciFailures ? { ciFailures } : {}),
      ...(attempts.length > 0 ? { attempts } : {}),
      ...(evidenceObjects.length > 0 ? { evidenceObjects } : {}),
    });
  } catch (error) {
    console.error('Get PR error:', error);
    const message = error instanceof Error ? error.message : 'Failed to get PR';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
