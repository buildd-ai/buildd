/**
 * Shared auto-merge helpers.
 *
 * Used by:
 *   - apps/web/src/app/api/github/webhook/route.ts (CI-green + no-CI paths)
 *   - apps/web/src/app/api/workers/[id]/route.ts   (reviewer approve path)
 */

import { db } from '@buildd/core/db';
import { tasks, missionNotes } from '@buildd/core/db/schema';
import { eq, and, or, sql, inArray } from 'drizzle-orm';
import { githubApi, mergePullRequest } from '@/lib/github';
import { notifyMissionPrReady } from '@/lib/mission-notifications';
import { notify } from '@/lib/pushover';
import type { MergePolicy } from '@buildd/shared';
import { isGeneratedPath } from '@buildd/shared';
import { inspectPullRequestMigrations } from '@/lib/migration-inspector';
import { isGeneratedMigrationPath } from '@/lib/migration-safety';
import { classifyMergeFailure, dispatchConflictRetry, DEFAULT_MAX_CONFLICT_ITERATIONS } from '@/lib/conflict-retry';
import {
  evaluateModelApproveBound,
  BUILD_PROOF_CHECK_TOKENS,
  type CheckRunState,
  type ModelApproveBound,
} from '@/lib/auto-merge-bound';
import {
  isMissionIntegrationBase,
  type MissionIntegrationFields,
} from '@buildd/core/mission-integration';
import { isReleaseBranchPr } from '@buildd/core/release-strategy';
import type { WorkspaceReleaseConfig } from '@buildd/core/db/schema';
import { guardMissionPrMerge, finalizeMissionPrMerge } from '@/lib/mission-pr';
import { guardReviewVerdict } from '@/lib/review-verdict-gate';
import { fireGateEvent, GATE_SLUGS } from '@/lib/gate-ledger';
import { appendPrActivity } from '@/lib/pr-activity-comment';

/**
 * The base-freshness refusal below: behind the base but not conflicting.
 * Lets the conflict-retry path bring the branch up to date via GitHub instead
 * of an agent. Keyed to that refusal's own wording, which it owns.
 */
export function isBehindBaseRefusal(reason: string): boolean {
  return /^PR is \d+ commits? behind .* — the green CI result was measured against a base that no longer exists/.test(reason);
}

/**
 * Check CI status, deny paths, and diff size for a PR before merging.
 * Returns `{ ok: true }` when all safety rails pass, `{ ok: false, reason }` otherwise.
 *
 * Path checks are routed through the resolved policy:
 *   - tier 1 (auto-threshold): threshold.denyPaths (legacy stored value only)
 *   - tier 2 (agent-review): agentReview.escalateToPaths (legacy stored value
 *     only, treated as block paths here)
 * Both are a read-only fallback, removed next release.
 *
 * ## The aggregate line-count cap is auto-threshold ONLY
 *
 * `threshold` (and its `maxLines`/`maxSourceLines`) is a tier-1 concept — see
 * `MergePolicy` in `@buildd/shared` and `docs/design/merge-policy.md`. The cap
 * is auto-threshold's proxy for "no human or agent has looked at this diff".
 * Under `agent-review` a reviewer has already returned a terminal verdict
 * before this function runs — that verdict IS the judgment the cap stands in
 * for elsewhere — and under `human` a person is the gate. Re-applying the
 * default 800-line cap to either tier would make it structurally unable to
 * ever merge the class of PR it was configured to merge. So the size check
 * below only runs when `policy.tier === 'auto-threshold'`; every other check
 * in this function (CI, denyPaths/escalateToPaths, the migration inspector,
 * the conflict/mergeable-state check) still runs for every tier, unchanged.
 *
 * ## The exemptions from the aggregate line threshold (auto-threshold only)
 *
 * `opts.mission` is the calling worker's mission, and it is read for two
 * decisions, both of which ask `isMissionIntegrationBase` — never a branch-name
 * shape test:
 *
 *  - whether this PR is the mission's integration PR (Option A′), in which
 *    case the AGGREGATE LINE THRESHOLD does not apply. Nothing else is
 *    relaxed — see the comment at the size check;
 *  - whether `opts.bound` may permit an unattended merge (below).
 *
 * `opts.releaseConfig` is the workspace's release config, read for the same
 * AGGREGATE LINE THRESHOLD decision via `isReleaseBranchPr`: a PR from the
 * configured release branch into the configured prod branch (e.g. dev → main)
 * is a rollup of every commit since the last release, each of which was
 * already size-gated on its own way into the release branch — re-applying the
 * cap to the union would make every release unmergeable by policy regardless
 * of review outcome. Nothing else is relaxed, same as Option A′. (Under
 * `agent-review` this exemption is redundant — the tier gate above already
 * exempts the aggregate check — but it stays load-bearing for `auto-threshold`
 * workspaces, which is the only tier it was ever written for.)
 *
 * Omit `opts` and this behaves exactly as it did before either exemption
 * existed.
 *
 * ## The bound (`opts.bound`)
 *
 * Set only when a *model* verdict is driving this merge (the reviewer approve
 * path). It adds the base-ref-keyed rails in `auto-merge-bound.ts` on top of
 * everything below: the mission's own integration branch as base, and positive
 * proof that build/test actually ran green. A CI-green merge under a
 * human-configured policy passes no bound and is unaffected.
 */
