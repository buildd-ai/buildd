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
  isMissionIntegrationBase,
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
  opts: {
    baseRef: string | null | undefined;
    trunk: string[];
    /**
     * True only for the mission's own integration PR.
     *
     * The trunk gate alone is NOT the same rule as "only the mission PR may
     * claim this": a task PR still lands on trunk whenever the agent passes an
     * explicit `base` to `create_pr`, which sits above `context.baseBranch` in
     * the PR route's fallback chain. That task PR would take the slot and the
     * real mission PR's own claim — guarded on `primaryPrNumber IS NULL` —
     * would then be a silent no-op.
     *
     * Enforced only for a mission that opted into an integration branch. For
     * every other mission the column keeps its legacy meaning (the first
     * trunk-based PR under the mission), so this is inert until the flag is set.
     */
    isMissionPr?: boolean;
  },
): Promise<void> {
  if (!missionId) return;
  if (!opts.baseRef || !opts.trunk.includes(opts.baseRef)) {
    console.log(
      `[mission-pr] PR #${prNumber} base '${opts.baseRef ?? 'unknown'}' is not mission-level `
      + `(trunk: ${opts.trunk.join(', ') || 'none'}) — not claiming primaryPrNumber for mission ${missionId}`,
    );
    return;
  }
  if (!opts.isMissionPr) {
    const mission = await db.query.missions.findFirst({
      where: eq(missions.id, missionId),
      columns: { workingBranch: true, integrationBranchEnabled: true },
    });
    if (missionIntegrationBase(mission)) {
      console.log(
        `[mission-pr] PR #${prNumber} is trunk-based but is not mission ${missionId}'s integration PR `
        + `— not claiming primaryPrNumber (the mission uses an integration branch)`,
      );
      return;
    }
  }
  await db
    .update(missions)
    .set({ primaryPrNumber: prNumber, primaryPrUrl: prUrl, updatedAt: new Date() })
    .where(and(eq(missions.id, missionId), isNull(missions.primaryPrNumber)));
}

/**
 * Worker states in which a PR row still represents work waiting to land.
 *
 * A PR that was closed unmerged, or given up on, will never merge — so it must
 * not count as outstanding. Every other gate in this codebase carries this
 * exclusion (`claim/route.ts`, `claim/deps-gate.ts`, `mission-run.ts`); this one
 * did not, and a single superseded retry PR or one human-closed PR pinned the
 * mission at `prs_unmerged` permanently.
 */
const DEAD_PR_LIFECYCLE = new Set(['closed', 'merged', 'unresolvable']);

interface WorkerRow {
  taskId: string | null;
  prUrl: string | null;
  prNumber: number | null;
  prBaseRef: string | null;
  mergedAt: Date | null;
  prLifecycleStatus: string | null;
  startedAt: Date | null;
  createdAt: Date;
}

/**
 * The newest worker per task.
 *
 * Ordered in JS rather than by SQL `orderBy` on purpose: `workers.startedAt` is
 * nullable with no default, and Postgres `DESC` sorts NULLs *first*, so a
 * never-started worker would outrank the real one. Falls back to `createdAt`.
 */
function latestWorkerByTask(rows: WorkerRow[]): Map<string, WorkerRow> {
  const rank = (w: WorkerRow) => (w.startedAt ?? w.createdAt)?.valueOf() ?? 0;
  const out = new Map<string, WorkerRow>();
  for (const w of rows) {
    if (!w.taskId) continue;
    const seen = out.get(w.taskId);
    if (!seen || rank(w) >= rank(seen)) out.set(w.taskId, w);
  }
  return out;
}

/** Does this worker hold a PR that is still expected to merge? */
function holdsLivePr(w: WorkerRow | undefined): boolean {
  if (!w?.prUrl) return false;
  if (w.mergedAt) return false;
  return !DEAD_PR_LIFECYCLE.has(w.prLifecycleStatus ?? '');
}

/** One deliverable task's branch/PR state, as the mission PR body reports it. */
export interface TaskBranchSummary {
  taskId: string;
  title: string;
  branch: string | null;
  prNumber: number | null;
  state: 'merged' | 'open' | 'closed' | 'no_pr';
}

