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
import type { KernelLanding, LandingInput } from '@/lib/workflow/seam';
import { notifyMissionPrReady } from '@/lib/mission-notifications';
import { notifyTeamOf } from '@/lib/notify';
import type { MergePolicy } from '@buildd/shared';
import { isGeneratedPath } from '@buildd/shared';
import { inspectPullRequestMigrations } from '@/lib/migration-inspector';
import { effectiveDeltaFiles, refreshDeltaBase, resolveMergeMethod } from '@/lib/integration-refresh';
import { isGeneratedMigrationPath } from '@/lib/migration-safety';
import { classifyMergeFailure, dispatchConflictRetry } from '@/lib/conflict-retry';
import { policyValue } from '@/lib/policy-overrides';
import {
  evaluateModelApproveBound,
  BUILD_PROOF_CHECK_TOKENS,
  latestRunPerName,
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
import { checkSurfaceOrder, mergeInSurfaceSlot } from '@/lib/surface-ordering-door';
import { checkBaseRefreshHold } from '@/lib/base-refresh';
import { dispatchStaleApprovalReReview } from '@/lib/stale-approval-re-review';
import type { DispatchConflictRetryResult } from '@/lib/conflict-retry';
import { refreshCause } from '@/lib/refresh-cause';
import type { WorkspaceGitConfig } from '@buildd/core/db/schema';

/**
 * The base-freshness refusal below: behind the base but not conflicting.
 * Lets the conflict-retry path bring the branch up to date via GitHub instead
 * of an agent. Keyed to that refusal's own wording, which it owns.
 */
export function isBehindBaseRefusal(reason: string): boolean {
  return /^PR is \d+ commits? behind .* — the green CI result was measured against a base that no longer exists/.test(reason);
}

export type AutoMergeRefusalClass =
  | 'ci' | 'deny_path' | 'migration' | 'size' | 'conflict' | 'blocked'
  | 'base_freshness' | 'model_bound' | 'stale_head' | 'github_read' | 'semantic_hold' | 'other';

/**
 * Which safety rail an `evaluateAutoMergeSafety` refusal came from, for the
 * gate ledger's `detail.reasonClass`. Keyed off the reason strings that
 * function returns; an unrecognised one is `other`, never dropped.
 */
export function classifyAutoMergeRefusal(reason: string): AutoMergeRefusalClass {
  if (isBehindBaseRefusal(reason)) return 'base_freshness';
  if (/^CI checks |could not verify CI status/.test(reason)) return 'ci';
  if (/^touches protected path/.test(reason)) return 'deny_path';
  if (/migration/i.test(reason)) return 'migration';
  if (/diff size \d+/.test(reason)) return 'size';
  if (/mergeable_state: dirty/.test(reason)) return 'conflict';
  if (/mergeable_state: blocked/.test(reason)) return 'blocked';
  if (/^model approve:/.test(reason)) return 'model_bound';
  if (/PR head changed|live PR head/.test(reason)) return 'stale_head';
  if (/^could not (fetch|verify)|^malformed PR files/.test(reason)) return 'github_read';
  if (/^semantic hold \(/.test(reason)) return 'semantic_hold';
  return 'other';
}

/** Refusal classes a later webhook re-evaluates on its own: a wait, not a no. */
const TRANSIENT_REFUSALS: ReadonlySet<AutoMergeRefusalClass> = new Set(['ci', 'stale_head', 'github_read']);


/**
 * `pulls/{n}/files` is GitHub's cached PR diff: after the head is refreshed
 * onto a newer base it can keep the older merge base and an expanded file
 * list (files that only differ because the base moved). A live compare of the
 * current base tip against the head is the diff a merge would produce. Returns
 * null when it cannot be read, so callers keep the snapshot verdict.
 */
async function fetchLiveChangedFilenames(
  installationId: number,
  repoFullName: string,
  prNumber: number,
  headSha: string,
): Promise<Set<string> | null> {
  try {
    const pr = await githubApi(installationId, `/repos/${repoFullName}/pulls/${prNumber}`);
    const baseRef = pr?.base?.ref;
    if (!baseRef) return null;
    const cmp = await githubApi(
      installationId,
      `/repos/${repoFullName}/compare/${encodeURIComponent(baseRef)}...${headSha}?per_page=300`,
    );
    if (!Array.isArray(cmp?.files) || cmp.files.length >= 300) return null;
    return new Set(cmp.files.map((f: { filename: string }) => f.filename));
  } catch (err) {
    console.warn(`[auto-merge] live compare failed for ${repoFullName}#${prNumber}:`, err);
    return null;
  }
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
 *  - whether this is a task PR into the mission's own integration branch
 *    (its BASE ref), in which case the AGGREGATE LINE THRESHOLD does not
 *    apply: under branchStrategy "mission-branch" the tier, cap included,
 *    applies once, at the mission-to-trunk PR. Nothing else is relaxed — see
 *    the comment at the size check;
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
    /**
     * Skip the base-freshness block below. The landing function (`pr-landing.ts`)
     * owns "behind base" as work to do (update the branch, bounded by the
     * treadmill rule), so it asks this check every question except that one and
     * measures the gap itself.
     */
    skipBaseFreshness?: boolean;
    /**
     * The workspace gitConfig, for the post-refresh semantic hold
     * (base-refresh.ts `checkBaseRefreshHold`). Every merge door passes it;
     * omitted, or with `semanticRefresh` off, the hold makes no read.
     */
    gitConfig?: WorkspaceGitConfig | null;
    /** Out-param: facts this check read from the live PR, so a caller does not re-read them. Filled as soon as the PR is read, before any rail can refuse. */
    observed?: {
      baseRef?: string | null;
      headRef?: string | null;
      mergeableState?: string | null;
      checkRuns?: CheckRunState[];
    };
  },
): Promise<{ ok: true } | { ok: false; reason: string }> {
  let checkRuns: CheckRunState[] = [];

  // CI completeness check — verify no check runs are still pending or failing.
  try {
    const checkRunsData = await githubApi(
      installationId,
      `/repos/${repoFullName}/commits/${headSha}/check-runs`,
    );
    checkRuns = latestRunPerName(checkRunsData?.check_runs ?? []);
    if (opts?.observed) opts.observed.checkRuns = checkRuns;

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

  // Post-refresh semantic hold (conflict-aware-orchestration.md §4): a refresh
  // can merge in base commits that landed after its semantic verdict. Under
  // enforce the PR waits here until that arrived range is re-verified. Only
  // consulted once CI is green, and makes no read when the check is off.
  const hold = await checkBaseRefreshHold({
    installationId,
    repoFullName,
    prNumber,
    headSha,
    taskId: opts?.taskId ?? null,
    workspaceId: opts?.workspaceId ?? null,
    workerId: opts?.workerId ?? null,
    gitConfig: opts?.gitConfig,
  });
  if (hold.blocks) return { ok: false, reason: hold.reason };

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

  // An integration-refresh PR is judged on what it adds on top of trunk, not on
  // the trunk history its stale fork point makes GitHub list (integration-refresh.ts).
  // Mission-authored schema and migration changes stay in that delta.
  const deltaBase = await refreshDeltaBaseForTask(opts?.taskId ?? null, opts?.gitConfig ?? null);
  if (deltaBase) {
    const delta = await effectiveDeltaFiles(installationId, repoFullName, deltaBase, headSha);
    if (delta) files = delta;
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
    let ordinaryHit = hits.find((hit) => !schemaSpecific(hit.path));
    if (ordinaryHit) {
      // Re-check against the live diff before refusing: a stale PR snapshot
      // must not flag a protected path the head no longer differs on.
      const live = await fetchLiveChangedFilenames(installationId, repoFullName, prNumber, headSha);
      if (live) {
        files = files.filter((f) => live.has(f.filename));
        ordinaryHit = hits.find((hit) => !schemaSpecific(hit.path) && live.has(hit.file.filename));
      }
    }
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
      ...(deltaBase ? { deltaBase } : {}),
    });
    if (!migrationSafety.safe) {
      return { ok: false, reason: migrationSafety.reason };
    }
  }

  // Read the PR once. Hoisted above the size check (it also feeds the
  // mergeable_state check below) because the PR's refs feed the size-gate
  // exemptions: BASE identifies a task PR into its mission's integration
  // branch, HEAD and BASE together the release PR. BASE also feeds the
  // model-approve bound.
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
  if (opts?.observed) {
    opts.observed.baseRef = prData?.base?.ref ?? null;
    opts.observed.headRef = prData?.head?.ref ?? null;
    opts.observed.mergeableState = prData?.mergeable_state ?? null;
  }

  // Aggregate line-count cap — auto-threshold tier ONLY (see the function
  // doc comment). `agent-review` and `human` never reach this block, so a
  // workspace on either tier cannot inherit the 800-line default just
  // because `policy.threshold` happened to be unset.
  if (policy.tier === 'auto-threshold') {
    // Is this a task PR into its own mission's integration branch
    // (task branch → integration branch)?
    //
    // Under branchStrategy "mission-branch" the tier applies ONCE, to the
    // mission-to-trunk PR, so a task PR landing on the integration branch is
    // not where the cap belongs. The ref of interest is the task PR's BASE.
    // The mission-to-trunk PR (integration branch as HEAD) is NOT exempt: it is
    // where the tier applies, cap included.
    //
    // Authoritative predicate rather than the `mission/` shape heuristic: it
    // compares against the calling task's own mission row, so a PR into a
    // branch that merely looks like a mission branch, or into another
    // mission's, keeps the cap. An unknown base ref or a mission that has not
    // opted in is false.
    const isTaskPrIntoOwnMissionBranch = isMissionIntegrationBase({
      baseRef: prData?.base?.ref ?? null,
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
    // A task PR into its own mission's integration branch skips the AGGREGATE
    // line threshold: the mission-to-trunk PR carries the same lines to trunk
    // later and is size-gated there, under the full policy.
    //
    // The workspace's release PR (dev → main) skips it too: it bundles every
    // commit merged since the last release, each already size-gated on its own
    // way into the release branch, so the union is over the cap essentially by
    // construction and every release would otherwise need a human to merge_pr
    // regardless of review outcome.
    //
    // ONLY the aggregate size gate is exempt for either. Everything else in this
    // function still runs, unchanged and in the same order: CI-green
    // (fail-closed if unverifiable), denyPaths / escalateToPaths, the migration
    // operation-class inspector, and the conflict / branch-protection checks.
    if ((isTaskPrIntoOwnMissionBranch || isReleasePr) && totalLines > maxLines) {
      const exemption = isTaskPrIntoOwnMissionBranch
        ? "task PR into its mission's integration branch — the mission-to-trunk PR is size-gated instead"
        : 'release PR — each underlying commit was size-gated on the way in';
      console.log(
        `[auto-merge] ${repoFullName}#${prNumber}: aggregate size gate not applied ` +
          `(${totalLines} source lines > limit ${maxLines}): ${exemption}`,
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
  if (prData?.base?.ref && !opts?.skipBaseFreshness) {
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
    // BASE ref, as for the size-gate exemption above: a task PR runs task
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
  /**
   * The workspace gitConfig, used ONLY by surface merge ordering (the merge
   * decision itself is `policy`). Omitted, the ordering check loads it.
   */
  surfaceOrderingConfig?: WorkspaceGitConfig | null;
  /** The kernel's landing (T15/T16); null = not the kernel's PR. Defaults to the seam's. Injected by tests. */
  landThroughKernel?: (input: LandingInput) => Promise<KernelLanding | null>;
}): Promise<{ merged: boolean; reason?: string }> {
  const { installationId, repoFullName, prNumber, headSha, worker, policy, bound } = params;

  // Surface merge ordering (conflict-aware-orchestration.md §3) — FIRST, before
  // the safety rails, because their refusal path can refresh the branch
  // (dispatchConflictRetry). A PR waiting behind an earlier PR on a serialized
  // surface must not be mutated; the earlier PR's close re-drives it. Off by
  // default: no reads unless the workspace opted in.
  // Resolved at most once per call: ordering, the review gate and both conflict
  // paths all need it, and a caller that passes `worker.workspaceId` costs no read.
  let workspaceIdRead: Promise<string | null> | null = null;
  const workspaceIdOnce = () =>
    (workspaceIdRead ??= worker.workspaceId
      ? Promise.resolve(worker.workspaceId)
      : worker.taskId ? resolveWorkspaceId(worker.taskId) : Promise.resolve(null));
  const orderWorkspaceId = await workspaceIdOnce();
  const surfaceOrder = orderWorkspaceId
    ? await checkSurfaceOrder({
        workspaceId: orderWorkspaceId,
        installationId,
        repoFullName,
        prNumber,
        headSha,
        gitConfig: params.surfaceOrderingConfig,
        taskId: worker.taskId ?? null,
        workerId: worker.id ?? null,
        door: 'auto-merge',
        callerOrigin: 'system',
      })
    : ({ blocks: false, slot: null } as const);
  if (surfaceOrder.blocks) {
    console.log(`Auto-merge deferred for ${repoFullName}#${prNumber}: ${surfaceOrder.reason}`);
    return { merged: false, reason: surfaceOrder.reason };
  }

  // One mission read serves both callers of it inside the safety rails: the
  // size-gate exemption and, when a model verdict authorised this merge, the
  // bound's base-ref test.
  const { mission, requiresReview } = await loadTaskMergeFields(worker.taskId);
  const observed: { baseRef?: string | null } = {};

  // `tasks.requiresReview` is the explicit human-tier tag (resolvePolicy rule 1),
  // but the reviewer-approve and two webhook paths resolve policy without the
  // task. Refusing here, on the door itself, keeps the tag binding for every
  // caller whatever policy they computed. Onboarding scaffold PRs rely on it.
  if (requiresReview) {
    const reason = 'task requires human review; unattended merge is refused';
    console.log(`Auto-merge blocked for ${repoFullName}#${prNumber}: ${reason}`);
    fireGateEvent({
      gate: GATE_SLUGS.AUTO_MERGE,
      surface: 'auto-merge',
      outcome: 'rejected',
      reason,
      workspaceId: worker.workspaceId ?? null,
      taskId: worker.taskId ?? null,
      workerId: worker.id ?? null,
      callerOrigin: 'system',
      detail: { prNumber, headSha, repoFullName, reasonClass: 'requires_review', tier: policy.tier },
    });
    return { merged: false, reason };
  }

  const safetyCheck = await evaluateAutoMergeSafety(
    installationId,
    repoFullName,
    prNumber,
    headSha,
    policy,
    { mission, bound, workspaceId: worker.workspaceId ?? null, taskId: worker.taskId, workerId: worker.id, observed, gitConfig: params.surfaceOrderingConfig },
  );
  if (!safetyCheck.ok) {
    console.log(`Auto-merge blocked for ${repoFullName}#${prNumber}: ${safetyCheck.reason}`);
    const reasonClass = classifyAutoMergeRefusal(safetyCheck.reason);
    // Base freshness already wrote its own row inside the safety check.
    if (reasonClass !== 'base_freshness') {
      fireGateEvent({
        gate: GATE_SLUGS.AUTO_MERGE,
        surface: 'auto-merge',
        outcome: TRANSIENT_REFUSALS.has(reasonClass) ? 'deferred' : 'rejected',
        reason: safetyCheck.reason,
        workspaceId: worker.workspaceId ?? null,
        taskId: worker.taskId ?? null,
        workerId: worker.id ?? null,
        callerOrigin: 'system',
        detail: { prNumber, headSha, repoFullName, reasonClass, tier: policy.tier },
      });
    }

    // Conflict path: dispatch a same-branch retry rather than asking the human.
    if (classifyMergeFailure(safetyCheck.reason) === 'conflict' && worker.taskId) {
      const workspaceId = await workspaceIdOnce();
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
          // Nothing was filed. Say why on the ledger, and page a person for the
          // outcomes no later event clears on its own.
          await recordUnfiledRefreshOutcome(dispatchResult, {
            workspaceId, taskId: worker.taskId, workerId: worker.id, repoFullName, prNumber, headSha, refusal: safetyCheck.reason,
          });
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
  const reviewWorkspaceId = await workspaceIdOnce();
  if (reviewWorkspaceId) {
    const reviewGate = await guardReviewVerdict({
      workspaceId: reviewWorkspaceId,
      prNumber,
      headSha,
      surface: 'auto-merge',
      taskId: worker.taskId ?? null,
      workerId: worker.id ?? null,
      callerOrigin: 'system',
      // A diff-unchanged new head (a base merge, a trivial rebase) must not
      // read as a stale approval; a diff-changing push is never carried.
      carryForward: observed.baseRef ? { installationId, repoFullName, baseRef: observed.baseRef } : null,
    });
    if (reviewGate.blocks) {
      const reason = `${reviewGate.reason}. ${reviewGate.clearedBy}`;
      console.log(`Auto-merge blocked for ${repoFullName}#${prNumber}: ${reason}`);
      // Carry-forward could not keep the approval (the diff changed): send a
      // reviewer for this head rather than waiting for a person to ask.
      const reReview = reviewGate.kind === 'stale_approval'
        ? await dispatchStaleApprovalReReview({
            workspaceId: reviewWorkspaceId,
            installationId,
            repoFullName,
            prNumber,
            headSha,
            baseRef: observed.baseRef ?? null,
            taskId: worker.taskId ?? null,
            workerId: worker.id ?? null,
            policy,
          })
        : null;
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
          ...(reReview
            ? {
                reReview: reReview.outcome,
                ...('reviewTaskId' in reReview ? { reReviewTaskId: reReview.reviewTaskId } : {}),
                ...('reason' in reReview ? { reReviewSkipped: reReview.reason } : {}),
              }
            : {}),
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
        columns: { id: true, title: true, taskClass: true, missionId: true, context: true },
      })
    : null;
  const mergeGate = await guardMissionPrMerge(mergingTask);
  if (mergeGate.blocks) {
    console.log(`Auto-merge blocked for ${repoFullName}#${prNumber}: ${mergeGate.reason}`);
    fireGateEvent({
      gate: GATE_SLUGS.MISSION_PR_LIFECYCLE,
      surface: 'auto-merge',
      outcome: 'deferred',
      reason: mergeGate.reason ?? 'mission PR waits on sibling task work',
      workspaceId: worker.workspaceId ?? null,
      taskId: worker.taskId ?? null,
      workerId: worker.id ?? null,
      missionId: mergingTask?.missionId ?? null,
      callerOrigin: 'system',
      detail: { prNumber, headSha, repoFullName },
    });
    return { merged: false, reason: mergeGate.reason };
  }

  // An integration-refresh PR IS the merge commit that catches the mission
  // branch up with dev; squashing it would drop that ancestry and the same
  // conflict would reappear on the very next refresh (integration-refresh.ts).
  const mergeMethod = resolveMergeMethod(mergingTask?.context);
  // Every rail passed. For a kernel-owned PR this door is only an adapter: the
  // kernel lands it (LandingRequested → merge_call → MergeCallResult) and owns
  // what follows — the post-merge work, and the refresh or conflict repair a
  // refusal is owed. Any other PR merges here as before.
  const kernelLand = params.landThroughKernel ?? (await import('@/lib/workflow/seam')).landThroughKernel;
  const landingWorkspaceId = await workspaceIdOnce();
  const slotted = await mergeInSurfaceSlot(surfaceOrder, async () => {
    const kernel = landingWorkspaceId
      ? await kernelLand({ workspaceId: landingWorkspaceId, installationId, repoFullName, prNumber, headSha, door: 'auto_merge', actor: 'system:auto_merge', mergeMethod })
      : null;
    return kernel ? { kernel } : { legacy: await mergePullRequest(installationId, repoFullName, prNumber, mergeMethod, headSha) };
  });
  if ('refused' in slotted) {
    console.log(`Auto-merge deferred for ${repoFullName}#${prNumber}: ${slotted.refused}`);
    return { merged: false, reason: slotted.refused };
  }
  if (slotted.result.kernel) {
    const k = slotted.result.kernel;
    console.log(`[auto-merge] ${repoFullName}#${prNumber}: kernel landing ${k.outcome} (${k.reason})`);
    return k.merged ? { merged: true } : { merged: false, reason: k.message };
  }
  const result = slotted.result.legacy;
  if (result.merged) {
    console.log(`Auto-merged PR #${prNumber} on ${repoFullName} for worker ${worker.id}`);
    await finalizeMissionPrMerge(mergingTask, installationId, repoFullName);
    return { merged: true };
  }

  console.warn(`Failed to auto-merge PR #${prNumber} on ${repoFullName}: ${result.message}`);
  fireGateEvent({
    gate: GATE_SLUGS.AUTO_MERGE,
    surface: 'auto-merge',
    outcome: 'rejected',
    reason: result.message || 'merge call failed',
    workspaceId: worker.workspaceId ?? null,
    taskId: worker.taskId ?? null,
    workerId: worker.id ?? null,
    callerOrigin: 'system',
    detail: {
      prNumber, headSha, repoFullName, tier: policy.tier,
      reasonClass: 'merge_api',
      mergeFailureClass: classifyMergeFailure(result.message ?? ''),
    },
  });
  // Handle race-condition conflict (PR was clean at eval time but dirty at merge time)
  if (classifyMergeFailure(result.message) === 'conflict' && worker.taskId) {
    const workspaceId = await workspaceIdOnce();
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
      } else if (!dispatchResult.dispatched && !dispatchResult.disabled) {
        await recordUnfiledRefreshOutcome(dispatchResult, {
          workspaceId, taskId: worker.taskId, workerId: worker.id, repoFullName, prNumber, headSha, refusal: result.message ?? '',
        });
      }
    }
  }
  return { merged: false, reason: result.message };
}

/**
 * The branch-refresh outcomes `dispatchConflictRetry` returns without filing
 * anything, each with its own ledger reason. `page` names the landing cause a
 * person is paged with — the same page `landPr` raises (pr-landing.ts
 * `mapRetry`) — for the two that no later event clears on its own.
 */
export function describeUnfiledRefreshOutcome(res: DispatchConflictRetryResult): {
  refreshOutcome: string;
  reason: string;
  page: 'refresh_failed' | 'refresh_exhausted' | 'semantic_unverified' | null;
} {
  if (res.refreshExhausted && res.refreshTreadmill !== undefined) {
    return {
      refreshOutcome: 'refresh_exhausted',
      reason: `the base kept moving after ${res.refreshTreadmill} refreshes (${refreshCause(res)})`,
      page: 'refresh_exhausted',
    };
  }
  if (res.refreshExhausted) {
    return {
      refreshOutcome: 'refresh_exhausted',
      reason: `updating the branch kept failing (${refreshCause(res)}), not a conflict; retries are used up`,
      page: 'refresh_failed',
    };
  }
  if (res.semanticUnverified) {
    return {
      refreshOutcome: 'semantic_unverified',
      reason: 'the PR and the base change the same files and their symbol overlap could not be verified',
      page: 'semantic_unverified',
    };
  }
  if (res.inFlightTaskId) {
    return { refreshOutcome: 'conflict_retry_in_flight', reason: `a conflict retry is already working this PR (task ${res.inFlightTaskId.slice(0, 8)})`, page: null };
  }
  if (res.dependencyBot) {
    return { refreshOutcome: 'dependency_bot', reason: 'this is a dependency-bot PR; its own rebase owns the branch', page: null };
  }
  if (res.headChanged) return { refreshOutcome: 'head_changed', reason: 'the PR head moved before the refresh; the new head re-evaluates', page: null };
  if (res.refreshInFlight) return { refreshOutcome: 'refresh_in_flight', reason: 'another refresh of this PR is in flight', page: null };
  if (res.refreshQueued) return { refreshOutcome: 'refresh_queued', reason: 'a branch refresh is queued; the new head re-evaluates', page: null };
  if (res.refreshDeferred) {
    return { refreshOutcome: 'refresh_deferred', reason: `updating the branch failed (${refreshCause(res)}), not a conflict; will retry`, page: null };
  }
  if (res.semanticDeferred) return { refreshOutcome: 'semantic_deferred', reason: 'semantic overlap with the base is not yet verified; will recheck', page: null };
  if (res.alreadyUpToDate) return { refreshOutcome: 'already_up_to_date', reason: 'the branch already has every base commit', page: null };
  if (res.baseRewritten) return { refreshOutcome: 'base_rewritten', reason: 'the base branch was rewritten after this PR opened', page: null };
  return { refreshOutcome: 'dedup', reason: 'a conflict retry for this PR head was already filed', page: null };
}

/** Ledger row (and, for the two terminal outcomes, a page) for a refresh that filed nothing. Never throws. */
async function recordUnfiledRefreshOutcome(
  res: DispatchConflictRetryResult,
  ctx: { workspaceId: string; taskId: string; workerId: string; repoFullName: string; prNumber: number; headSha: string; refusal: string },
): Promise<void> {
  const { refreshOutcome, reason, page } = describeUnfiledRefreshOutcome(res);
  console.log(`[auto-merge] ${ctx.repoFullName}#${ctx.prNumber}: refresh filed nothing (${refreshOutcome}) — ${reason}`);
  try {
    fireGateEvent({
      gate: GATE_SLUGS.AUTO_MERGE,
      surface: 'auto-merge',
      outcome: page ? 'stranded' : 'deferred',
      reason,
      workspaceId: ctx.workspaceId,
      taskId: ctx.taskId,
      workerId: ctx.workerId,
      callerOrigin: 'system',
      detail: {
        prNumber: ctx.prNumber,
        headSha: ctx.headSha,
        repoFullName: ctx.repoFullName,
        refreshOutcome,
        refusal: ctx.refusal,
        ...(res.inFlightTaskId ? { inFlightTaskId: res.inFlightTaskId } : {}),
        ...(res.refreshFailure ? { refreshFailure: res.refreshFailure } : {}),
      },
    });
  } catch (err) {
    console.warn('[auto-merge] gate event write failed:', err instanceof Error ? err.message : String(err));
  }
  if (!page) return;
  try {
    const { raiseLandingAlert } = await import('@/lib/pr-landing-alert-deps');
    await raiseLandingAlert({
      workspaceId: ctx.workspaceId,
      prNumber: ctx.prNumber,
      headSha: ctx.headSha,
      repoFullName: ctx.repoFullName,
      prTitle: null,
      taskId: ctx.taskId,
      outcome: { kind: 'needs_human', cause: page, reason },
    });
  } catch (err) {
    console.warn(`[auto-merge] landing page failed for PR #${ctx.prNumber}:`, err instanceof Error ? err.message : String(err));
  }
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
/** The trunk a refresh task's PR is measured against; null for any other task. Never throws. */
async function refreshDeltaBaseForTask(
  taskId: string | null,
  gitConfig: WorkspaceGitConfig | null,
): Promise<string | null> {
  if (!taskId) return null;
  try {
    const task = await db.query.tasks.findFirst({ where: eq(tasks.id, taskId), columns: { context: true } });
    return refreshDeltaBase(task?.context, gitConfig);
  } catch {
    return null;
  }
}

export async function loadMissionIntegrationFields(
  taskId: string | null,
): Promise<MissionIntegrationFields | null> {
  return (await loadTaskMergeFields(taskId)).mission;
}

async function loadTaskMergeFields(
  taskId: string | null,
): Promise<{ mission: MissionIntegrationFields | null; requiresReview: boolean }> {
  if (!taskId) return { mission: null, requiresReview: false };
  try {
    const task = await db.query.tasks.findFirst({
      where: eq(tasks.id, taskId),
      columns: { id: true, requiresReview: true },
      with: { mission: { columns: { workingBranch: true, integrationBranchEnabled: true } } },
    });
    const row = task as { mission?: MissionIntegrationFields | null; requiresReview?: boolean } | undefined;
    return { mission: row?.mission ?? null, requiresReview: row?.requiresReview === true };
  } catch (err) {
    console.warn(`[auto-merge] could not resolve task ${taskId}:`, err);
    return { mission: null, requiresReview: false };
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
      : policyValue('maxConflictIterations');
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
  void notifyTeamOf({ taskId: task.id }, 'needsAttention', {
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

  void notifyTeamOf({ taskId: task.id }, 'needsAttention', {
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

  void notifyTeamOf({ taskId: task.id }, 'needsAttention', {
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