export async function evaluateAutoMergeSafety(
  installationId: number,
  repoFullName: string,
  prNumber: number,
  headSha: string,
  policy: Pick<MergePolicy, 'tier' | 'threshold' | 'agentReview'>,
  // One options bag, because the bound now needs the mission row too: the
  // authoritative "is this ref the mission's integration branch" question is
  // asked of `opts.mission`, so a second positional parameter would have to
  // carry a duplicate of what `opts` already holds.
  opts?: {
    mission?: MissionIntegrationFields | null;
    bound?: ModelApproveBound;
    releaseConfig?: WorkspaceReleaseConfig | null;
    /** Gate-ledger attribution for the freshness check below. All optional — omitting them still runs the check, just without workspace/task attribution on the ledger row. */
    workspaceId?: string | null;
    taskId?: string | null;
    workerId?: string | null;
  },
): Promise<{ ok: true } | { ok: false; reason: string }> {
  let checkRuns: CheckRunState[] = [];

  // CI completeness check — verify no check runs are still pending or failing.
  try {
    const checkRunsData = await githubApi(
      installationId,
      `/repos/${repoFullName}/commits/${headSha}/check-runs`,
    );
    checkRuns = checkRunsData?.check_runs ?? [];

    const pendingOrFailed = checkRuns.filter(
      (r) => r.status === 'in_progress' || r.status === 'queued' || r.conclusion === 'failure',
    );
    if (pendingOrFailed.length > 0) {
      return {
        ok: false,
        reason: `CI checks still pending or failed: ${pendingOrFailed.map((r) => r.name).join(', ')}`,
      };
    }

    // Warn if expected named checks are absent — likely means no test suite is
    // configured. Under `bound` the same observation is a hard refusal rather
    // than a log line (see hasBuildProof).
    const runNames = checkRuns.map((r) => r.name.toLowerCase());
    const missingChecks = BUILD_PROOF_CHECK_TOKENS.filter(
      (c) => !runNames.some((n) => n.includes(c)),
    );
    if (missingChecks.length > 0) {
      console.warn(
        `${repoFullName}#${prNumber}: expected CI checks not found (${missingChecks.join(', ')}) — no test suite configured?`,
      );
    }
  } catch (err) {
    // Fail closed. This is the only read that proves CI is green; allowing the
    // merge when it fails means a GitHub API blip silently becomes a merge with
    // no CI verification at all. Refusing parks the PR for a human instead,
    // which is recoverable — an unverified merge into dev is not.
    console.warn(`Could not verify check runs for ${repoFullName}@${headSha}:`, err);
    return {
      ok: false,
      reason: `could not verify CI status — GitHub check-runs lookup failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  // LEGACY FALLBACK (added 2026-09-24, REMOVE NEXT RELEASE — see
  // LEGACY_PATH_FALLBACK_NOTE in @buildd/shared). Hand-written denyPaths /
  // escalateToPaths are refused on every write path; stored values are still
  // honoured here for one release so no workspace silently loses coverage.
  // Risk-class paths are detected, and enforced by the policyConfig tier
  // override upstream, not by this list.
  const denyPaths =
    policy.tier === 'agent-review'
      ? (policy.agentReview?.escalateToPaths ?? [])
      : (policy.threshold?.denyPaths ?? []);
  const maxLines = policy.threshold?.maxLines ?? 800;

  let files: Array<{ filename: string; additions: number; deletions: number }> = [];
  try {
    files = await githubApi(installationId, `/repos/${repoFullName}/pulls/${prNumber}/files?per_page=300`);
  } catch (err) {
    return { ok: false, reason: `could not fetch PR files: ${err instanceof Error ? err.message : 'unknown'}` };
  }
  if (!Array.isArray(files)) {
    return { ok: false, reason: 'malformed PR files response' };
  }

  if (denyPaths.length > 0) {
    const hits = files.flatMap((file) =>
      denyPaths
        .filter((path) => file.filename.startsWith(path))
        .map((path) => ({ file, path })),
    );
    // drizzle/ and schema.ts are gated by the operation-class inspector below,
    // not by an unconditional path block. Ordinary paths still block hard.
    const schemaSpecific = (path: string) =>
      path.includes('drizzle/') || path === 'packages/core/db/schema.ts';
    const ordinaryHit = hits.find((hit) => !schemaSpecific(hit.path));
    if (ordinaryHit) {
      return { ok: false, reason: `touches protected path (${ordinaryHit.file.filename})` };
    }
  }

  // Always classify migration SQL by operation class, independent of denyPaths.
  // EXPAND (additive-only) passes automatically; CONTRACT (destructive) escalates.
  // This runs even when drizzle/ is absent from denyPaths, so removing it from
  // escalateToPaths does not weaken the gate — classification is always performed.
  const hasMigrationOrSchema = files.some(
    (f) => isGeneratedMigrationPath(f.filename) || f.filename === 'packages/core/db/schema.ts',
  );
  if (hasMigrationOrSchema) {
    const migrationSafety = await inspectPullRequestMigrations({
      installationId,
      repoFullName,
      prNumber,
      headSha,
      files,
    });
    if (!migrationSafety.safe) {
      return { ok: false, reason: migrationSafety.reason };
    }
  }

  // Read the PR once. Hoisted above the size check (it also feeds the
  // mergeable_state check below) because the PR's HEAD ref is what identifies
  // the mission integration PR. Both refs are read here: HEAD for the size-gate
  // exemption, BASE for the model-approve bound.
  //
  // An unreadable PR keeps the size gate on and fails closed at the live-head
  // check below. The bound also requires a verified base ref.
  let prData: {
    mergeable_state?: string;
    head?: { ref?: string | null; sha?: string | null };
    base?: { ref?: string | null };
  } | null = null;
  let prReadError: unknown = null;
  try {
    prData = await githubApi(installationId, `/repos/${repoFullName}/pulls/${prNumber}`);
  } catch (err) {
    prReadError = err;
    console.warn(`Could not read PR ${repoFullName}#${prNumber}:`, err);
  }

  // Aggregate line-count cap — auto-threshold tier ONLY (see the function
  // doc comment). `agent-review` and `human` never reach this block, so a
  // workspace on either tier cannot inherit the 800-line default just
  // because `policy.threshold` happened to be unset.
  if (policy.tier === 'auto-threshold') {
    // Is this the mission's integration PR (integration branch → trunk)?
    //
    // `isMissionIntegrationBase` asks "is this ref the mission's integration
    // branch"; for the mission PR the ref of interest is its HEAD, since its BASE
    // is trunk. Authoritative predicate rather than the `mission/` shape
    // heuristic: the only caller can reach the mission row, and a false positive
    // here would drop the size gate for any branch that merely looks like a
    // mission branch. An unknown head ref or a mission that has not opted in is
    // false, so nothing changes for a mission that is not using Option A′.
    const isMissionIntegrationPr = isMissionIntegrationBase({
      baseRef: prData?.head?.ref ?? null,
      mission: opts?.mission ?? null,
    });

    // Is this the workspace's release-branch → prod-branch PR (e.g. dev → main)?
    // Unlike the mission check above, this compares BOTH refs — a release PR's
    // own head and base are both configured (releaseBranch, prodBranch), so
    // there is no single trunk-base assumption to lean on.
    const isReleasePr = isReleaseBranchPr(opts?.releaseConfig ?? null, {
      headRef: prData?.head?.ref ?? null,
      baseRef: prData?.base?.ref ?? null,
    });

    const LOCKFILE_PATTERNS = [/\.lock$/, /^bun\.lockb$/];
    const sourceFiles = files.filter(
      (f) => !isGeneratedPath(f.filename) && !LOCKFILE_PATTERNS.some((p) => p.test(f.filename)),
    );
    const totalLines = sourceFiles.reduce((sum, f) => sum + (f.additions || 0) + (f.deletions || 0), 0);
    // Option A′: the AGGREGATE line threshold does not apply to a mission
    // integration PR. That PR is the union of every task diff in the mission, and
    // each of those diffs was already size-gated when it merged into the
    // integration branch — 800 lines is the right granularity per task, and
    // re-applying it to the union double-counts a check that already passed.
    // Under the DEFAULT policy the union is over the cap essentially by
    // construction, which would make every mission PR unmergeable by the platform
    // and reduce "the tier applies at the mission PR" to a claim that only holds
    // for operators who explicitly configured a tier.
    //
    // The same reasoning applies to the workspace's release PR (dev → main):
    // it bundles every commit merged since the last release, each already
    // size-gated on its own way into the release branch, so the union is over
    // the cap essentially by construction and every release would otherwise
    // need a human to merge_pr regardless of review outcome.
    //
    // ONLY the aggregate size gate is exempt for either. Everything else in this
    // function still runs, unchanged and in the same order: CI-green
    // (fail-closed if unverifiable), denyPaths / escalateToPaths, the migration
    // operation-class inspector, and the conflict / branch-protection checks.
    if ((isMissionIntegrationPr || isReleasePr) && totalLines > maxLines) {
      const exemption = isMissionIntegrationPr ? 'mission integration PR' : 'release PR';
      console.log(
        `[auto-merge] ${repoFullName}#${prNumber}: ${exemption} — aggregate size gate not applied ` +
          `(${totalLines} source lines > limit ${maxLines}); each underlying commit was size-gated on the way in`,
      );
    } else if (totalLines > maxLines) {
      const limitSource = policy.threshold?.maxLines != null ? 'configured' : 'default';
      return {
        ok: false,
        reason: `auto-threshold tier: diff size ${totalLines} source lines > ${limitSource} limit ${maxLines} (${files.length - sourceFiles.length} noise files excluded)`,
      };
    }
  }

  // Conflict detection — check GitHub's mergeable_state before attempting merge.
  // 'dirty' = conflicts with base; 'blocked' = branch protection or review required.
  // 'unknown' means GitHub is still computing — defer that conflict decision
  // to GitHub's merge API. The live head must still be verified below.
  const mergeableState = prData?.mergeable_state;
  if (mergeableState === 'dirty') {
    return { ok: false, reason: `PR has conflicts (mergeable_state: dirty) — needs rebase onto base branch` };
  }
  if (mergeableState === 'blocked') {
    return { ok: false, reason: `PR is blocked (mergeable_state: blocked) — branch protection or review required` };
  }

  // Base freshness — CI proof is a claim about headSha, not about "this PR is
  // safe to merge right now". `dev` has no GitHub-side branch protection, so
  // `mergeable_state` never reports `behind` here (that value only appears
  // under a "require branches up to date" rule) — this is the only signal
  // that catches a base which has moved since headSha's checks ran. Compare
  // by SHA ancestry, not by timestamp: if headSha is behind the base branch's
  // current tip, then no run against headSha — however recent — has ever
  // seen the commits now on base, and "green" proves nothing about the tree
  // this merge would actually produce.
  //
  // Phrased with the same "needs rebase" suffix `dirty` uses above so
  // `classifyMergeFailure` routes this refusal through the identical
  // conflict-retry path: a same-branch task merges the base in (a clean
  // fast-forward here, same mechanics as a real conflict) and pushes, which
  // re-triggers CI on a head that is fresh — the PR converges on its own
  // instead of sitting refused for a human to notice.
  if (prData?.base?.ref) {
    let freshness: { behind_by?: number } | null = null;
    let freshnessError: unknown = null;
    try {
      freshness = await githubApi(
        installationId,
        `/repos/${repoFullName}/compare/${encodeURIComponent(prData.base.ref)}...${headSha}`,
      );
    } catch (err) {
      freshnessError = err;
      console.warn(`[auto-merge] could not verify base freshness for ${repoFullName}#${prNumber}:`, err);
    }
    if (freshness && typeof freshness.behind_by === 'number' && freshness.behind_by > 0) {
      const reason =
        `PR is ${freshness.behind_by} commit${freshness.behind_by === 1 ? '' : 's'} behind ` +
        `${prData.base.ref} — the green CI result was measured against a base that no longer ` +
        `exists, needs rebase onto base branch`;
      fireGateEvent({
        gate: GATE_SLUGS.MERGE_BASE_FRESHNESS,
        surface: 'auto-merge',
        outcome: 'rejected',
        reason,
        workspaceId: opts?.workspaceId ?? null,
        taskId: opts?.taskId ?? null,
        workerId: opts?.workerId ?? null,
        callerOrigin: 'system',
        detail: { prNumber, headSha, baseRef: prData.base.ref, behindBy: freshness.behind_by },
      });
      return { ok: false, reason };
    }
    if (!freshness && freshnessError) {
      // Fail closed like the CI-check read above — but NOT phrased with
      // "needs rebase": we don't actually know the base moved, only that we
      // could not check, so routing this into the conflict-retry rebase flow
      // would waste an iteration on a PR that may already be current. It
      // parks for the next webhook to re-evaluate, same as any other
      // transient GitHub read failure in this function.
      return {
        ok: false,
        reason: `could not verify base freshness — GitHub compare lookup failed: ${
          freshnessError instanceof Error ? freshnessError.message : String(freshnessError)
        }`,
      };
    }
  }

  if (opts?.bound) {
    if (!prData) {
      // Fail closed: without the base ref there is no bound to enforce, and an
      // unbounded model-driven merge is the thing this rail exists to prevent.
      return {
        ok: false,
        reason: `could not verify the PR base ref — GitHub PR lookup failed: ${
          prReadError instanceof Error ? prReadError.message : String(prReadError)
        }`,
      };
    }
    // BASE ref here, HEAD ref for the size-gate exemption above — the same
    // question ("is this ref the mission's integration branch") asked about the
    // two different PRs in the topology. The mission PR runs integration branch
    // → trunk, so its integration branch is its HEAD; a task PR runs task
    // branch → integration branch, so its integration branch is its BASE.
    const verdict = evaluateModelApproveBound({
      baseRef: prData.base?.ref,
      mission: opts.mission ?? null,
      protectedBranches: opts.bound.protectedBranches,
      checkRuns,
    });
    if (!verdict.permitted) {
      return { ok: false, reason: verdict.reason };
    }
  }

  // The event/reviewer SHA must still identify the live PR. Otherwise a late
  // success for A could treat B's rejecting review as superseded and merge B.
  if (!headSha || !prData?.head?.sha) {
    return { ok: false, reason: 'could not verify the live PR head — refusing the merge' };
  }
  if (prData.head.sha !== headSha) {
    return { ok: false, reason: 'PR head changed — ignoring stale merge trigger' };
  }

  return { ok: true };
}

/**
 * Enforce safety rails, then squash-merge the PR.
 * On a conflict (dirty mergeable_state), auto-dispatch a same-branch retry task.
 * On other rail violations, notify the mission feed instead of merging.
 *
 * Pass `bound` when a model `approve` verdict is what authorises this merge —
 * see `auto-merge-bound.ts`. Omitting it means "CI green under a policy a human
 * configured", which is not bounded by base ref.
 *
 * Returns whether the merge actually landed, and — when it did not — the
 * reason, so a caller that has a second, differently-authorised path to try
 * (the reviewer approve handler falling back to the unbounded self-merge
 * check after the bounded attempt is refused) knows whether to bother.
 */
export async function tryAutoMergeWorkerPr(params: {
  installationId: number;
  repoFullName: string;
  prNumber: number;
  headSha: string;
  worker: { id: string; taskId: string | null; workspaceId?: string };
  policy: MergePolicy;
  bound?: ModelApproveBound;
}): Promise<{ merged: boolean; reason?: string }> {
  const { installationId, repoFullName, prNumber, headSha, worker, policy, bound } = params;

  // One mission read serves both callers of it inside the safety rails: the
  // size-gate exemption and, when a model verdict authorised this merge, the
  // bound's base-ref test.
  const mission = await loadMissionIntegrationFields(worker.taskId);
  const safetyCheck = await evaluateAutoMergeSafety(
    installationId,
    repoFullName,
    prNumber,
    headSha,
    policy,
    { mission, bound, workspaceId: worker.workspaceId ?? null, taskId: worker.taskId, workerId: worker.id },
  );
  if (!safetyCheck.ok) {
    console.log(`Auto-merge blocked for ${repoFullName}#${prNumber}: ${safetyCheck.reason}`);

    // Conflict path: dispatch a same-branch retry rather than asking the human.
    if (classifyMergeFailure(safetyCheck.reason) === 'conflict' && worker.taskId) {
      const workspaceId = worker.workspaceId ?? await resolveWorkspaceId(worker.taskId);
      if (workspaceId) {
        const dispatchResult = await dispatchConflictRetry({
          workerId: worker.id,
          taskId: worker.taskId,
          prNumber,
          headSha,
          repoFullName,
          workspaceId,
          behindOnly: isBehindBaseRefusal(safetyCheck.reason),
        }).catch(err => {
          console.error(`[auto-merge] conflict-retry dispatch failed for PR #${prNumber}:`, err);
          return { dispatched: false } as import('@/lib/conflict-retry').DispatchConflictRetryResult;
        });
        if (dispatchResult.dispatched) return { merged: false, reason: safetyCheck.reason };
        if (dispatchResult.superseded) {
          // Supersession detected — escalateSupersession already fired inside dispatch
          return { merged: false, reason: safetyCheck.reason };
        }
        if (dispatchResult.disabled) {
          // Feature disabled — fall through to mission notification so human sees it
        } else if (dispatchResult.exhausted) {
          // Cap reached — escalate to human with a real decision
          await escalateConflictExhaustion(worker.taskId, repoFullName, prNumber, headSha);
          return { merged: false, reason: safetyCheck.reason };
        } else {
          // Duplicate dedup hit — already handling it
          return { merged: false, reason: safetyCheck.reason };
        }
      }
    }

    // Non-conflict or disabled auto-resolve — notify the mission feed
    if (worker.taskId) {
      const task = await db.query.tasks.findFirst({
        where: eq(tasks.id, worker.taskId),
        columns: { missionId: true, title: true },
      });
      if (task?.missionId) {
        await notifyMissionPrReady(task.missionId, {
          title: 'Auto-merge blocked — review needed',
          prUrl: `https://github.com/${repoFullName}/pull/${prNumber}`,
          prNumber,
          headSha,
          reason: 'auto_merge_blocked',
          message: `${task.title} — ${safetyCheck.reason}`,
        });
      }
    }
    return { merged: false, reason: safetyCheck.reason };
  }

  // Review-verdict gate — the same rule every other merge door enforces.
  //
  // This is the unattended path, so it is the one that used to let a finding be
  // outrun: `evaluateAutoMergeSafety` covers CI, deny paths, size and
  // migrations, and asks nothing about the review. Under `agent-review` the
  // CALLERS happened to check for an approve first; under `auto-threshold` —
  // which is every Option A′ task PR, all of which get a reviewer dispatched by
  // `requestIntegrationBranchReview` — nothing did.
  //
  // No override here by construction: nothing unattended may bypass a verdict.
  // A human override lives on the dashboard route, where a person is present.
  const reviewWorkspaceId = worker.workspaceId ?? (worker.taskId ? await resolveWorkspaceId(worker.taskId) : null);
  if (reviewWorkspaceId) {
    const reviewGate = await guardReviewVerdict({
      workspaceId: reviewWorkspaceId,
      prNumber,
      headSha,
      surface: 'auto-merge',
      taskId: worker.taskId ?? null,
      workerId: worker.id ?? null,
      callerOrigin: 'system',
    });
    if (reviewGate.blocks) {
      const reason = `${reviewGate.reason}. ${reviewGate.clearedBy}`;
      console.log(`Auto-merge blocked for ${repoFullName}#${prNumber}: ${reason}`);
      fireGateEvent({
        gate: GATE_SLUGS.REVIEW_VERDICT,
        surface: 'auto-merge',
        outcome: 'deferred',
        reason: reviewGate.reason ?? 'review verdict blocks this merge',
        workspaceId: reviewWorkspaceId,
        taskId: worker.taskId ?? null,
        workerId: worker.id ?? null,
        callerOrigin: 'system',
        detail: {
          prNumber,
          headSha,
          reviewState: reviewGate.state ?? null,
          reviewKind: reviewGate.kind ?? null,
          reviewTaskId: reviewGate.reviewTaskId ?? null,
        },
      });
      return { merged: false, reason };
    }
  }

  // Mission-PR branch-lifecycle gate (P3) — same rule as the manual merge_pr
  // route: refuse to merge the mission PR while a sibling task PR based on
  // the integration branch is still open, since merging deletes that branch.
  const mergingTask = worker.taskId
    ? await db.query.tasks.findFirst({
        where: eq(tasks.id, worker.taskId),
        columns: { id: true, title: true, taskClass: true, missionId: true },
      })
    : null;
  const mergeGate = await guardMissionPrMerge(mergingTask);
  if (mergeGate.blocks) {
    console.log(`Auto-merge blocked for ${repoFullName}#${prNumber}: ${mergeGate.reason}`);
    return { merged: false, reason: mergeGate.reason };
  }

  const result = await mergePullRequest(installationId, repoFullName, prNumber, 'squash', headSha);
  if (result.merged) {
    console.log(`Auto-merged PR #${prNumber} on ${repoFullName} for worker ${worker.id}`);
    await finalizeMissionPrMerge(mergingTask, installationId, repoFullName);
    return { merged: true };
  }

  console.warn(`Failed to auto-merge PR #${prNumber} on ${repoFullName}: ${result.message}`);
  // Handle race-condition conflict (PR was clean at eval time but dirty at merge time)
  if (classifyMergeFailure(result.message) === 'conflict' && worker.taskId) {
    const workspaceId = worker.workspaceId ?? await resolveWorkspaceId(worker.taskId);
    if (workspaceId) {
      const dispatchResult = await dispatchConflictRetry({
        workerId: worker.id,
        taskId: worker.taskId,
        prNumber,
        headSha,
        repoFullName,
        workspaceId,
      }).catch(err => {
        console.error(`[auto-merge] conflict-retry dispatch failed for PR #${prNumber}:`, err);
        return { dispatched: false } as import('@/lib/conflict-retry').DispatchConflictRetryResult;
      });
      if (dispatchResult.superseded) {
        // Supersession detected — escalateSupersession already fired inside dispatch
      } else if (dispatchResult.exhausted && worker.taskId) {
        await escalateConflictExhaustion(worker.taskId, repoFullName, prNumber, headSha);
      }
    }
  }
  return { merged: false, reason: result.message };
}

/**
 * The mission integration fields for a worker's task, or null.
 *
 * One read on the merge path, so `evaluateAutoMergeSafety` can use the
 * authoritative `isMissionIntegrationBase` instead of the `mission/` shape
 * heuristic for both of the decisions that ask it: whether the aggregate size
 * gate applies, and whether a model-authorised merge is landing somewhere
 * quarantined. Fails soft to null, and null means "not a mission integration
 * PR" — every gate then applies exactly as it did before Option A′, and a bound
 * merge is refused outright.
 */
async function loadMissionIntegrationFields(
  taskId: string | null,
): Promise<MissionIntegrationFields | null> {
  if (!taskId) return null;
  try {
    const task = await db.query.tasks.findFirst({
      where: eq(tasks.id, taskId),
      columns: { id: true },
      with: { mission: { columns: { workingBranch: true, integrationBranchEnabled: true } } },
    });
    return (task as { mission?: MissionIntegrationFields | null } | undefined)?.mission ?? null;
  } catch (err) {
    console.warn(`[auto-merge] could not resolve mission for task ${taskId}:`, err);
    return null;
  }
}

async function resolveWorkspaceId(taskId: string): Promise<string | null> {
  const task = await db.query.tasks.findFirst({
    where: eq(tasks.id, taskId),
    columns: { workspaceId: true },
  });
  return task?.workspaceId ?? null;
}

/**
 * Emit escalation when conflict-retry attempts are exhausted.
 *
 * Idempotent: atomic CAS on tasks.context.conflictExhaustedHeadSha ensures
 * exactly one Pushover and one reviewer_escalated note per (taskId, headSha),
 * even when concurrent webhooks or retried requests trigger this simultaneously.
 *
 * Exported so it can be called from all merge paths (auto-merge, MCP merge_pr,
 * human-triggered merge) without writing parallel escalation logic.
 */
export async function escalateConflictExhaustion(
  taskId: string,
  repoFullName: string,
  prNumber: number,
  headSha: string,
): Promise<void> {
  const task = await db.query.tasks.findFirst({
    where: eq(tasks.id, taskId),
    columns: { id: true, missionId: true, title: true, context: true },
  });
  if (!task) return;

  // Atomic dedup: only one escalation per (taskId, headSha)
  const [claimed] = await db
    .update(tasks)
    .set({
      context: sql`COALESCE(context, '{}'::jsonb) || jsonb_build_object('conflictExhaustedHeadSha', ${headSha}::text)`,
    })
    .where(
      and(
        eq(tasks.id, taskId),
        or(
          sql`context IS NULL`,
          sql`context->>'conflictExhaustedHeadSha' IS NULL`,
          sql`context->>'conflictExhaustedHeadSha' != ${headSha}`,
        ),
      ),
    )
    .returning({ id: tasks.id });

  if (!claimed) {
    console.log(`[conflict-retry] escalation already fired for task ${taskId} PR #${prNumber}@${headSha.slice(0, 7)}`);
    return;
  }

  const ctx = (task.context ?? {}) as Record<string, unknown>;
  const maxIterations =
    typeof ctx.maxConflictIterations === 'number'
      ? ctx.maxConflictIterations
      : DEFAULT_MAX_CONFLICT_ITERATIONS;
  const prUrl = `https://github.com/${repoFullName}/pull/${prNumber}`;
  const taskUrl = `${process.env.NEXT_PUBLIC_APP_URL ?? 'https://buildd.dev'}/app/tasks/${taskId}`;

  // Create reviewer_escalated note → surfaces the PR in the "Waiting on You" inbox
  if (task.missionId) {
    await db.insert(missionNotes).values({
      missionId: task.missionId,
      taskId: task.id,
      authorType: 'system',
      type: 'reviewer_escalated',
      title: `PR #${prNumber} — conflict retries exhausted (${maxIterations}/${maxIterations})`,
      body: `Attempted ${maxIterations} time${maxIterations === 1 ? '' : 's'} to resolve merge conflicts automatically — still conflicted.\n\nChoose one:\n- **Resolve conflicts** — rebase the branch and re-dispatch\n- **Close as superseded** — close this PR and open a fresh one\n- **Abandon PR** — close without replacement`,
      status: 'open',
    });
  }

  // Fire Pushover regardless of mission membership
  notify({
    app: 'tasks',
    title: `PR #${prNumber}: conflict retries exhausted`,
    message: `${task.title}\n${maxIterations} attempt${maxIterations === 1 ? '' : 's'} failed — still has merge conflicts.\nResolve, close as superseded, or abandon.`,
    url: taskUrl,
    urlTitle: 'View task',
    priority: 0,
  });

  console.log(`[conflict-retry] escalated PR #${prNumber}@${headSha.slice(0, 7)} for task ${taskId}`);
}

/**
 * Emit escalation when reviewer-requested-changes retries are exhausted.
 *
 * Idempotent: CAS on tasks.context.reviewerExhaustedHeadSha — fires at most
 * once per (taskId, headSha). A new headSha after a push resets the guard so
 * a fresh review cycle can escalate independently.
 *
 * Exported alongside escalateConflictExhaustion to share the same doctrine:
 * machine-detected blocker → reviewer_escalated note + Pushover, never silence.
 */
export async function escalateReviewerExhaustion(
  taskId: string,
  repoFullName: string,
  prNumber: number,
  headSha: string,
  maxIterations: number,
  lastFeedback: string | null | undefined,
): Promise<void> {
  const task = await db.query.tasks.findFirst({
    where: eq(tasks.id, taskId),
    columns: { id: true, missionId: true, title: true, context: true },
  });
  if (!task) return;

  // Atomic dedup: only one escalation per (taskId, headSha)
  const [claimed] = await db
    .update(tasks)
    .set({
      context: sql`COALESCE(context, '{}'::jsonb) || jsonb_build_object('reviewerExhaustedHeadSha', ${headSha}::text)`,
    })
    .where(
      and(
        eq(tasks.id, taskId),
        or(
          sql`context IS NULL`,
          sql`context->>'reviewerExhaustedHeadSha' IS NULL`,
          sql`context->>'reviewerExhaustedHeadSha' != ${headSha}`,
        ),
      ),
    )
    .returning({ id: tasks.id });

  if (!claimed) {
    console.log(`[reviewer] escalation already fired for task ${taskId} PR #${prNumber}@${headSha.slice(0, 7)}`);
    return;
  }

  const prUrl = `https://github.com/${repoFullName}/pull/${prNumber}`;
  const taskUrl = `${process.env.NEXT_PUBLIC_APP_URL ?? 'https://buildd.dev'}/app/tasks/${taskId}`;

  if (task.missionId) {
    await db.insert(missionNotes).values({
      missionId: task.missionId,
      taskId: task.id,
      authorType: 'system',
      type: 'reviewer_escalated',
      title: `PR #${prNumber} — reviewer retries exhausted (${maxIterations}/${maxIterations})`,
      body: `Reviewer requested changes ${maxIterations} time${maxIterations === 1 ? '' : 's'} — automated fix attempts exhausted. Human review required.\n\n${lastFeedback ? `Last feedback: ${lastFeedback}` : ''}\n\nPR: ${prUrl}`,
      status: 'open',
    });
  }

  notify({
    app: 'tasks',
    title: `PR #${prNumber}: reviewer retries exhausted`,
    message: `${task.title}\n${maxIterations} reviewer fix attempt${maxIterations === 1 ? '' : 's'} failed — human review required.`,
    url: taskUrl,
    urlTitle: 'View task',
    priority: 0,
  });

  console.log(`[reviewer] exhaustion escalated PR #${prNumber}@${headSha.slice(0, 7)} for task ${taskId}`);
}

/**
 * Emit escalation when a reviewer task permanently fails the review contract
 * (ended without a structuredOutput.verdict — dropped as prose, or the
 * session never reached `complete_task` at all — and the bounded retry in
 * apps/web/src/app/api/workers/[id]/route.ts's `reviewContractViolation`
 * guard has already been exhausted).
 *
 * A reviewer task is dispatched only on the webhook's `pull_request: opened`
 * action (see reviewer.ts) — nothing else re-reviews an existing PR/head SHA.
 * Without this, the PR sits unreviewed forever with only `get_pr_review`
 * reporting `review_failed`/terminal to whoever happens to poll it.
 *
 * Idempotent: CAS on tasks.context.reviewContractFailureEscalated — fires at
 * most once per task (this is a single-shot terminal failure, not a per-head
 * -SHA retry loop like escalateReviewerExhaustion above).
 *
 * Also posts a `review_failed` entry to the PR's own activity comment. Before
 * this, the comment stopped at "🔍 Reviewing changes" forever — the ONLY
 * places this failure was recorded were a mission note (skipped entirely for
 * a mission-less task) and a Pushover alert a human could easily miss. A
 * human watching the PR itself, with no indication the review had already
 * died, had every reason to just merge it by hand.
 */
export async function escalateReviewContractFailure(params: {
  taskId: string;
  repoFullName: string;
  prNumber: number;
  headSha: string;
  installationId: number;
}): Promise<void> {
  const { taskId, repoFullName, prNumber, headSha, installationId } = params;

  const task = await db.query.tasks.findFirst({
    where: eq(tasks.id, taskId),
    columns: { id: true, missionId: true, title: true, workspaceId: true },
  });
  if (!task) return;

  // Atomic dedup: only one escalation per task.
  const [claimed] = await db
    .update(tasks)
    .set({
      context: sql`COALESCE(context, '{}'::jsonb) || jsonb_build_object('reviewContractFailureEscalated', true)`,
    })
    .where(and(
      eq(tasks.id, taskId),
      or(
        sql`context IS NULL`,
        sql`context->>'reviewContractFailureEscalated' IS NULL`,
      ),
    ))
    .returning({ id: tasks.id });

  if (!claimed) {
    console.log(`[reviewer] contract-failure escalation already fired for task ${taskId}`);
    return;
  }

  const prUrl = repoFullName && prNumber ? `https://github.com/${repoFullName}/pull/${prNumber}` : null;
  const taskUrl = `${process.env.NEXT_PUBLIC_APP_URL ?? 'https://buildd.dev'}/app/tasks/${taskId}`;

  if (task.missionId) {
    await db.insert(missionNotes).values({
      missionId: task.missionId,
      taskId: task.id,
      authorType: 'system',
      type: 'reviewer_escalated',
      title: prNumber ? `PR #${prNumber} — review never produced a verdict` : 'Review never produced a verdict',
      body: `The reviewer agent's session ended without returning a structuredOutput.verdict, twice — the automated retry was exhausted. Nothing re-dispatches a reviewer for this PR outside its original open event, so it will sit unreviewed until a human acts.\n\n${prUrl ? `PR: ${prUrl}` : ''}`,
      status: 'open',
    });
  }

  notify({
    app: 'tasks',
    title: prNumber ? `PR #${prNumber}: review never produced a verdict` : 'Review never produced a verdict',
    message: `${task.title}\nReviewer retries exhausted with no verdict — human review required.`,
    url: taskUrl,
    urlTitle: 'View task',
    priority: 0,
  });

  if (prNumber && repoFullName && installationId) {
    await appendPrActivity({
      installationId,
      repoFullName,
      prNumber,
      entry: { kind: 'review_failed' },
      workspaceId: task.workspaceId ?? null,
    }).catch((err) => console.error(
      `[reviewer] failed to post review_failed activity for PR #${prNumber}:`, err,
    ));
  }

  fireGateEvent({
    gate: GATE_SLUGS.REVIEW_VERDICT,
    surface: 'review-contract-guard',
    outcome: 'warned',
    reason: 'the reviewer permanently failed to produce a verdict for this PR — retries exhausted, escalated to a human',
    workspaceId: task.workspaceId ?? null,
    taskId,
    callerOrigin: 'system',
    detail: { prNumber, headSha: headSha || null },
  });

  console.log(`[reviewer] contract-failure escalated${prNumber ? ` PR #${prNumber}` : ''}@${headSha ? headSha.slice(0, 7) : '?'} for task ${taskId}`);
}

/**
 * Returns true when an active (pending/assigned/in_progress) reviewer-dispatched
 * fix task already exists for the given PR.
 *
 * Call this guard in `sweepDeadZonePrs` (and any other sweep that might try to
 * spark a fix task) to prevent two agents landing on the same branch concurrently.
 */
export async function hasActiveReviewerFixTask(
  workspaceId: string,
  prNumber: number,
): Promise<boolean> {
  const existing = await db.query.tasks.findFirst({
    where: and(
      eq(tasks.workspaceId, workspaceId),
      eq(tasks.reviewerRetryPrNumber, prNumber),
      inArray(tasks.status, ['pending', 'assigned', 'in_progress']),
    ),
    columns: { id: true },
  });
  return existing != null;
}

export { escalateSupersession } from '@/lib/conflict-retry';