/**
 * The task branches that fed this mission's integration branch — one row per
 * deliverable task, each with its branch, PR number and state.
 *
 * Used to render the mission PR's topology (P4): a reviewer deciding on the
 * mission PR currently cannot see what fed it, and this is the source of that
 * text. Same deliverable filter and same "newest worker per task" rule as
 * `evaluateMissionWorkState`, deliberately — a task's row here must agree with
 * whether that task counted as landed there.
 */
export async function describeMissionIntegrationTopology(missionId: string): Promise<TaskBranchSummary[]> {
  const missionTasks = (await db.query.tasks.findMany({
    where: eq(tasks.missionId, missionId),
    columns: { id: true, title: true, mode: true, taskClass: true },
  })) ?? [];
  const deliverable = missionTasks.filter(t => t.mode !== 'planning' && t.taskClass === 'work');
  if (deliverable.length === 0) return [];

  const allWorkers = ((await db.query.workers.findMany({
    where: inArray(workers.taskId, deliverable.map(t => t.id)),
    columns: {
      taskId: true, branch: true, prUrl: true, prNumber: true,
      mergedAt: true, prLifecycleStatus: true, startedAt: true, createdAt: true,
    },
  })) ?? []) as Array<WorkerRow & { branch: string | null }>;
  const latest = latestWorkerByTask(allWorkers);

  return deliverable.map(t => {
    const w = latest.get(t.id) as (WorkerRow & { branch: string | null }) | undefined;
    const state: TaskBranchSummary['state'] = !w?.prNumber
      ? 'no_pr'
      : w.mergedAt
        ? 'merged'
        : DEAD_PR_LIFECYCLE.has(w.prLifecycleStatus ?? '')
          ? 'closed'
          : 'open';
    return {
      taskId: t.id,
      title: t.title,
      branch: w?.branch ?? null,
      prNumber: w?.prNumber ?? null,
      state,
    };
  });
}

export interface MissionWorkState {
  /** Every deliverable task has landed, and none is still waiting on a PR. */
  complete: boolean;
  /**
   * Why not, when `complete` is false. `no_deliverable_work` is the honest
   * "there is nothing to ship" verdict and is deliberately NOT complete: an
   * empty set must not open an empty PR.
   */
  reason: 'complete' | 'no_deliverable_work' | 'tasks_unfinished' | 'prs_unmerged';
  unfinishedTaskCount: number;
  unmergedPrCount: number;
  /**
   * Deliverable tasks whose PR merged into this mission's integration branch.
   * Zero means the mission has nothing for a mission PR to carry — the honest
   * "nothing to ship" signal, and the reason a mission whose work was all
   * cancelled must not be held open waiting for a PR that would be empty.
   */
  landedOnIntegrationCount: number;
}

