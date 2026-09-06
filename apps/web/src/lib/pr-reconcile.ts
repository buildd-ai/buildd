/**
 * The single GitHub poller. Cross-checks GitHub for workers whose PR still
 * looks un-merged, healing rows the pull_request webhook never delivered.
 *
 * Tier 2 of the reconciliation model (PR #1630): the read-through refresh in
 * pr-state-refresh.ts keeps rows fresh for workspaces someone is looking at;
 * this sweep is what covers the rest. Called by /api/cron/pr-reconcile, and
 * safe to call ad-hoc from scripts or admin routes.
 *
 * The gate is "when did we last check this row", not "how long has the row been
 * quiet". The previous `updatedAt < now() - 7 days` gate had three failures
 * measured against production: a webhook missed today was not a candidate for a
 * week; any write to the row (including a read-through check) reset the clock,
 * so busy rows were never candidates at all; and the overwhelming majority of
 * what it did select was already known-closed, burning one GitHub call each,
 * uncapped, inside a 60 s function.
 *
 * Two further failures, measured against the four stale MERGE cards that
 * prompted this rewrite:
 *
 *   1. The installation was resolved through the LEGACY
 *      `workspaces.githubInstallationId` FK. lib/workspace-installation.ts
 *      documents why that is wrong: after an App reinstall the FK points at a
 *      dead installation which still mints a valid token whose every call 404s,
 *      and when it is null this sweep recorded a check and skipped the row —
 *      so the row rotated to the back of the queue looking healthy and was
 *      never reconciled again. Silent, and permanent. Always go through
 *      pickWorkspaceInstallationId.
 *   2. Nothing counted failures, so nothing ever gave up. A row that could not
 *      be resolved stayed "open" indefinitely and Home kept rendering it as a
 *      merge CTA. Consecutive failures now accumulate and, past the TTL in
 *      lib/pr-freshness.ts, land the row in terminal `unresolvable`.
 *
 * Cadence is age-tiered (see TIER_SLA_MS): recent PRs are re-verified every
 * 30 minutes, 90-day-old ones daily. The invariant this sweep exists to hold is
 * that no row's lifecycle state is ever older than its tier's SLA — with Home
 * never rendered.
 */

import { db } from '@buildd/core/db';
import { missions, workers, workspaces } from '@buildd/core/db/schema';
import { and, isNull, isNotNull, eq, gt, or, notInArray, sql } from 'drizzle-orm';
import { githubApi } from '@/lib/github';
import {
  WORKSPACE_INSTALLATION_WITH,
  pickWorkspaceRepoIdentity,
  installationIdForRepo,
} from '@/lib/workspace-installation';
import { repoFullNameFromPrUrl, resolvePrRepo } from '@/lib/repo-scope';
import {
  TIER_SLA_MS,
  HOT_MAX_AGE_MS,
  WARM_MAX_AGE_MS,
  DAY_MS,
  shouldMarkUnresolvable,
} from '@/lib/pr-freshness';
import {
  evaluateMissionWorkState,
  findMissionPrOwner,
  maybeOpenMissionIntegrationPr,
} from '@/lib/mission-pr';
import { checkAndUnblockDependentMissions } from '@/lib/mission-dependency';

/**
 * On-demand merge-state check for a single worker.
 *
 * Calls GET /repos/{owner}/{repo}/pulls/{prNumber} and, if the PR is merged,
 * stamps mergedAt + prLifecycleStatus='merged' in the workers table.
 *
 * Returns true when a merge was detected and written, false otherwise.
 * Safe to call speculatively — skips the GitHub call if mergedAt is already set.
 */
export async function refreshWorkerMergeStateIfStale(
  worker: { id: string; prNumber: number; prUrl: string; mergedAt?: Date | null },
  installationId: number,
): Promise<boolean> {
  if (worker.mergedAt) return false;

  const repo = resolvePrRepo({ prUrl: worker.prUrl, workspaceRepo: null });
  if (!repo) return false;

  try {
    const pr = await githubApi(
      installationId,
      `/repos/${repo}/pulls/${worker.prNumber}`,
    ) as { state: string; merged: boolean; merged_at: string | null };

    if (pr.merged && pr.merged_at) {
      const now = new Date();
      await db.update(workers)
        .set({
          mergedAt: new Date(pr.merged_at),
          prLifecycleStatus: 'merged',
          prLastCheckedAt: now,
          prLastVerifiedAt: now,
          prCheckFailureCount: 0,
          updatedAt: now,
        })
        .where(eq(workers.id, worker.id));
      return true;
    }
    return false;
  } catch (err) {
    console.warn(`[pr-reconcile] refreshWorkerMergeStateIfStale worker ${worker.id} PR #${worker.prNumber}:`, err);
    return false;
  }
}

