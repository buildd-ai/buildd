/**
 * Option A′ — the mission integration PR.
 *
 * When an opted-in mission's deliverable work has all landed on its integration
 * branch, that branch opens **one** PR into trunk. That PR is the mission's
 * single human gate: the merge-policy tier applies to it, not to the task PRs
 * that fed it (see `merge-policy.ts`).
 *
 * ## Why the mission PR is owned by a worker row
 *
 * This is the implementation choice P4 said decides whether the review flow
 * works at all, so it is worth stating plainly. Every human-facing merge
 * surface in this codebase is keyed on `workers`:
 *
 *   - the escalation inbox selects `isNotNull(workers.prUrl)`
 *   - `/api/prs/[prNumber]/merge` resolves the PR through `workers.prNumber`
 *   - `MergeConfirmButton` / `WaitingOnYouMergeCard` post to that route
 *
 * A mission PR that existed only as `missions.primaryPrNumber` would therefore
 * render nowhere and 404 on merge — the mission would reach "all tasks done"
 * with an invisible, unmergeable PR. So opening the mission PR also creates a
 * task and a worker row to own it, and every one of those surfaces then works
 * with no changes at all.
 *
 * The owning task is `taskClass: 'bookkeeping'`, not `'work'`: it ships no
 * deliverable of its own, and classifying it as work would make it a member of
 * the very set whose completion it is waiting on — `all_prs_merged` would then
 * require the mission PR to be merged before it would agree the mission was
 * ready to open the mission PR.
 */

import { db } from '@buildd/core/db';
import {
  githubRepos,
  missionNotes,
  missions,
  tasks,
  workers,
  workspaces,
} from '@buildd/core/db/schema';
import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import { githubApi } from '@/lib/github';
import {
  isMissionPrTask,
  MISSION_PR_TASK_PREFIX,
  missionIntegrationBase,
} from '@buildd/core/mission-integration';

/**
 * The mission-PR task identity, re-exported rather than reimplemented.
 *
 * It moved into `@buildd/core/mission-integration` when the `all_prs_merged`
 * criterion (which lives in `packages/core` and must stay dependency-light)
 * needed to tell the mission's own PR apart from the task PRs that fed it. Two
 * copies of a "which row is this" rule is how the primaryPrNumber slot came to
 * mean something different in each place that read it.
 */
export { MISSION_PR_TASK_PREFIX, isMissionPrTask };

/** Statuses in which a task still represents unlanded deliverable work. */
const UNFINISHED_TASK_STATUSES = ['pending', 'assigned', 'in_progress'] as const;

/**
 * The branches a *mission-level* PR can target: the workspace's own trunk.
 *
 * `gitConfig.targetBranch` is where a workspace lands work, and
 * `gitConfig.defaultBranch` / `repo.defaultBranch` are the fallbacks the PR
 * creation path itself uses, so the two agree by construction.
 */
export function trunkBranches(
  gitConfig: { targetBranch?: string | null; defaultBranch?: string | null } | null | undefined,
  repoDefaultBranch?: string | null,
): string[] {
  return [gitConfig?.targetBranch, gitConfig?.defaultBranch, repoDefaultBranch]
    .filter((b): b is string => !!b);
}

/**
 * Claim `missions.primaryPrNumber` for the mission's PR — and only for it.
 *
 * The slot used to go to whichever PR under the mission arrived first (P2/B7),
 * which is why the column's meaning drifted to "the first PR any mission task
 * opened". Under the integration-branch model the first *task* PR — based on
 * `mission/<slug>`, not trunk — would steal it outright, and everything
 * downstream (mission card, PR-state notifications, the planning gate) would
 * then read one task's PR as the mission's.
 *
 * Gate: the PR must be based on a trunk branch. An unknown base ref does NOT
 * claim the slot — a PR nobody can classify must not become the mission's.
 *
 * One implementation, deliberately: this codebase has already paid for a
 * hand-mirrored branch-name generator and a duplicated task classifier, so the
 * PR-creation route calls this rather than keeping its own copy.
 */