/**
 * Is this mission's deliverable work all landed on the integration branch?
 *
 * Counts only deliverable tasks — the organizer's planning task and the
 * bookkeeping row that owns the mission PR are excluded, because including
 * either makes the predicate self-referential.
 *
 * **Landedness is read from `workers`, not from `tasks.status`.** A task whose
 * PR has merged has landed, whatever its row currently says. That matters
 * because the webhook stamps `workers.mergedAt` *before* `tasks.status`, so two
 * of a mission's last task PRs merging concurrently would each see the other's
 * task still `in_progress` and both decline to open the mission PR — and since
 * the webhook is the trigger, both declining means it never opens.
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
     * Redundant by construction now that landedness comes from
     * `workers.mergedAt` — kept because it costs nothing and a caller that
     * knows more than the database should be able to say so.
     */
    assumeCompletedTaskIds?: string[];
  },
): Promise<MissionWorkState> {
  const assumeCompleted = new Set(opts?.assumeCompletedTaskIds ?? []);
  const mission = await db.query.missions.findFirst({
    where: eq(missions.id, missionId),
    columns: { workingBranch: true, integrationBranchEnabled: true },
  });
  const missionTasks = (await db.query.tasks.findMany({
    where: eq(tasks.missionId, missionId),
    columns: { id: true, title: true, status: true, mode: true, taskClass: true },
  })) ?? [];

  const deliverable = missionTasks.filter(
    t => t.mode !== 'planning' && t.taskClass === 'work',
  );
  const empty = {
    complete: false as const,
    unfinishedTaskCount: 0,
    unmergedPrCount: 0,
    landedOnIntegrationCount: 0,
  };
  if (deliverable.length === 0) {
    return { ...empty, reason: 'no_deliverable_work' };
  }

  const allWorkers = ((await db.query.workers.findMany({
    where: inArray(workers.taskId, deliverable.map(t => t.id)),
    columns: {
      taskId: true, prUrl: true, prNumber: true, prBaseRef: true,
      mergedAt: true, prLifecycleStatus: true, startedAt: true, createdAt: true,
    },
  })) ?? []) as WorkerRow[];
  const latest = latestWorkerByTask(allWorkers);

  const landedOnIntegrationCount = deliverable.filter(t => {
    const w = latest.get(t.id);
    return !!w?.mergedAt && isMissionIntegrationBase({ baseRef: w.prBaseRef, mission });
  }).length;

  // Waiting on a PR: the task's live worker holds one that is still expected to
  // merge. Checked before the status sweep so a `completed` task with an open PR
  // reports the PR, which is the actionable blocker.
  const awaitingPr = deliverable.filter(t => holdsLivePr(latest.get(t.id)));

  // Unfinished: a non-terminal task that has not already landed a PR. A merged
  // PR outranks the row's status — see the note above.
  const unfinished = deliverable.filter(t => {
    if (assumeCompleted.has(t.id)) return false;
    if (latest.get(t.id)?.mergedAt) return false;
    return (UNFINISHED_TASK_STATUSES as readonly string[]).includes(t.status);
  });

  if (unfinished.length > 0) {
    return {
      ...empty,
      reason: 'tasks_unfinished',
      unfinishedTaskCount: unfinished.length,
      landedOnIntegrationCount,
    };
  }
  if (awaitingPr.length > 0) {
    return {
      ...empty,
      reason: 'prs_unmerged',
      unmergedPrCount: awaitingPr.length,
      landedOnIntegrationCount,
    };
  }

  return {
    complete: true,
    reason: 'complete',
    unfinishedTaskCount: 0,
    unmergedPrCount: 0,
    landedOnIntegrationCount,
  };
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
        | 'mission_pr_closed'
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

  // What state is this mission's PR in? The three answers are genuinely
  // different, and collapsing them into "a PR exists, stop" was three separate
  // stuck states:
  //
  //  - `open`   — the live gate. Nothing to do; the normal answer on every task
  //               PR merge after the first.
  //  - `merged` — fall THROUGH. A mission can produce more work after its PR
  //               merged (a heartbeat mission, a follow-up, a CI retry), and
  //               short-circuiting stranded that work on the integration branch
  //               while the completion gate — seeing a merged mission PR —
  //               passed the mission as done. A false green, not a stall. The
  //               `ahead_by === 0` check below stops an empty second PR.
  //  - `closed` — a human closed the mission PR. Do NOT reopen it
  //               automatically: that fights an explicit decision. Report it so
  //               the caller logs something actionable instead of the mission
  //               silently never completing.
  const owner = await findMissionPrOwner(missionId);
  if (owner?.state === 'open') {
    return { ok: true, prNumber: owner.prNumber ?? 0, prUrl: owner.prUrl, created: false };
  }
  if (owner?.state === 'closed') {
    return {
      ok: false,
      reason: 'mission_pr_closed',
      detail: `mission PR${owner.prNumber ? ` #${owner.prNumber}` : ''} was closed without merging`,
    };
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
    // A 404 here means GitHub has no such head branch — it was deleted on merge
    // and nothing has recreated it. That is "nothing to ship", not a failure:
    // there is no ref for a PR to carry. Reporting it as `api_error` made the
    // mission PR sweep log and count an error on every run, forever, for every
    // mission that had already shipped (an hourly "running but accomplishing
    // nothing" alert). The `merged` state deliberately falls through to here
    // (see the state comment above) so that a *recreated* branch still gets its
    // second PR — so this must stay a per-attempt classification, not a
    // short-circuit on merge.
    if (githubErrorStatus(err) === 404) {
      return { ok: false, reason: 'no_commits', detail: `${branch} no longer exists on the remote` };
    }
    return {
      ok: false,
      reason: 'api_error',
      detail: `could not compare ${branch} against ${base}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Does GitHub already have this PR? Reachable two ways: a previous attempt
  // created it and died before recording it, or two webhook deliveries for the
  // same merge raced and the loser's `POST /pulls` will 422.
  //
  // GitHub is the authority on "is there an open PR from this branch", and it
  // enforces one per head→base, so asking is both cheaper and more correct than
  // a local claim. Adopting means the row carries the real PR instead of the
  // caller reporting `api_error` and leaving a PR nobody can merge from the
  // dashboard — which is what the insert-before-POST ordering below was
  // supposed to make recoverable and did not.
  const adoptable = await findOpenPrForBranch(installationId, repo.fullName, branch, base);

  // Reuse the mission's existing owner rows rather than adding a pair per
  // attempt. Without this, a failed `POST /pulls` leaves a row with no `prUrl`,
  // the next attempt does not recognise it as an owner, and the mission
  // accumulates one dead task+worker pair per retrigger — one of which the
  // completion gate may then pick and refuse on forever.
  const reusableTask = (await db.query.tasks.findMany({
    where: eq(tasks.missionId, missionId),
    columns: { id: true, title: true, taskClass: true },
  }))?.find(isMissionPrTask) ?? null;

  const [ownerTask] = reusableTask ? [reusableTask] : await db
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

  // An owner worker with no `prUrl` is a previous attempt that never reached
  // GitHub — attach to it instead of adding another.
  const orphan = reusableTask
    ? (await db.query.workers.findFirst({
        where: and(eq(workers.taskId, reusableTask.id), isNull(workers.prUrl)),
        columns: { id: true },
      })) ?? null
    : null;

  const ownerWorker = orphan ?? (await db
    .insert(workers)
    .values({
      workspaceId: workspace.id,
      taskId: ownerTask.id,
      name: `mission-pr-${missionId.slice(0, 8)}`,
      runner: 'system',
      branch,
      status: 'completed',
    })
    .returning({ id: workers.id }))[0];

  let prData: { number?: number; html_url?: string; base?: { ref?: string } } | null = adoptable;
  if (!prData) {
    try {
      const topology = await describeMissionIntegrationTopology(missionId);
      prData = await githubApi(installationId, `/repos/${repo.fullName}/pulls`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: `${mission.title}`,
          body: missionPrBody({ missionId, branch, base, topology }),
          head: branch,
          base,
        }),
      });
    } catch (err) {
      // 422 is almost always "a pull request already exists for this head". Ask
      // GitHub again rather than reporting a failure: the post-condition we
      // wanted may now hold because someone else created it.
      prData = githubErrorStatus(err) === 422
        ? await findOpenPrForBranch(installationId, repo.fullName, branch, base)
        : null;
      if (!prData) {
        return {
          ok: false,
          reason: 'api_error',
          detail: err instanceof Error ? err.message : String(err),
        };
      }
    }
  }

  const prNumber = prData?.number;
  const prUrl = prData?.html_url;
  if (!prData || typeof prNumber !== 'number' || !prUrl) {
    return { ok: false, reason: 'api_error', detail: 'GitHub returned no PR number' };
  }
  const recordedBaseRef = prData.base?.ref ?? base;

  await db
    .update(workers)
    .set({
      prUrl,
      prNumber,
      prBaseRef: recordedBaseRef,
      prLifecycleStatus: 'pr_open',
      updatedAt: new Date(),
    })
    .where(eq(workers.id, ownerWorker.id));

  await claimMissionPrimaryPr(missionId, prNumber, prUrl, {
    baseRef: recordedBaseRef,
    trunk: trunkBranches(workspace.gitConfig, repo.defaultBranch),
    isMissionPr: true,
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

/** Lifecycle of a mission integration PR, as the mission's own gate sees it. */
export type MissionPrState = 'open' | 'merged' | 'closed';

export interface MissionPrOwner {
  taskId: string;
  workerId: string;
  prNumber: number | null;
  prUrl: string;
  mergedAt: Date | null;
  state: MissionPrState;
}

/**
 * The mission's integration PR, and what state it is in.
 *
 * One implementation, called by the opener AND by `canCompleteMission`. They
 * used to answer this question separately and disagreed: the opener scanned
 * every worker of the mission, the completion gate took `workers[0]` of an
 * unordered query, and with two owner rows in play whichever row Postgres
 * happened to return first decided whether the mission could close.
 *
 * Deterministic on purpose — newest PR-bearing worker wins — because more than
 * one owner row can exist: if a `POST /pulls` fails after the owner rows are
 * inserted, the next attempt finds a row with no `prUrl`.
 *
 * Returns null when this mission has never had a mission PR. Rows with no
 * `prUrl` are skipped rather than returned: they represent an attempt that did
 * not reach GitHub, not a PR.
 */
export async function findMissionPrOwner(missionId: string): Promise<MissionPrOwner | null> {
  const missionTasks = (await db.query.tasks.findMany({
    where: eq(tasks.missionId, missionId),
    columns: { id: true, title: true, taskClass: true },
  })) ?? [];
  const ownerTaskIds = missionTasks.filter(isMissionPrTask).map(t => t.id);
  if (ownerTaskIds.length === 0) return null;

  const rows = ((await db.query.workers.findMany({
    where: and(inArray(workers.taskId, ownerTaskIds), isNotNull(workers.prUrl)),
    columns: {
      id: true, taskId: true, prNumber: true, prUrl: true,
      mergedAt: true, prLifecycleStatus: true, startedAt: true, createdAt: true,
    },
  })) ?? []) as Array<WorkerRow & { id: string }>;
  if (rows.length === 0) return null;

  const rank = (w: WorkerRow) => (w.startedAt ?? w.createdAt)?.valueOf() ?? 0;
  const newest = rows.reduce((a, b) => (rank(b) >= rank(a) ? b : a));

  const state: MissionPrState = newest.mergedAt
    ? 'merged'
    : DEAD_PR_LIFECYCLE.has(newest.prLifecycleStatus ?? '')
      ? 'closed'
      : 'open';

  return {
    taskId: newest.taskId!,
    workerId: newest.id,
    prNumber: newest.prNumber,
    prUrl: newest.prUrl!,
    mergedAt: newest.mergedAt,
    state,
  };
}

/** Back-compat alias. Prefer {@link findMissionPrOwner}, which reports state. */
export async function findMissionPrWorker(missionId: string) {
  const owner = await findMissionPrOwner(missionId);
  return owner
    ? { id: owner.workerId, prNumber: owner.prNumber, prUrl: owner.prUrl, mergedAt: owner.mergedAt, taskId: owner.taskId }
    : null;
}

/** Extract the HTTP status out of the error `githubApi` throws on non-2xx. */
function githubErrorStatus(err: unknown): number | null {
  const msg = err instanceof Error ? err.message : String(err);
  const m = /GitHub API error: (\d{3})/.exec(msg);
  return m ? Number(m[1]) : null;
}

/**
 * The open PR from `branch` into `base`, if GitHub already has one.
 *
 * Best effort: a failure returns null, which sends the caller down the create
 * path — worst case a 422 that the caller re-resolves through this same
 * function.
 */
async function findOpenPrForBranch(
  installationId: number,
  repoFullName: string,
  branch: string,
  base: string,
): Promise<{ number?: number; html_url?: string; base?: { ref?: string } } | null> {
  const owner = repoFullName.split('/')[0];
  try {
    const prs = await githubApi(
      installationId,
      `/repos/${repoFullName}/pulls?state=open`
      + `&head=${encodeURIComponent(`${owner}:${branch}`)}`
      + `&base=${encodeURIComponent(base)}`,
    );
    return Array.isArray(prs) && prs.length > 0 ? prs[0] : null;
  } catch {
    return null;
  }
}

/**
 * The mission PR body, including its topology: the task branches that fed the
 * integration branch (each with its PR number and state), then the
 * integration branch, then trunk (P4). Plain text, three levels, so a
 * reviewer can see what fed this PR — and so a violation (a task branch with
 * no PR, or a PR still open) is visible on sight rather than requiring a
 * separate lookup.
 */
function missionPrBody(opts: {
  missionId: string;
  branch: string;
  base: string;
  topology: TaskBranchSummary[];
}): string {
  const taskLines = opts.topology.length > 0
    ? opts.topology.map(t => {
        const branchLabel = t.branch ? `\`${t.branch}\`` : '(no branch)';
        const prLabel = t.prNumber ? `PR #${t.prNumber} — ${t.state}` : 'no PR';
        return `  - ${branchLabel} — ${t.title} — ${prLabel}`;
      }).join('\n')
    : '  (no deliverable tasks)';

  return [
    `Integration PR for a buildd mission.`,
    '',
    `Topology:`,
    taskLines,
    `  ↓`,
    `  \`${opts.branch}\` — integration branch`,
    `  ↓`,
    `  \`${opts.base}\` — trunk`,
    '',
    `Each task in this mission had its own branch and its own PR into \`${opts.branch}\`.`,
    `Those PRs are already reviewed and merged there; this PR is the single gate for the`,
    `mission as a whole, so it is the one that carries the workspace's merge policy.`,
  ].join('\n');
}