/**
 * Rows per run. Bounded so a run always finishes inside the route's
 * maxDuration (60 s) with RATE_LIMIT_MS between GitHub calls, and so a backlog
 * drains predictably across runs rather than timing out mid-sweep.
 */
export const RECONCILE_BATCH_CAP = 40;

/** Spacing between GitHub calls, matching pr-state-refresh.ts. */
const RATE_LIMIT_MS = 200;

/**
 * Lifecycle states that need no further GitHub call. `unresolvable` is terminal
 * for the same reason merged and closed are: re-asking cannot change the answer.
 */
const TERMINAL_STATUSES = ['merged', 'closed', 'unresolvable'] as (
  'pr_open' | 'ci_running' | 'ci_green' | 'ci_failed' | 'merged' | 'conflict' | 'closed' | 'unresolvable' | null
)[];

/** The timestamp we treat as "when this PR opened" — completedAt, else createdAt. */
const PR_OPENED_AT_SQL = sql`COALESCE(${workers.completedAt}, ${workers.createdAt})`;

/**
 * SQL for the age-tiered staleness gate, derived from TIER_SLA_MS so the sweep
 * and the read-path invariant can never disagree about what "fresh" means.
 */
function tieredStalenessCondition() {
  const secs = (ms: number) => sql.raw(String(Math.round(ms / 1000)));
  return sql`(
    ${workers.prLastCheckedAt} IS NULL
    OR ${workers.prLastCheckedAt} < now() - (
      CASE
        WHEN ${PR_OPENED_AT_SQL} > now() - (${secs(HOT_MAX_AGE_MS)} * interval '1 second')
          THEN ${secs(TIER_SLA_MS.hot)} * interval '1 second'
        WHEN ${PR_OPENED_AT_SQL} > now() - (${secs(WARM_MAX_AGE_MS)} * interval '1 second')
          THEN ${secs(TIER_SLA_MS.warm)} * interval '1 second'
        ELSE ${secs(TIER_SLA_MS.cold)} * interval '1 second'
      END
    )
  )`;
}

export interface ReconcileResult {
  total: number;
  stamped: number;
  closed: number;
  skipped: number;
  /** Rows whose GitHub call failed; retried next run. */
  errors: number;
  /** Rows that exhausted the unknown TTL and went terminal this run. */
  unresolvable: number;
}

/**
 * Deferred so this module does not close an import cycle: task-dependencies
 * imports refreshWorkerMergeStateIfStale from here.
 */
async function notifyDependents(taskId: string): Promise<void> {
  const { checkDependsOnResolved } = await import('@/lib/task-dependencies');
  await checkDependsOnResolved(taskId);
}

/**
 * Reconcile awaiting-merge workers against GitHub.
 *
 * For each candidate (PR set, not merged, not already terminal, unchecked for
 * longer than its tier's SLA), fetches the PR and stamps mergedAt /
 * prLifecycleStatus accordingly. Open PRs are left open. Every row that is
 * looked at — including ones that were unchanged, unreachable or errored — has
 * prLastCheckedAt advanced, because the batch is ordered least-recently-checked
 * first and a row that never records a check would sit at the head of it
 * forever.
 *
 * A row that CANNOT be resolved (404, dead installation, workspace with no repo)
 * accumulates prCheckFailureCount. Once it is past both the failure threshold
 * and the unknown TTL it is written to terminal `unresolvable` — off Home,
 * still visible on the health surface.
 */
