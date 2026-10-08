/**
 * POST /api/prs/[prNumber]/merge
 *
 * Human-triggered merge for PRs in the escalation inbox (merge policy BT-15/17).
 * Finds the worker by prNumber, merges via GitHub App, stamps mergedAt, and
 * triggers downstream task unblocking.
 *
 * Auth: session user who has access to the workspace.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { tasks, workers, workspaces, missionNotes, missions } from '@buildd/core/db/schema';
import { eq, and, inArray, isNotNull, isNull } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserWorkspaceIds } from '@/lib/team-access';
import { mergePullRequest, githubApi } from '@/lib/github';
import { checkSurfaceOrder, mergeInSurfaceSlot } from '@/lib/surface-ordering-door';
import { checkBaseRefreshHold } from '@/lib/base-refresh';
import { checkAndUnblockDependentMissions } from '@/lib/mission-dependency';
import { checkDependsOnResolved } from '@/lib/task-dependencies';
import { triggerEvent, channels, events } from '@/lib/pusher';
import { classifyMergeFailure, dispatchConflictRetry } from '@/lib/conflict-retry';
import { recordPrFact } from '@buildd/core/pr-facts';
import { escalateConflictExhaustion } from '@/lib/auto-merge';
import { reconcileSubjectEvent } from '@/lib/supersession';
import { guardMissionPrMerge, finalizeMissionPrMerge } from '@/lib/mission-pr';
import { appendPrActivity } from '@/lib/pr-activity-comment';
import { supersedeAncestorEscalations } from '@/lib/escalation-supersession';
import { guardReviewVerdict } from '@/lib/review-verdict-gate';
import { fireGateEvent, GATE_SLUGS } from '@/lib/gate-ledger';
import { landPr, resolveLandingMode, type LandingOutcome } from '@/lib/pr-landing';
import { resolvePolicy, RESOLVE_POLICY_MISSION_COLUMNS } from '@/lib/merge-policy';
import { latestRunPerName } from '@/lib/auto-merge-bound';
import { kernelLandingView, landThroughKernel, type KernelLanding } from '@/lib/workflow/seam';

/**
 * The dashboard's answer when the landing function did not merge. A refresh in
 * flight is accepted work (202); everything else is a refusal the card shows.
 */
/**
 * The kernel's answer when it did not merge a kernel-owned PR (T15/T16). A
 * stale screen is a 409 with the delivery as it stands now (§7.2, S20).
 */
function kernelLandingRefusal(k: KernelLanding): NextResponse {
  switch (k.outcome) {
    case 'stale':
      return NextResponse.json({ error: k.message, stale: true, reason: k.reason, current: k.current }, { status: 409 });
    case 'behind':
      return NextResponse.json({ ok: false, merged: false, branchUpdated: true, message: 'The branch was behind its base and is being updated. It merges when CI is green on the new head.', current: k.current }, { status: 202 });
    case 'landing':
      return NextResponse.json({ ok: false, merged: false, landing: true, message: k.message, current: k.current }, { status: 202 });
    case 'conflict':
      return NextResponse.json({ error: `PR has merge conflicts: ${k.message}`, conflictRetryDispatched: true, mergeConflict: true, current: k.current }, { status: 409 });
    default:
      return NextResponse.json({ error: k.message, kernel: { outcome: k.outcome, reason: k.reason }, current: k.current }, { status: 409 });
  }
}