/** Outcome of {@link guardMissionPrMerge}. */
export type MissionPrMergeGate = { blocks: false } | { blocks: true; reason: string };

/**
 * May this task's PR merge right now?
 *
 * The merge-side counterpart to the `awaitingPr` logic in
 * `evaluateMissionWorkState`, which owns OPENING the mission PR on the same
 * condition. `openMissionIntegrationPr` never opens the mission PR while a
 * task PR is still unmerged — but nothing enforced that at MERGE time, and
 * merging is where a premature branch deletion actually happens (P3).
 *
 * Returns `{ blocks: false }` for any PR that is not the mission PR itself —
 * every other merge is unaffected. For the mission PR, refuses while any
 * task PR based on the integration branch is still open: merging deletes
 * that branch (`finalizeMissionPrMerge`), which would orphan every PR still
 * targeting it — the exact production shape (six task PRs stranded by one
 * premature merge) this closes.
 */
export async function guardMissionPrMerge(
  task: { title?: string | null; taskClass?: string | null; missionId?: string | null } | null | undefined,
): Promise<MissionPrMergeGate> {
  if (!task || !isMissionPrTask(task) || !task.missionId) return { blocks: false };
  const work = await evaluateMissionWorkState(task.missionId);
  if (work.unmergedPrCount > 0) {
    const plural = work.unmergedPrCount === 1;
    return {
      blocks: true,
      reason:
        `${work.unmergedPrCount} task PR(s) based on this mission's integration branch ` +
        `${plural ? 'is' : 'are'} still open — merging the mission PR now would delete the ` +
        `integration branch out from under ${plural ? 'it' : 'them'}`,
    };
  }
  return { blocks: false };
}