export async function reconcileStalePrWorkers(): Promise<ReconcileResult> {
  const candidates = await db.query.workers.findMany({
    where: and(
      isNotNull(workers.prNumber),
      isNotNull(workers.prUrl),
      isNull(workers.mergedAt),
      // notInArray is NULL-blind, so the null branch has to be explicit.
      or(
        isNull(workers.prLifecycleStatus),
        notInArray(workers.prLifecycleStatus, TERMINAL_STATUSES),
      ),
      tieredStalenessCondition(),
    ),
    columns: {
      id: true,
      prNumber: true,
      prUrl: true,
      workspaceId: true,
      taskId: true,
      completedAt: true,
      createdAt: true,
      prCheckFailureCount: true,
    },
    // The mission link, for the Option A' opener below. Fetched with the batch
    // rather than re-read per row: a merge healed here may be the event that
    // completes an opted-in mission's work, and the webhook that would normally
    // have opened its PR is the delivery that went missing.
    with: { task: { columns: { missionId: true } } },
    orderBy: sql`${workers.prLastCheckedAt} ASC NULLS FIRST`,
    limit: RECONCILE_BATCH_CAP,
  });

  const result: ReconcileResult = {
    total: candidates.length,
    stamped: 0,
    closed: 0,
    skipped: 0,
    errors: 0,
    unresolvable: 0,
  };
  if (candidates.length === 0) return result;

  /**
   * Advance the ATTEMPT clock so the row rotates to the back of the queue.
   * Pass `verified: true` only when GitHub actually returned a PR state
   * (merged / closed / confirmed-open) — that also advances the VERIFICATION
   * clock (`prLastVerifiedAt`), the one lib/pr-freshness.ts reads to decide
   * whether a row's lifecycle state is fresh. A failed check must NEVER pass
   * `verified: true`: prLastCheckedAt saying "we looked" must not be mistaken
   * for prLastVerifiedAt saying "we know" — that conflation is the exact bug
   * this two-clock split exists to fix.
   */
  const recordCheck = async (
    id: string,
    extra: Record<string, unknown> = {},
    opts: { verified?: boolean } = {},
  ) => {
    const now = new Date();
    await db
      .update(workers)
      .set({
        prLastCheckedAt: now,
        ...(opts.verified ? { prLastVerifiedAt: now } : {}),
        ...extra,
      })
      .where(eq(workers.id, id));
  };

  type Candidate = (typeof candidates)[number];

  /**
   * A row we could not resolve. Counts the failure and, once it is past both
   * the threshold and the TTL, retires it to terminal `unresolvable` so it
   * stops being rendered as an open PR nobody can act on.
   */
  const recordFailure = async (worker: Candidate, reason: string) => {
    const failureCount = (worker.prCheckFailureCount ?? 0) + 1;
    const prOpenedAt = worker.completedAt ?? worker.createdAt ?? null;
    const terminal = shouldMarkUnresolvable({ failureCount, prOpenedAt, now: new Date() });

    await recordCheck(worker.id, {
      prCheckFailureCount: failureCount,
      ...(terminal
        ? {
            prLifecycleStatus: 'unresolvable' as const,
            prUnresolvableReason: reason,
            updatedAt: new Date(),
          }
        : {}),
    }).catch(() => {});

    if (terminal) {
      result.unresolvable++;
      console.warn(
        `[pr-reconcile] worker ${worker.id} PR #${worker.prNumber} → unresolvable after ${failureCount} failures: ${reason}`,
      );
    }
  };

  /**
   * Repo → installation, memoized for the run. Repos repeat heavily inside a
   * batch (a workspace's PRs, an org's sibling repos), and this is a DB round
   * trip per miss.
   */
  const installationByRepo = new Map<string, number | null>();
  const resolveInstallationCached = async (repo: string): Promise<number | null> => {
    if (!installationByRepo.has(repo)) {
      installationByRepo.set(
        repo,
        await installationIdForRepo(repo).catch(() => null),
      );
    }
    return installationByRepo.get(repo) ?? null;
  };

  // Group by workspace so we share one installation token per workspace
  const byWorkspace = new Map<string, Candidate[]>();
  for (const w of candidates) {
    if (!byWorkspace.has(w.workspaceId)) byWorkspace.set(w.workspaceId, []);
    byWorkspace.get(w.workspaceId)!.push(w);
  }

  let callIndex = 0;

  /**
   * Missions whose mission-level merge effects have already run in this batch.
   *
   * Both effects below are idempotent, so a repeat is safe — but a batch can
   * heal several workers of one mission, and each repeat is a handful of queries
   * inside a 60 s function for an answer that cannot have changed.
   */
  const missionsHandled = new Set<string>();

  for (const [workspaceId, wsWorkers] of byWorkspace) {
    const workspace = await db.query.workspaces.findFirst({
      where: eq(workspaces.id, workspaceId),
      columns: { repo: true },
      with: WORKSPACE_INSTALLATION_WITH,
    });

    // Workspace repo identity comes from the linked `github_repos` row, not the
    // free-text column — see pickWorkspaceRepoIdentity. The text follows no
    // rename, so a fallback built from it can be confidently wrong.
    const wsIdentity = pickWorkspaceRepoIdentity(workspace);
    const workspaceRepo = wsIdentity.fullName;
    const workspaceInstallationId = wsIdentity.installationId;

    for (const worker of wsWorkers) {
      if (!worker.prNumber) { result.skipped++; continue; }

      // The PR's OWN repo, from its prUrl, with the workspace only as a
      // fallback — see lib/repo-scope.ts. Reading the repo off the workspace
      // was wrong three ways at once: the column holds a URL rather than a
      // slug, the PR often lives in a different repo, and coordination
      // workspaces have no repo while still owning real PRs.
      const repo = resolvePrRepo({ prUrl: worker.prUrl, workspaceRepo });
      const repoSource = repoFullNameFromPrUrl(worker.prUrl) ? 'pr_url' : wsIdentity.source;
      if (!repo) {
        result.skipped++;
        await recordFailure(worker, 'No GitHub repo resolvable from the PR url or the workspace');
        continue;
      }

      // The workspace pointer only answers for the workspace's own repo; for
      // anything else the covering installation has to be looked up by repo.
      const installationId =
        (repo === workspaceRepo ? workspaceInstallationId : null)
        ?? await resolveInstallationCached(repo)
        ?? workspaceInstallationId;

      if (!installationId) {
        // Unreconcilable, and NOT transient. The old code recorded a bare
        // check here, which made the row look healthy and hid the problem
        // forever. Count it as a failure so the row eventually retires to
        // `unresolvable` and shows up on Health.
        result.skipped++;
        await recordFailure(worker, `No usable GitHub App installation for ${repo}`);
        continue;
      }

      if (callIndex > 0) await new Promise<void>(r => setTimeout(r, RATE_LIMIT_MS));
      callIndex++;

      try {
        const pr = await githubApi(
          installationId,
          `/repos/${repo}/pulls/${worker.prNumber}`,
        ) as { state: string; merged: boolean; merged_at: string | null };

        if (pr.merged && pr.merged_at) {
          await recordCheck(worker.id, {
            mergedAt: new Date(pr.merged_at),
            prLifecycleStatus: 'merged',
            prCheckFailureCount: 0,
            updatedAt: new Date(),
          }, { verified: true });
          result.stamped++;
          // Option A': the webhook was the only trigger for the mission PR, and
          // `workers.mergedAt` is documented as lossy. Healing the row without
          // re-attempting the opener leaves an opted-in mission whose work is
          // done and whose PR never appeared — and the completion gate refuses
          // that state, so a transient delivery gap became terminal.
          //
          // Ordered BEFORE the dependency notification, matching the webhook: the
          // mission PR must already exist (unmerged) when anything asks whether
          // this mission still has unmerged work.
          //
          // No `assumeCompletedTaskIds` here, deliberately. Unlike the webhook,
          // this sweep does not go on to stamp `tasks.status`, so it has no
          // grounds to claim a task has landed beyond what the rows already say.
          if (worker.task?.missionId && !missionsHandled.has(worker.task.missionId)) {
            const missionId = worker.task.missionId;
            missionsHandled.add(missionId);
            await maybeOpenMissionIntegrationPr(missionId).catch(err =>
              console.error(`[pr-reconcile] mission PR open failed for mission ${missionId}:`, err),
            );
            // And the mission-level dependency gate, which had the same gap one
            // tier down: `missions.dependencyMetAt` is the only thing that clears
            // a `merged` gate, and only the webhook and the dashboard merge route
            // ever wrote it. A lost delivery therefore left a downstream mission
            // reading "Waiting for mission X PRs to merge" until something
            // unrelated poked it.
            //
            // Ordered AFTER the opener, deliberately: the helper re-checks
            // `missionHasUnmergedWork`, so the mission's own PR must already
            // exist — and be unmerged — before it is asked. Reversing these two
            // would unblock dependents on a task-PR merge, before the mission's
            // review gate had even opened. Idempotent: its only write is guarded
            // on `dependencyMetAt IS NULL`.
            await checkAndUnblockDependentMissions(missionId, 'merged').catch(err =>
              console.error(`[pr-reconcile] mission unblock failed for mission ${missionId}:`, err),
            );
          }
          // Stamping mergedAt is not enough — the dependency gate has to be
          // told, or the tasks this PR was blocking stay pending until some
          // other write pokes them.
          if (worker.taskId) {
            // Awaited, not fire-and-forget: this runs in a serverless function
            // that can be frozen the moment the handler resolves. Failure is
            // logged, never fatal to the sweep.
            await notifyDependents(worker.taskId).catch(err =>
              console.error(`[pr-reconcile] checkDependsOnResolved failed for task ${worker.taskId}:`, err),
            );
          }
        } else if (pr.state === 'closed') {
          await recordCheck(worker.id, {
            prLifecycleStatus: 'closed',
            prCheckFailureCount: 0,
            updatedAt: new Date(),
          }, { verified: true });
          result.closed++;
        } else {
          // Still open — record the check and clear the failure streak. The PR
          // resolved fine; it simply has not landed yet. GitHub gave a real
          // answer, so this advances the verification clock too.
          await recordCheck(worker.id, { prCheckFailureCount: 0 }, { verified: true });
          result.skipped++;
        }
      } catch (err) {
        // Network error, 404 (PR deleted / repo moved), rate-limit. Recorded as
        // a failure so a permanently unresolvable row costs one call per run
        // and then retires, instead of being retried until the end of time.
        // Log where the repo came from. When a resolved repo still 404s, "the
        // FK said this" and "a stale free-text column said this" are different
        // bugs with different fixes, and the reason string is the only place
        // that distinction survives.
        console.warn(
          `[pr-reconcile] worker ${worker.id} PR #${worker.prNumber} repo ${repo} (via ${repoSource}):`,
          err,
        );
        result.errors++;
        await recordFailure(worker, err instanceof Error ? err.message : String(err));
      }
    }
  }

  return result;
}