export async function claimMissionPrimaryPr(
  missionId: string | null | undefined,
  prNumber: number,
  prUrl: string,
  opts: { baseRef: string | null | undefined; trunk: string[] },
): Promise<void> {
  if (!missionId) return;
  if (!opts.baseRef || !opts.trunk.includes(opts.baseRef)) {
    console.log(
      `[mission-pr] PR #${prNumber} base '${opts.baseRef ?? 'unknown'}' is not mission-level `
      + `(trunk: ${opts.trunk.join(', ') || 'none'}) — not claiming primaryPrNumber for mission ${missionId}`,
    );
    return;
  }
  await db
    .update(missions)
    .set({ primaryPrNumber: prNumber, primaryPrUrl: prUrl, updatedAt: new Date() })
    .where(and(eq(missions.id, missionId), isNull(missions.primaryPrNumber)));
}

export interface MissionWorkState {
  /** Every deliverable task is terminal and every deliverable PR has merged. */
  complete: boolean;
  /**
   * Why not, when `complete` is false. `no_deliverable_work` is the honest
   * "there is nothing to ship" verdict and is deliberately NOT complete: an
   * empty set must not open an empty PR.
   */
  reason: 'complete' | 'no_deliverable_work' | 'tasks_unfinished' | 'prs_unmerged';
  unfinishedTaskCount: number;
  unmergedPrCount: number;
}

/**
 * Is this mission's deliverable work all landed on the integration branch?
 *
 * Counts only deliverable tasks — the organizer's planning task and the
 * bookkeeping row that owns the mission PR are excluded, because including
 * either makes the predicate self-referential.
 *
 * Note what this deliberately does NOT do: it never returns `complete` for a
 * mission with zero deliverable tasks. A "green over an empty set" answer here
 * would open a PR with no commits on it, which is the failure mode this
 * codebase keeps rediscovering.
 */
export async function evaluateMissionWorkState(
  missionId: string,
  opts?: {
    /**
     * Task ids to count as landed regardless of their stored status.
     *
     * The webhook calls this while handling the merge of one of these tasks'
     * PRs, and it stamps `workers.mergedAt` before it stamps `tasks.status`.
     * Without this the caller's correctness would depend on where in that
     * handler the call sits — an ordering dependency nothing would catch if it
     * were ever broken, because the observable symptom is a mission PR that
     * just never opens.
     */
    assumeCompletedTaskIds?: string[];
  },
): Promise<MissionWorkState> {
  const assumeCompleted = new Set(opts?.assumeCompletedTaskIds ?? []);
  const missionTasks = (await db.query.tasks.findMany({
    where: eq(tasks.missionId, missionId),
    columns: { id: true, title: true, status: true, mode: true, taskClass: true },
  })) ?? [];

  const deliverable = missionTasks.filter(
    t => t.mode !== 'planning' && t.taskClass === 'work',
  );
  if (deliverable.length === 0) {
    return { complete: false, reason: 'no_deliverable_work', unfinishedTaskCount: 0, unmergedPrCount: 0 };
  }

  const unfinished = deliverable.filter(t =>
    !assumeCompleted.has(t.id) && (UNFINISHED_TASK_STATUSES as readonly string[]).includes(t.status),
  );
  if (unfinished.length > 0) {
    return {
      complete: false,
      reason: 'tasks_unfinished',
      unfinishedTaskCount: unfinished.length,
      unmergedPrCount: 0,
    };
  }

  const unmerged = (await db.query.workers.findMany({
    where: and(
      inArray(workers.taskId, deliverable.map(t => t.id)),
      isNotNull(workers.prUrl),
      isNull(workers.mergedAt),
    ),
    columns: { id: true },
  })) ?? [];
  if (unmerged.length > 0) {
    return {
      complete: false,
      reason: 'prs_unmerged',
      unfinishedTaskCount: 0,
      unmergedPrCount: unmerged.length,
    };
  }

  return { complete: true, reason: 'complete', unfinishedTaskCount: 0, unmergedPrCount: 0 };
}

export type OpenMissionPrResult =
  | { ok: true; prNumber: number; prUrl: string; created: boolean }
  | {
      ok: false;
      reason:
        | 'not_opted_in'
        | 'no_working_branch'
        | 'no_repo'
        | 'work_incomplete'
        | 'no_commits'
        | 'api_error';
      detail?: string;
    };