function dashboardLandingRefusal(outcome: Exclude<LandingOutcome, { kind: 'merged' }>): NextResponse {
  switch (outcome.kind) {
    case 'updating_branch':
      return NextResponse.json({
        ok: false,
        merged: false,
        branchUpdated: true,
        landing: outcome,
        message: 'The branch was behind its base and has been updated. It merges when CI is green on the new head.',
      }, { status: 202 });
    case 'waiting_ci':
      return NextResponse.json({
        error: 'Not mergeable yet: checks or the review are still running on the PR head.',
        landing: outcome,
      }, { status: 409 });
    case 'needs_fix':
      return NextResponse.json({
        error: `Merge refused: ${outcome.reason}`,
        landing: outcome,
        fix: outcome.fix,
        fixTaskId: outcome.taskId ?? null,
        ...(outcome.fix === 'ci_fix' ? { ciFailing: true } : {}),
      }, { status: 409 });
    case 'needs_human':
      return NextResponse.json({
        error: `Merge refused: ${outcome.reason}`,
        landing: outcome,
        cause: outcome.cause,
        ...(outcome.cause === 'blocking_verdict' ? { reviewGateBlocked: true } : {}),
      }, { status: 409 });
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ prNumber: string }> }
) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { prNumber: prNumberStr } = await params;
  const prNumber = parseInt(prNumberStr, 10);
  if (!prNumber || isNaN(prNumber)) {
    return NextResponse.json({ error: 'Invalid PR number' }, { status: 400 });
  }

  // Get user's accessible workspace IDs
  const wsIds = await getUserWorkspaceIds(user.id);
  if (wsIds.length === 0) {
    return NextResponse.json({ error: 'No workspaces found' }, { status: 403 });
  }

  // Accept workspaceId from body to disambiguate when the same PR number exists in
  // multiple repos. The merge card passes the workspace UUID from the escalation item.
  let rawWorkspaceId: string | null = null;
  // "Merge anyway" on an escalate-verdict card — overrides the reviewer's
  // escalation, not any CI/mergeability guard below (those run unmodified).
  // escalationReason is the text the card was already displaying at the
  // moment the human chose to override, so the audit trail records what they
  // actually saw rather than a fresh (and possibly since-changed) DB re-read.
  let override = false;
  // Further things a person may knowingly override under `enforce` (the landing
  // function's own overrides): the size cap and base freshness. Red CI and deny
  // paths are never overridable.
  let sizeOverride = false;
  let freshnessOverride = false;
  let overrideEscalationReason: string | null = null;
  // The workflow-kernel delivery version the card was rendered from (§7.2): a
  // stale one is refused with the current view before anything acts.
  let expectedVersion: number | undefined;
  // Set by the legacy review gate when it blocked and `override` bypassed it.
  let reviewGateReason: string | null = null;
  try {
    const body = await req.json().catch(() => ({}));
    if (body?.workspaceId && typeof body.workspaceId === 'string') {
      rawWorkspaceId = body.workspaceId;
    }
    if (body?.overrides && typeof body.overrides === 'object') {
      sizeOverride = body.overrides.size === true;
      freshnessOverride = body.overrides.freshness === true;
    }
    if (typeof body?.version === 'number' && Number.isInteger(body.version)) {
      expectedVersion = body.version;
    }
    if (body?.override === true || body?.overrides?.verdict === true) {
      override = true;
      if (typeof body.escalationReason === 'string' && body.escalationReason.trim().length > 0) {
        overrideEscalationReason = body.escalationReason.trim();
      }
    }
  } catch { /* non-fatal — body is optional */ }

  // Resolve workspaceId to a UUID — callers may pass a repo name (e.g. "sibling-app")
  // rather than a UUID. wsIds only contains UUIDs, so a direct includes() check
  // misses name-based inputs. If a workspaceId was supplied but doesn't resolve to
  // one of the caller's accessible workspaces, fail explicitly instead of silently
  // falling back to the unscoped wsIds search — an unresolved disambiguator must
  // never be treated the same as "no disambiguator supplied" (mirrors
  // resolveWorkerByPrNumber in apps/web/src/app/api/github/pr/route.ts).
  let workspaceId: string | null = null;
  if (rawWorkspaceId) {
    if (wsIds.includes(rawWorkspaceId)) {
      workspaceId = rawWorkspaceId;
    } else {
      const allWs = await db.query.workspaces.findMany({
        where: inArray(workspaces.id, wsIds),
        columns: { id: true, name: true, repo: true },
      });
      const lower = rawWorkspaceId.toLowerCase();
      const match = allWs.find(ws =>
        ws.name.toLowerCase() === lower ||
        ws.repo?.toLowerCase() === lower ||
        ws.repo?.toLowerCase().endsWith('/' + lower)
      );
      workspaceId = match?.id ?? null;
    }
    if (!workspaceId) {
      return NextResponse.json(
        { error: `Workspace "${rawWorkspaceId}" not found or not accessible` },
        { status: 403 },
      );
    }
  }

  const searchIds = workspaceId ? [workspaceId] : wsIds;

  // Fetch ALL unmerged workers matching this prNumber across the user's workspaces.
  // PR numbers are not unique across repos — findFirst would silently pick the wrong
  // workspace's worker if two repos both happen to have an open PR with this number.
  const matchingWorkers = await db.query.workers.findMany({
    where: and(
      inArray(workers.workspaceId, searchIds),
      eq(workers.prNumber, prNumber),
      isNotNull(workers.prUrl),
      isNull(workers.mergedAt),
    ),
    columns: {
      id: true,
      taskId: true,
      workspaceId: true,
      prUrl: true,
      prNumber: true,
      prLifecycleStatus: true,
      lastCommitSha: true,
    },
    with: {
      task: {
        columns: { id: true, title: true, taskClass: true, missionId: true, status: true, requiresReview: true },
      },
    },
  });

  if (matchingWorkers.length === 0) {
    return NextResponse.json({ error: 'PR not found or already merged' }, { status: 404 });
  }

  // Guard against cross-workspace ambiguity: if the same PR number appears in
  // multiple repos, we cannot know which one to merge without a workspaceId.
  const distinctWorkspaceIds = new Set(matchingWorkers.map((w) => w.workspaceId));
  if (distinctWorkspaceIds.size > 1) {
    const candidates = [...distinctWorkspaceIds];
    console.error(
      `[pr-merge] PR #${prNumber} matched ${distinctWorkspaceIds.size} workspaces — ambiguous merge rejected`,
    );
    return NextResponse.json(
      {
        error: `PR #${prNumber} exists in multiple workspaces — pass workspaceId to disambiguate`,
        candidates,
      },
      { status: 409 },
    );
  }

  const worker = matchingWorkers[0];

  if (worker.prLifecycleStatus === 'closed') {
    return NextResponse.json({ error: 'PR is closed and cannot be merged' }, { status: 409 });
  }

  // Resolve repo and installation via githubRepos — the same path used by PR
  // creation and resolveReleaseTarget(). The legacy workspaces.repo and
  // workspaces.githubInstallationId columns can be stale or null, which causes
  // GitHub to return 404 "Not Found" on the merge PUT.
  const workspace = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, worker.workspaceId),
    columns: { id: true, gitConfig: true, releaseConfig: true },
    with: {
      githubRepo: {
        columns: { fullName: true },
        with: {
          installation: {
            columns: { installationId: true },
          },
        },
      },
    },
  });

  if (!workspace?.githubRepo?.installation?.installationId) {
    return NextResponse.json({ error: 'Workspace has no GitHub installation' }, { status: 422 });
  }

  const installationId = workspace.githubRepo.installation.installationId;
  const repoFullName = workspace.githubRepo.fullName;

  console.log(
    `[pr-merge] merging PR #${prNumber} — worker=${worker.id} workspace=${worker.workspaceId} repo=${repoFullName} installation=${installationId}`,
  );

  // A kernel-owned PR (workflow-state-kernel §14 Slice C): the kernel merges it
  // and owns the post-merge work; this route keeps its rails. A person acting
  // on a stale view is told so, with the current one, before any rail acts.
  const kernelView = await kernelLandingView(worker.workspaceId, repoFullName, prNumber);
  if (kernelView && expectedVersion !== undefined && kernelView.current.version !== expectedVersion) {
    return NextResponse.json({
      error: `This PR changed since the card was loaded (version ${expectedVersion}, now ${kernelView.current.version}); nothing was merged. Reload and try again.`,
      stale: true,
      reason: 'version_moved',
      current: kernelView.current,
    }, { status: 409 });
  }
  const kernelOwned = !!kernelView;

  // Mission-PR branch-lifecycle gate (P3) — same rule the other merge paths
  // enforce: refuse to merge the mission PR while a sibling task PR based on
  // the integration branch is still open, since merging deletes that branch.
  const mergeGate = await guardMissionPrMerge(worker.task ?? null);
  if (mergeGate.blocks) {
    return NextResponse.json({ error: `cannot merge the mission PR yet: ${mergeGate.reason}` }, { status: 409 });
  }

  // Finalizes a merge that GitHub has confirmed happened — either the normal
  // success response, or a live re-check after an indeterminate one below.
  // Every side effect after the PUT itself lives here so both paths agree.
  const finalizeSuccessfulMerge = async (opts: { missionFinalized?: boolean } = {}) => {
    // A legacy PR's merge is recorded here, through the fact funnel (terminal
    // wins). A kernel-owned PR's merge, its stamp and everything it owes are the
    // kernel's post-merge effects (PrMerged from a live read), never this door's.
    if (!kernelOwned) {
      await recordPrFact({ workerId: worker.id }, { kind: 'merged', mergedAt: new Date() });
      // landPr finalizes the mission PR itself when it merged.
      if (!opts.missionFinalized) {
        await finalizeMissionPrMerge(worker.task ?? null, installationId, repoFullName);
      }
    }

    // "Merge anyway" — record the override ONLY now that the merge actually
    // succeeded. Every other guard (red CI, branch protection's required
    // checks, the mission-PR branch-lifecycle gate) ran unmodified; override
    // never skips them, it just means a failure past this point would have
    // nothing to log.
    if (override && worker.taskId) {
      // What the human actually overrode, most specific first: the text the
      // card was showing, then the gate's own reason (which names the blocking
      // verdict and the commit it was made against).
      const overriddenReason =
        overrideEscalationReason ?? reviewGateReason ?? 'reviewer escalation (reason not recorded)';
      const missionId = (worker.task as { missionId?: string | null } | null)?.missionId;
      if (missionId) {
        await db.insert(missionNotes).values({
          missionId,
          taskId: worker.taskId,
          authorType: 'user',
          actorLabel: user.email,
          type: 'decision',
          title: `PR #${prNumber} merged despite reviewer escalation — human override`,
          body: `${user.email} merged this PR via "Merge anyway", overriding: ${overriddenReason}`,
          status: 'open',
        }).catch((e: unknown) =>
          console.error(`[pr-merge] failed to record override note for PR #${prNumber}:`, e)
        );
      }
      await supersedeAncestorEscalations(db, worker.taskId, prNumber).catch((e: unknown) =>
        console.error(`[pr-merge] failed to supersede escalation for PR #${prNumber}:`, e)
      );
      await appendPrActivity({
        installationId,
        repoFullName,
        prNumber,
        entry: { kind: 'human_override_merge', note: overriddenReason },
        workspaceId: worker.workspaceId,
      }).catch((e: unknown) =>
        console.error(`[pr-merge] failed to append override activity for PR #${prNumber}:`, e)
      );
    }

    // Trigger real-time update
    await triggerEvent(channels.workspace(worker.workspaceId), events.WORKER_PROGRESS, {
      taskId: worker.taskId,
    });

    // Unblock tasks that depend on this task (mergedAt now set — gate is clear).
    // A kernel-owned PR's dependents, cancellations and mission unblocking ran
    // as its post-merge effects.
    if (worker.taskId && !kernelOwned) {
      checkDependsOnResolved(worker.taskId).catch((e: unknown) =>
        console.error(`[pr-merge] checkDependsOnResolved failed for task ${worker.taskId}:`, e)
      );

      // A human just merged this PR directly: a live reviewer or an open fix
      // for it is obsolete. Fire-and-forget (never throws), so it never blocks
      // the merge response.
      void reconcileSubjectEvent({
        kind: 'merged',
        workspaceId: worker.workspaceId,
        prNumber,
        originalTaskId: worker.taskId,
        door: 'POST /api/prs/[prNumber]/merge',
        pr: { installationId, repoFullName },
      });
    }

    // Unblock dependent missions if this task belonged to one
    const missionId = (worker.task as any)?.missionId;
    if (missionId && !kernelOwned) {
      checkAndUnblockDependentMissions(missionId, 'merged').catch((e: unknown) =>
        console.error(`[pr-merge] unblock failed for mission ${missionId}:`, e)
      );
    }

    return NextResponse.json({ ok: true, merged: true });
  };

  // The live head and base, read once: the review gate, the CI guard and the
  // landing function all evaluate this PR as GitHub has it now.
  // `worker.lastCommitSha` lags a push, and lagging in that direction would
  // make a stale verdict look current.
  let liveHeadSha: string | null = null;
  let liveBaseRef: string | null = null;
  try {
    const livePr = await githubApi(installationId, `/repos/${repoFullName}/pulls/${prNumber}`);
    liveHeadSha = typeof livePr?.head?.sha === 'string' ? livePr.head.sha : null;
    liveBaseRef = typeof livePr?.base?.ref === 'string' ? livePr.base.ref : null;
  } catch (e) {
    console.warn(`[pr-merge] could not read PR #${prNumber} head for the review gate:`, e);
  }

  if (!liveHeadSha) {
    return NextResponse.json({ error: 'Could not verify the live PR head — retry the merge' }, { status: 409 });
  }

  // ── The landing function (gitConfig.landing.mode) ───────────────────────
  //
  // Under `enforce` this door is one landPr call: carry-forward, the verdict,
  // CI, deny paths and base freshness (a behind PR is refreshed and lands on
  // its next green). `override` bypasses the review verdict only — exactly
  // what it bypassed before; red CI and a deny path are never overridable.
  // Under `shadow` the call only records what it would have done.
  const landingMode = resolveLandingMode(workspace.gitConfig);
  if (landingMode !== 'off') {
    const missionForPolicy = worker.task?.missionId
      ? await db.query.missions.findFirst({
          where: eq(missions.id, worker.task.missionId),
          columns: RESOLVE_POLICY_MISSION_COLUMNS,
        })
      : null;
    const policy = resolvePolicy(workspace, missionForPolicy ?? null, worker.task ?? null, { baseRef: liveBaseRef });
    const outcome = await landPr({
      workspaceId: worker.workspaceId,
      installationId,
      repoFullName,
      prNumber,
      eventHeadSha: null,
      door: 'dashboard',
      actor: {
        kind: 'human',
        userId: user.id,
        ...(override || sizeOverride || freshnessOverride
          ? {
              override: {
                ...(override ? { verdict: true } : {}),
                ...(sizeOverride ? { size: true } : {}),
                ...(freshnessOverride ? { freshness: true } : {}),
              },
            }
          : {}),
      },
      mode: landingMode,
      policy,
      owner: { taskId: worker.taskId ?? null, workerId: worker.id },
      releaseConfig: workspace.releaseConfig ?? null,
      gitConfig: workspace.gitConfig ?? null,
      ...(expectedVersion !== undefined ? { expectedVersion } : {}),
    });
    if (landingMode === 'enforce') {
      return outcome.kind === 'merged'
        ? finalizeSuccessfulMerge({ missionFinalized: true })
        : dashboardLandingRefusal(outcome);
    }
  }

  // ── Review-verdict gate ─────────────────────────────────────────────────
  //
  // This route used to consult the review verdict at NO tier — its `override`
  // flag existed only for the escalate card, so a plain Merge click landed a
  // PR whose reviewer had just requested changes with nothing recorded.
  //
  // A human may still override; that is what `override: true` means here, and
  // it is now recorded as a `bypassed` row in the gate ledger rather than
  // passing unmarked. The head SHA is read live: `worker.lastCommitSha` lags a
  // push, and lagging in that direction would make a stale verdict look current.
  {
    const reviewGate = await guardReviewVerdict({
      workspaceId: worker.workspaceId,
      prNumber,
      headSha: liveHeadSha,
      surface: 'POST /api/prs/[prNumber]/merge',
      taskId: worker.taskId ?? null,
      workerId: worker.id,
      callerOrigin: 'dashboard',
      carryForward: liveBaseRef ? { installationId, repoFullName, baseRef: liveBaseRef } : null,
    });

    if (reviewGate.blocks) {
      reviewGateReason = reviewGate.reason ?? 'a review verdict blocks this merge';
      const gateDetail = {
        prNumber,
        headSha: liveHeadSha,
        reviewState: reviewGate.state ?? null,
        reviewKind: reviewGate.kind ?? null,
        reviewTaskId: reviewGate.reviewTaskId ?? null,
      };

      if (!override) {
        fireGateEvent({
          gate: GATE_SLUGS.REVIEW_VERDICT,
          surface: 'POST /api/prs/[prNumber]/merge',
          outcome: 'rejected',
          reason: reviewGateReason,
          workspaceId: worker.workspaceId,
          taskId: worker.taskId ?? null,
          workerId: worker.id,
          callerOrigin: 'dashboard',
          detail: gateDetail,
        });
        return NextResponse.json(
          {
            error: `Merge refused: ${reviewGateReason}`,
            reviewGateBlocked: true,
            reviewState: reviewGate.state ?? null,
            reviewKind: reviewGate.kind ?? null,
            clearedBy: reviewGate.clearedBy ?? null,
          },
          { status: 409 },
        );
      }

      // Overridden. Recorded BEFORE the merge attempt: the decision to bypass
      // was made here whether or not GitHub then accepts the merge, and a
      // bypass that only lands on success under-counts exactly the cases worth
      // seeing. Every other guard below still runs unmodified.
      fireGateEvent({
        gate: GATE_SLUGS.REVIEW_VERDICT,
        surface: 'POST /api/prs/[prNumber]/merge',
        outcome: 'bypassed',
        reason: reviewGateReason,
        workspaceId: worker.workspaceId,
        taskId: worker.taskId ?? null,
        workerId: worker.id,
        callerOrigin: 'dashboard',
        detail: { ...gateDetail, overriddenBy: user.email },
      });
    }
  }

  // ── Red CI is never overridable ─────────────────────────────────────────
  // This route used to rely on GitHub's branch protection alone, so a repo
  // without required checks merged straight past a red build. A failing
  // latest run on the live head refuses the merge, with or without
  // `override`. An unreadable check list is left to GitHub, as before.
  {
    let failing: string[] = [];
    try {
      const runs = await githubApi(installationId, `/repos/${repoFullName}/commits/${liveHeadSha}/check-runs?per_page=100`);
      failing = latestRunPerName(Array.isArray(runs?.check_runs) ? runs.check_runs : [])
        .filter((r) => r.conclusion === 'failure' || r.conclusion === 'timed_out')
        .map((r) => r.name);
    } catch (e) {
      console.warn(`[pr-merge] could not read check runs for PR #${prNumber}:`, e);
    }
    if (failing.length > 0) {
      const reason = `CI is red on the PR head: ${failing.join(', ')}`;
      fireGateEvent({
        gate: GATE_SLUGS.MERGE_POLICY,
        surface: 'POST /api/prs/[prNumber]/merge',
        outcome: 'rejected',
        reason,
        workspaceId: worker.workspaceId,
        taskId: worker.taskId ?? null,
        workerId: worker.id,
        callerOrigin: 'dashboard',
        detail: { prNumber, headSha: liveHeadSha, failingChecks: failing, override },
      });
      return NextResponse.json({ error: `Merge refused: ${reason}`, ciFailing: failing }, { status: 409 });
    }
  }

  // ── Post-refresh semantic hold (base-refresh.ts) ───────────────────────
  // Every merge door consults it (docs/specs/base-refresh-classification.md).
  // Under semanticRefresh `enforce`, a refresh that merged in base commits the
  // semantic verdict never saw holds the PR until they are re-verified. With
  // the check off it returns at once with no read, so the default path costs
  // nothing. `override` is the review-verdict override only; a person who
  // wants past a hold merges on GitHub or calls merge_pr with `force`.
  // Before surface ordering, so a held PR never reserves a merge slot.
  {
    const hold = await checkBaseRefreshHold({
      installationId,
      repoFullName,
      prNumber,
      headSha: liveHeadSha,
      taskId: worker.taskId ?? null,
      workspaceId: worker.workspaceId,
      workerId: worker.id,
      missionId: (worker.task as { missionId?: string | null } | null)?.missionId ?? null,
      gitConfig: workspace.gitConfig ?? null,
    });
    if (hold.blocks) {
      return NextResponse.json(
        { error: `Merge held: ${hold.reason}`, semanticHold: true, needsPerson: hold.needsPerson },
        { status: 409 },
      );
    }
  }

  // ── Surface merge ordering (conflict-aware-orchestration.md §3) ─────────
  // A person merging does not silently jump an earlier PR on a serialized
  // surface. Off by default; there is no dashboard override for it.
  const surfaceOrder = await checkSurfaceOrder({
    workspaceId: worker.workspaceId,
    installationId,
    repoFullName,
    prNumber,
    headSha: liveHeadSha,
    gitConfig: workspace.gitConfig ?? null,
    taskId: worker.taskId ?? null,
    workerId: worker.id,
    door: 'dashboard',
    callerOrigin: 'dashboard',
  });
  if (surfaceOrder.blocks) {
    return NextResponse.json(
      { error: `Merge deferred: ${surfaceOrder.reason}`, surfaceOrderBlocked: true, waitingOnPr: surfaceOrder.counterpartPrNumber, surface: surfaceOrder.surface },
      { status: 409 },
    );
  }

  // Perform the merge: the kernel's for a kernel-owned PR, GitHub's directly otherwise.
  const slotted = await mergeInSurfaceSlot(surfaceOrder, async () => {
    const kernel = kernelOwned
      ? await landThroughKernel({
          workspaceId: worker.workspaceId, installationId, repoFullName, prNumber, headSha: liveHeadSha!,
          door: 'dashboard', actor: `human:${user.id}`, mergeMethod: 'squash',
          ...(override && reviewGateReason ? { override: { reason: overrideEscalationReason ?? reviewGateReason } } : {}),
          ...(expectedVersion !== undefined ? { expectedVersion } : {}),
        })
      : null;
    return kernel ? { kernel } : { legacy: await mergePullRequest(installationId, repoFullName, prNumber, 'squash', liveHeadSha!) };
  });
  if ('refused' in slotted) {
    return NextResponse.json({ error: `Merge deferred: ${slotted.refused}`, surfaceOrderBlocked: true }, { status: 409 });
  }
  if (slotted.result.kernel) {
    const k = slotted.result.kernel;
    return k.merged ? finalizeSuccessfulMerge() : kernelLandingRefusal(k);
  }
  const result = slotted.result.legacy;

  if (!result.merged) {
    const rawMessage = result.message ?? '';

    if (result.indeterminate) {
      // GitHub's response was empty, unparseable, or never arrived — we do
      // NOT know whether the merge happened. Re-read the PR's live state
      // rather than assert a rejection we have no evidence for (see
      // docs/specs/action-queue-card-state.md I-1: derive from server state,
      // never from what a failed client-side parse guessed).
      console.error(
        `[pr-merge] indeterminate response merging PR #${prNumber} on ${repoFullName}: ${rawMessage}`,
      );

      let livePr: { merged?: boolean; state?: string } | null = null;
      try {
        livePr = await githubApi(installationId, `/repos/${repoFullName}/pulls/${prNumber}`);
      } catch (e) {
        console.error(`[pr-merge] live-state re-check failed for PR #${prNumber}:`, e);
      }

      if (livePr?.merged) {
        return finalizeSuccessfulMerge();
      }

      const liveState: 'open' | 'unknown' = livePr?.state === 'open' ? 'open' : 'unknown';
      const message = liveState === 'open'
        ? `Lost GitHub's response while merging (${rawMessage || 'empty response'}). The PR is still open, so it's safe to retry.`
        : `Lost GitHub's response while merging (${rawMessage || 'empty response'}), and its current state couldn't be confirmed. Check the PR directly before retrying.`;

      return NextResponse.json({ error: message, indeterminate: true, liveState }, { status: 502 });
    }

    console.error(
      `[pr-merge] GitHub rejected merge of PR #${prNumber} on ${repoFullName}: ${rawMessage}`,
    );

    const failureClass = classifyMergeFailure(rawMessage);

    if (failureClass === 'conflict' && worker.taskId) {
      // Fetch the current head SHA for dedup key
      let headSha = worker.lastCommitSha ?? '';
      if (!headSha) {
        try {
          const prData = await githubApi(installationId, `/repos/${repoFullName}/pulls/${prNumber}`);
          headSha = prData?.head?.sha ?? '';
        } catch {
          headSha = '';
        }
      }

      if (headSha) {
        const dispatchResult = await dispatchConflictRetry({
          workerId: worker.id,
          taskId: worker.taskId,
          prNumber,
          headSha,
          repoFullName,
          workspaceId: worker.workspaceId,
        }).catch(err => {
          console.error(`[pr-merge] conflict-retry dispatch failed for PR #${prNumber}:`, err);
          return { dispatched: false } as import('@/lib/conflict-retry').DispatchConflictRetryResult;
        });

        if (dispatchResult.conflictFalsePositive) {
          // GitHub's conflict flag was stale: the base merged in cleanly.
          // Nothing for an agent to do; the updated head needs its own CI.
          return NextResponse.json(
            {
              error: dispatchResult.branchUpdated
                ? `PR #${prNumber} was flagged as conflicting, but it merges cleanly with its base. The branch was updated; merge once CI passes on the new head.`
                : `PR #${prNumber} was flagged as conflicting, but it already contains its base. Retry the merge.`,
              conflictFalsePositive: true,
              branchUpdated: !!dispatchResult.branchUpdated,
            },
            { status: 409 },
          );
        }
        if (dispatchResult.dispatched) {
          return NextResponse.json(
            {
              error: `PR #${prNumber} has merge conflicts. A conflict-resolution task has been dispatched automatically.`,
              conflictRetryDispatched: true,
              conflictRetryTaskId: dispatchResult.taskId,
            },
            { status: 409 },
          );
        }
        if (dispatchResult.superseded) {
          // escalateSupersession already fired inside dispatchConflictRetry
          return NextResponse.json(
            {
              error: `PR #${prNumber} appears superseded — its changes are already in base. Escalated for human review.`,
              conflictSuperseded: true,
              successorPrNumber: dispatchResult.successorPrNumber ?? null,
            },
            { status: 409 },
          );
        }
        if (dispatchResult.exhausted) {
          await escalateConflictExhaustion(worker.taskId, repoFullName, prNumber, headSha);
          return NextResponse.json(
            {
              error: `PR #${prNumber} has merge conflicts and conflict-resolution retries are exhausted. Manual action required: rebase onto the base branch, resolve conflicts, or abandon this PR.`,
              conflictExhausted: true,
            },
            { status: 409 },
          );
        }
        if (dispatchResult.inFlightTaskId) {
          // A conflict retry is already working this PR: the card shows it,
          // not a Retry that would only re-hit the same conflict.
          return NextResponse.json(
            {
              error: `PR #${prNumber} has merge conflicts. A conflict-resolution task is already in progress.`,
              conflictRetryDispatched: true,
              conflictRetryTaskId: dispatchResult.inFlightTaskId,
            },
            { status: 409 },
          );
        }
        // Anything else (disabled, a refusal, a lost race) falls through to
        // the conflict error below, flagged so the card offers no merge Retry.
      }
    }

    // Map GitHub's opaque errors to actionable copy; keep raw message in server log only.
    const userMessage = /not found/i.test(rawMessage)
      ? 'GitHub could not find the repo or the buildd App lacks access — verify the App is installed on this repo with contents: write permission'
      : failureClass === 'conflict'
      ? `GitHub rejected the merge: PR has merge conflicts. Use "Resolve conflicts" to dispatch an auto-fix, or manually rebase and push.`
      : /method not allowed|405/i.test(rawMessage)
      ? 'PR is not in a mergeable state — check CI status and branch protection rules'
      : `GitHub rejected the merge: ${rawMessage}`;
    // `mergeConflict`: the same merge cannot succeed until the branch changes,
    // so a Retry would only repeat this refusal (lib/merge-outcome.ts).
    return NextResponse.json(
      { error: userMessage, ...(failureClass === 'conflict' ? { mergeConflict: true } : {}) },
      { status: 422 },
    );
  }

  return finalizeSuccessfulMerge();
}