// ─── Mission PR sweep (Option A') ─────────────────────────────────────────────

/**
 * Missions considered per run.
 *
 * Ordered least-recently-updated first, so a mission that stalled sits at the
 * head of the queue rather than being starved by busier ones. Small on purpose:
 * opting in is per-mission, and every candidate costs a handful of indexed
 * reads.
 */
export const MISSION_PR_SWEEP_CAP = 20;

/**
 * How long after its last update a mission remains a sweep candidate.
 *
 * This is the retry bound. A mission that genuinely has nothing to ship — every
 * deliverable cancelled, or an integration branch nothing ever landed on — would
 * otherwise be re-examined every hour forever. When it goes quiet it leaves the
 * candidate set, and the sweep stops thinking about it.
 */
export const MISSION_PR_SWEEP_WINDOW_MS = 7 * DAY_MS;

export interface MissionPrSweepResult {
  /** Candidates the bounded query selected. */
  total: number;
  /** Mission PRs actually created this run. */
  opened: number;
  /** Already had a live mission PR — nothing to do. */
  alreadyOpen: number;
  /** Mission PR closed by a human, or closed between check and open. Terminal. */
  prClosed: number;
  /** Work is terminal but nothing landed on the integration branch. */
  nothingToShip: number;
  /** Work not finished yet — the normal answer for most candidates. */
  notReady: number;
  /** Opener threw, or reported an API failure. Retried next run. */
  errors: number;
}