/**
 * After a mission PR merges, delete its integration branch — deliberately,
 * not via the repo's delete-branch-on-merge setting.
 *
 * That repo setting cannot be scoped to "only after every task PR based on
 * this branch has already landed" — it fires on ANY merge with the branch as
 * head, which is exactly how a prior mission lost six task PRs' review gate:
 * the mission PR merged early, the setting deleted the branch, and GitHub
 * silently retargeted the still-open task PRs to trunk. `guardMissionPrMerge`
 * above closes the "early" half; this closes the other half by having buildd
 * own the deletion itself, at the moment it is actually safe.
 *
 * No-op for anything that is not a mission PR. Best-effort: a failed delete
 * leaves a stale branch, not a broken mission.
 */
export async function finalizeMissionPrMerge(
  task: { title?: string | null; taskClass?: string | null; missionId?: string | null } | null | undefined,
  installationId: number,
  repoFullName: string,
): Promise<void> {
  if (!task || !isMissionPrTask(task) || !task.missionId) return;
  const mission = await db.query.missions.findFirst({
    where: eq(missions.id, task.missionId),
    columns: { workingBranch: true, integrationBranchEnabled: true },
  });
  const branch = missionIntegrationBase(mission);
  if (!branch) return;
  try {
    await githubApi(
      installationId,
      `/repos/${repoFullName}/git/refs/heads/${encodeURIComponent(branch)}`,
      { method: 'DELETE' },
    );
    console.log(`[mission-pr] deleted integration branch '${branch}' on ${repoFullName} after mission PR merge`);
  } catch (err) {
    console.error(`[mission-pr] failed to delete integration branch '${branch}' on ${repoFullName}:`, err);
  }
}