/**
 * Open the mission's integration PR into trunk, with a worker row to own it.
 *
 * Idempotent: an existing mission-PR worker with a PR short-circuits, and an
 * integration branch with no commits ahead of trunk returns `no_commits`
 * instead of asking GitHub to open an empty PR (which it refuses anyway, with a
 * 422 that reads like a bug).
 */
export async function openMissionIntegrationPr(
  missionId: string,
  opts?: { assumeCompletedTaskIds?: string[] },
): Promise<OpenMissionPrResult> {
  const mission = await db.query.missions.findFirst({
    where: eq(missions.id, missionId),
    columns: {
      id: true,
      title: true,
      workspaceId: true,
      workingBranch: true,
      integrationBranchEnabled: true,
    },
  });
  if (!mission) return { ok: false, reason: 'no_repo', detail: 'mission not found' };
  if (!mission.integrationBranchEnabled) return { ok: false, reason: 'not_opted_in' };

  const branch = missionIntegrationBase(mission);
  if (!branch) return { ok: false, reason: 'no_working_branch' };

  // Already open (or already merged)? Then this is a no-op, and saying
  // `created: false` lets the caller tell "we opened it" from "it was there".
  const existing = await findMissionPrWorker(missionId);
  if (existing?.prNumber && existing.prUrl) {
    return { ok: true, prNumber: existing.prNumber, prUrl: existing.prUrl, created: false };
  }

  const work = await evaluateMissionWorkState(missionId, {
    assumeCompletedTaskIds: opts?.assumeCompletedTaskIds,
  });
  if (!work.complete) {
    return { ok: false, reason: 'work_incomplete', detail: work.reason };
  }

  const workspace = mission.workspaceId
    ? await db.query.workspaces.findFirst({
        where: eq(workspaces.id, mission.workspaceId),
        columns: { id: true, githubRepoId: true, githubInstallationId: true, gitConfig: true },
      })
    : null;
  if (!workspace?.githubRepoId || !workspace.githubInstallationId) {
    return { ok: false, reason: 'no_repo', detail: 'workspace not linked to a GitHub repo' };
  }

  const repo = await db.query.githubRepos.findFirst({
    where: eq(githubRepos.id, workspace.githubRepoId),
    columns: { fullName: true, defaultBranch: true },
    with: { installation: { columns: { installationId: true } } },
  });
  const installationId = repo?.installation?.installationId;
  if (!repo?.fullName || !installationId) {
    return { ok: false, reason: 'no_repo', detail: 'GitHub repo row not found' };
  }

  const base =
    workspace.gitConfig?.targetBranch ||
    workspace.gitConfig?.defaultBranch ||
    repo.defaultBranch ||
    'main';

  // Nothing to ship is not an error, and it is not a PR either.
  try {
    const cmp = await githubApi(
      installationId,
      `/repos/${repo.fullName}/compare/${encodeURIComponent(base)}...${encodeURIComponent(branch)}`,
    );
    if (typeof cmp?.ahead_by === 'number' && cmp.ahead_by === 0) {
      return { ok: false, reason: 'no_commits', detail: `${branch} is not ahead of ${base}` };
    }
  } catch (err) {
    return {
      ok: false,
      reason: 'api_error',
      detail: `could not compare ${branch} against ${base}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // The owning task + worker. Created BEFORE the PR call so a PR that opens but
  // fails to record still has a row to attach to on the next pass, rather than
  // becoming an orphan PR nobody can merge from the dashboard.
  const [ownerTask] = await db
    .insert(tasks)
    .values({
      workspaceId: workspace.id,
      missionId,
      title: `${MISSION_PR_TASK_PREFIX}${mission.title}`,
      description:
        `Integration PR for this mission: merges \`${branch}\` into \`${base}\`.\n\n` +
        `This task exists to own the mission PR so it appears in the merge queue and can be ` +
        `merged from the dashboard. It performs no work of its own and is never claimed by a runner.`,
      mode: 'execution',
      taskClass: 'bookkeeping',
      creationSource: 'orchestrator',
      // Terminal on creation: nothing should ever claim this row. Leaving it
      // claimable would hand a runner a task with no work in it, and would make
      // it count toward the mission's unfinished-work total.
      status: 'completed',
      outputRequirement: 'none',
      priority: 0,
    })
    .returning({ id: tasks.id });

  const [ownerWorker] = await db
    .insert(workers)
    .values({
      workspaceId: workspace.id,
      taskId: ownerTask.id,
      name: `mission-pr-${missionId.slice(0, 8)}`,
      runner: 'system',
      branch,
      status: 'completed',
    })
    .returning({ id: workers.id });

  let prData: { number?: number; html_url?: string; base?: { ref?: string } };
  try {
    prData = await githubApi(installationId, `/repos/${repo.fullName}/pulls`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: `${mission.title}`,
        body: missionPrBody({ missionId, branch, base }),
        head: branch,
        base,
      }),
    });
  } catch (err) {
    return {
      ok: false,
      reason: 'api_error',
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  const prNumber = prData?.number;
  const prUrl = prData?.html_url;
  if (typeof prNumber !== 'number' || !prUrl) {
    return { ok: false, reason: 'api_error', detail: 'GitHub returned no PR number' };
  }

  await db
    .update(workers)
    .set({
      prUrl,
      prNumber,
      prBaseRef: prData.base?.ref ?? base,
      prLifecycleStatus: 'pr_open',
      updatedAt: new Date(),
    })
    .where(eq(workers.id, ownerWorker.id));

  await claimMissionPrimaryPr(missionId, prNumber, prUrl, {
    baseRef: prData.base?.ref ?? base,
    trunk: trunkBranches(workspace.gitConfig, repo.defaultBranch),
  });

  await db.insert(missionNotes).values({
    missionId,
    authorType: 'system',
    type: 'decision',
    title: `Mission PR #${prNumber} opened`,
    body:
      `All deliverable work for this mission has landed on \`${branch}\`, so it now has a single ` +
      `PR into \`${base}\`: ${prUrl}\n\nThis is the mission's review gate — the merge policy tier ` +
      `applies here, not to the task PRs that fed the branch.`,
    status: 'open',
  });

  console.log(`[mission-pr] opened mission PR #${prNumber} (${branch} → ${base}) for mission ${missionId}`);
  return { ok: true, prNumber, prUrl, created: true };
}

/**
 * Open the mission PR if — and only if — it is time to.
 *
 * The guarded entry point for event-driven callers (a task PR merging into the
 * integration branch is the natural trigger). Every "not yet" answer is a
 * normal outcome, so this returns them rather than throwing.
 */
export async function maybeOpenMissionIntegrationPr(
  missionId: string | null | undefined,
  opts?: { assumeCompletedTaskIds?: string[] },
): Promise<OpenMissionPrResult | null> {
  if (!missionId) return null;
  const mission = await db.query.missions.findFirst({
    where: eq(missions.id, missionId),
    columns: { integrationBranchEnabled: true, workingBranch: true },
  });
  // Null, not a result: a mission that never opted in has no mission PR to
  // open, and that is not a failure to report anywhere.
  if (!missionIntegrationBase(mission)) return null;
  return openMissionIntegrationPr(missionId, opts);
}

/** The worker row that owns this mission's integration PR, if one exists. */
export async function findMissionPrWorker(missionId: string) {
  const missionTasks = (await db.query.tasks.findMany({
    where: eq(tasks.missionId, missionId),
    columns: { id: true, title: true, taskClass: true },
  })) ?? [];
  const ownerTaskIds = missionTasks.filter(isMissionPrTask).map(t => t.id);
  if (ownerTaskIds.length === 0) return null;

  return (
    (await db.query.workers.findFirst({
      where: and(inArray(workers.taskId, ownerTaskIds), isNotNull(workers.prUrl)),
      columns: { id: true, prNumber: true, prUrl: true, mergedAt: true, taskId: true },
    })) ?? null
  );
}

function missionPrBody(opts: { missionId: string; branch: string; base: string }): string {
  return [
    `Integration PR for a buildd mission.`,
    '',
    `- Integration branch: \`${opts.branch}\``,
    `- Target: \`${opts.base}\``,
    '',
    `Each task in this mission had its own branch and its own PR into \`${opts.branch}\`.`,
    `Those PRs are already reviewed and merged there; this PR is the single gate for the`,
    `mission as a whole, so it is the one that carries the workspace's merge policy.`,
  ].join('\n');
}