/**
 * Open the mission PR for any opted-in mission whose work is done and whose PR
 * never appeared.
 *
 * The webhook is a merge-event trigger, and there are states that reach "work
 * complete" with no PR-merge event at all: the last deliverable completes with
 * `outputRequirement: 'none'`, or every deliverable task is cancelled (a
 * legitimate way for a mission to finish — the work was called off, which is a
 * decision, not an absence). Nothing in the merge path can heal those. This is
 * the trigger that does not depend on a merge having happened.
 *
 * Cheap by construction, in three layers:
 *
 *   1. The SQL bound selects opted-in missions only — never every mission — and
 *      caps and orders the batch.
 *   2. `findMissionPrOwner` short-circuits the two states with nothing to do
 *      (a live PR) and nothing permitted (a human closed it) before any work
 *      state is evaluated.
 *   3. `landedOnIntegrationCount === 0` is the honest "nothing to ship" answer,
 *      and it is checked BEFORE the opener — which is the call that would
 *      otherwise ask GitHub to compare an empty branch on every tick.
 *
 * So a mission that legitimately has nothing to ship costs a few indexed reads,
 * no GitHub call, no log line and no mission note, and drops out of the
 * candidate set entirely once it goes quiet.
 *
 * This sweep is deliberately NOT keyed on merge events, and the read-through
 * refresh in lib/pr-state-refresh.ts is the second reason why: when a render
 * stamps `mergedAt` first, `reconcileStalePrWorkers`' `isNull(workers.mergedAt)`
 * candidate query never selects that worker, so the merge-path opener above
 * never fires for it either. Whoever happened to open a page decides which tier
 * sees the merge; only this sweep sees the mission regardless.
 */
export async function sweepMissionIntegrationPrs(): Promise<MissionPrSweepResult> {
  const result: MissionPrSweepResult = {
    total: 0,
    opened: 0,
    alreadyOpen: 0,
    prClosed: 0,
    nothingToShip: 0,
    notReady: 0,
    errors: 0,
  };

  const candidates = await db.query.missions.findMany({
    where: and(
      eq(missions.integrationBranchEnabled, true),
      isNotNull(missions.workingBranch),
      // Live missions only. A paused mission is a human stop signal, and a
      // completed or archived one has no PR left to open.
      eq(missions.status, 'active'),
      gt(missions.updatedAt, new Date(Date.now() - MISSION_PR_SWEEP_WINDOW_MS)),
    ),
    columns: { id: true },
    orderBy: sql`${missions.updatedAt} ASC NULLS FIRST`,
    limit: MISSION_PR_SWEEP_CAP,
  });

  result.total = candidates.length;
  if (candidates.length === 0) return result;

  for (const mission of candidates) {
    try {
      const owner = await findMissionPrOwner(mission.id);
      // A live gate: this is the normal answer for a mission mid-review.
      if (owner?.state === 'open') {
        result.alreadyOpen++;
        continue;
      }
      // A human closed the mission PR. Reopening it would fight an explicit
      // decision, and saying so hourly would be noise, not signal.
      if (owner?.state === 'closed') {
        result.prClosed++;
        continue;
      }

      const work = await evaluateMissionWorkState(mission.id);
      if (!work.complete) {
        result.notReady++;
        continue;
      }
      // Complete, but with nothing on the branch for a PR to carry. Not an
      // error and not something to retry against GitHub.
      if (work.landedOnIntegrationCount === 0) {
        result.nothingToShip++;
        continue;
      }

      const opened = await maybeOpenMissionIntegrationPr(mission.id);
      if (!opened) {
        // Opted out between the query and here.
        result.notReady++;
      } else if (opened.ok) {
        if (opened.created) result.opened++;
        else result.alreadyOpen++;
      } else if (opened.reason === 'mission_pr_closed') {
        result.prClosed++;
      } else if (opened.reason === 'no_commits' || opened.reason === 'work_incomplete') {
        result.nothingToShip++;
      } else {
        // no_repo / api_error / not_opted_in / no_working_branch: a mission whose
        // work is done and whose PR still did not open must not be silent.
        result.errors++;
        console.error(
          `[pr-reconcile] mission ${mission.id} work is done but its PR did not open: `
          + `${opened.reason}${opened.detail ? ` (${opened.detail})` : ''}`,
        );
      }
    } catch (err) {
      result.errors++;
      console.error(`[pr-reconcile] mission PR sweep failed for mission ${mission.id}:`, err);
    }
  }

  if (result.opened > 0 || result.errors > 0) {
    console.log(
      `[MissionPrSweep] total=${result.total} opened=${result.opened} alreadyOpen=${result.alreadyOpen} `
      + `prClosed=${result.prClosed} nothingToShip=${result.nothingToShip} notReady=${result.notReady} `
      + `errors=${result.errors}`,
    );
  }

  return result;
}
