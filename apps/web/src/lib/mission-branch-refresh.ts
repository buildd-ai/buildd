/**
 * Keep a mission's integration branch current with dev — automatically.
 *
 * docs/design/mission-delivery-arc.md P5 (2026-09-05) decided against this: "no
 * automatic `dev → mission/*` merge in v1 ... the failure mode to watch is long
 * missions routinely ending in conflict resolution." That failure mode became
 * routine (mission 419f11ea's hand-opened PR #2963 conflicted 26 commits behind
 * dev; the Jev scheduling mission needed a manual sync task before its PR could
 * open), so P5 is superseded by this module.
 *
 * Direction is one-way: dev → mission/*. The mission still reaches trunk
 * through exactly one PR, reviewed under the workspace's normal merge policy —
 * nothing here opens or merges that PR.
 *
 * ## Mechanism
 *
 * A clean merge costs nothing: GitHub's merges API (`POST /repos/:o/:r/merges`)
 * either lands a merge commit (201), reports the branch already current (204),
 * or refuses with a real conflict (409). No agent, no PR, no review — dev
 * content is already reviewed, and a merge commit (never squash/rebase, never a
 * force-push) is the only thing that happens to the integration branch here.
 *
 * A 409 dispatches exactly ONE conflict-resolution task per mission
 * (`missions.branchRefreshConflictTaskId`), reusing the same shape as
 * `conflict-retry.ts`'s per-PR retries: its PR targets the integration branch
 * and must land as a merge commit too (see `requireMergeCommit` in its
 * context, honored by every merge door via `integration-refresh.ts`) —
 * squashing it would lose the ancestry the merge was for, and the same
 * conflict would reappear on the very next refresh.
 *
 * A merged refresh PR is not taken on trust: the task stays the mission's one
 * conflict task until the integration branch's live head provably contains the
 * trunk sha it was dispatched for (`settleConflictTask`). A squash that slipped
 * through (a person merging on GitHub) is recorded once and stops further
 * dispatches instead of opening a new PR for the same conflict on every merge.
 *
 * ## Debounce
 *
 * Two independent mechanisms, because a burst of dev merges arrives both
 * concurrently (several webhook deliveries racing) and sequentially (one
 * finishes, another fires moments later):
 *
 *  - **Single-flight** (`branchRefreshLeaseUntil`): an atomic claim so two
 *    concurrent calls for the same mission never both hit the GitHub API.
 *  - **Idempotency** (`branchRefreshHeadSha`): a refresh compares trunk's live
 *    head against the sha it last confirmed merged in and skips entirely when
 *    they agree — so a second trigger for dev state buildd has already caught
 *    up to costs one cheap read (trunk's ref) and never a write to the
 *    integration branch.
 *
 * Together these coalesce any burst into exactly one real merge attempt.
 *
 * ## When it runs (docs/specs/mission-branch-refresh.md)
 *
 * Not on every trunk merge. That trigger turned each round of dev churn into
 * its own conflict task, and each one moved the branch under every open task
 * PR. A refresh runs when a stale base actually costs something:
 *
 *  - **A mission task starts** (`refreshMissionBranchesBeforeStart`, from the
 *    claim route): a work task cutting its branch from the integration branch
 *    starts on current trunk. Bounded and fail-open; the claim never waits on
 *    it past its budget.
 *  - **The mission is about to land**: nothing here. The mission PR into
 *    trunk is a kernel delivery, and an approved, behind one is updated by
 *    `refresh_branch` through the landing lane.
 *  - **A daily backstop** (`sweepMissionBranchRefresh`): a mission still in
 *    use whose last confirmed refresh (`branchRefreshedAt`) is older than
 *    `BRANCH_REFRESH_BACKSTOP_MS`, so an idle stretch never grows one huge
 *    conflict. It also reconciles what a request left unfinished: an
 *    abandoned lease, or a conflict pointer to settle.
 *
 * Every other writer to the branch (task PR landings, the repair's landing,
 * the kernel's own refresh and landing of the mission PR) and how each is
 * fenced is the spec's "Lifecycle and concurrency" section. The lease here
 * serializes refresh callers for one mission, and nothing else.
 */

import { randomUUID } from 'node:crypto';
import { db } from '@buildd/core/db';
import { missions, missionNotes, tasks, workers, workspaces, githubRepos } from '@buildd/core/db/schema';
import { TERMINAL_TASK_STATUSES, type MissionStatusValue } from '@buildd/shared';
import { and, desc, eq, inArray, isNotNull, lt, isNull, notInArray, or, type SQL } from 'drizzle-orm';
import { githubApi } from '@/lib/github';
import { missionIntegrationBase } from '@buildd/core/mission-integration';
import { GATE_SLUGS, fireGateEvent } from '@/lib/gate-ledger';
import { announceTaskCreated, wakeTask } from '@/lib/dispatch-authority';
import { resolveMissionRepoWorkspaceId } from '@/lib/mission-repo-workspace';
import { ensureMissionIntegrationBranch } from '@/lib/mission-integration-branch';
import { findMissionPrOwner } from '@/lib/mission-pr';
import { integrationRefreshOf, verifyRefreshLanded } from '@/lib/integration-refresh';
import { sqlOrderBy, sqlWhere } from '@buildd/core/db/relational-sql';

/** How long a single-flight claim holds, before another caller may retry it. */
export const BRANCH_REFRESH_LEASE_MS = 45_000;
/** The backstop refreshes a mission still in use once its last confirmed refresh is this old. */
export const BRANCH_REFRESH_BACKSTOP_MS = 24 * 60 * 60 * 1000;
/** The most a starting task's claim waits on its mission's refresh. */
export const START_REFRESH_BUDGET_MS = 4_000;

function githubErrorStatus(err: unknown): number | null {
  const msg = err instanceof Error ? err.message : String(err);
  const m = /GitHub API error: (\d{3})/.exec(msg);
  return m ? Number(m[1]) : null;
}

function githubErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Who asked. `start` is a task being claimed: an authorized start, so it may
 * refresh a paused or held mission (that start is the resume). `backstop` is
 * unsolicited upkeep, which a paused, held or budget-exhausted mission never
 * gets (docs/specs/mission-branch-refresh.md, "Eligibility").
 */
export type RefreshTrigger = 'start' | 'backstop';

const TERMINAL_MISSION_STATUSES = ['completed', 'archived'] as const satisfies readonly MissionStatusValue[];
const PAUSED_MISSION_STATUSES = ['paused', 'budget_exhausted'] as const satisfies readonly MissionStatusValue[];

function refusedStatuses(trigger: RefreshTrigger): MissionStatusValue[] {
  return trigger === 'start'
    ? [...TERMINAL_MISSION_STATUSES]
    : [...TERMINAL_MISSION_STATUSES, ...PAUSED_MISSION_STATUSES];
}

/** Why this mission may not be refreshed by this trigger right now, or null. */
function ineligibility(
  m: { status: string; isHeld?: boolean | null },
  trigger: RefreshTrigger,
): 'mission_terminal' | 'mission_paused' | null {
  if ((TERMINAL_MISSION_STATUSES as readonly string[]).includes(m.status)) return 'mission_terminal';
  if (trigger === 'backstop' && ((PAUSED_MISSION_STATUSES as readonly string[]).includes(m.status) || m.isHeld === true)) {
    return 'mission_paused';
  }
  return null;
}

export type MissionBranchRefreshOutcome =
  | {
      kind: 'skipped';
      reason:
        | 'not_opted_in'
        | 'mission_terminal'
        | 'mission_paused'
        | 'mission_pr_merged'
        | 'conflict_task_open'
        | 'refresh_unverified'
        | 'in_flight'
        | 'already_current'
        | 'no_repo'
        | 'empty_repo';
      detail?: string;
      conflictTaskId?: string;
    }
  | { kind: 'merged'; headSha: string }
  | { kind: 'conflict'; conflictTaskId: string; dispatched: boolean }
  | { kind: 'error'; detail: string };

/**
 * Refresh one mission's integration branch against its workspace's trunk.
 *
 * Idempotent and safe under concurrency — see the module doc for the two
 * debounce mechanisms. Mission state is checked on entry and again, as a
 * WHERE fence, at each commit boundary (the lease renewal just before the
 * merges API, and the conflict-task reservation), so a mission completed,
 * archived or paused while this runs gets no write. Never throws for a GitHub
 * or eligibility outcome: each is typed.
 */
export async function refreshMissionIntegrationBranch(
  missionId: string,
  opts: { trigger?: RefreshTrigger } = {},
): Promise<MissionBranchRefreshOutcome> {
  const trigger = opts.trigger ?? 'backstop';
  const mission = await db.query.missions.findFirst({
    where: sqlWhere(eq(missions.id, missionId)),
    columns: {
      id: true,
      title: true,
      status: true,
      isHeld: true,
      workspaceId: true,
      workingBranch: true,
      integrationBranchEnabled: true,
      branchRefreshHeadSha: true,
      branchRefreshLeaseUntil: true,
      branchRefreshConflictTaskId: true,
    },
  });
  if (!mission) return { kind: 'skipped', reason: 'no_repo', detail: 'mission not found' };

  const branch = missionIntegrationBase(mission);
  if (!branch) return { kind: 'skipped', reason: 'not_opted_in' };
  const refused = ineligibility(mission, trigger);
  if (refused) return { kind: 'skipped', reason: refused, detail: mission.status };

  // The mission's own PR into trunk already merged — the mission's one shot at
  // trunk has been taken, and refreshing a branch nothing will ever merge again
  // wastes a GitHub call on every future trigger forever.
  const owner = await findMissionPrOwner(missionId);
  if (owner?.state === 'merged') {
    return { kind: 'skipped', reason: 'mission_pr_merged' };
  }

  const resolved = await resolveMissionRepoWorkspaceId({
    missionId,
    missionWorkspaceId: mission.workspaceId,
  });
  if (!resolved.workspaceId) {
    return { kind: 'skipped', reason: 'no_repo', detail: resolved.detail ?? undefined };
  }
  const workspace = await db.query.workspaces.findFirst({
    where: sqlWhere(eq(workspaces.id, resolved.workspaceId)),
    columns: { id: true, githubRepoId: true, githubInstallationId: true, gitConfig: true },
  });
  if (!workspace?.githubRepoId || !workspace.githubInstallationId) {
    return { kind: 'skipped', reason: 'no_repo', detail: 'workspace not linked to a GitHub repo' };
  }
  const repo = await db.query.githubRepos.findFirst({
    where: sqlWhere(eq(githubRepos.id, workspace.githubRepoId)),
    columns: { fullName: true, defaultBranch: true },
    with: { installation: { columns: { installationId: true } } },
  });
  const installationId = repo?.installation?.installationId;
  if (!repo?.fullName || !installationId) {
    return { kind: 'skipped', reason: 'no_repo', detail: 'GitHub repo row not found' };
  }
  const trunk =
    workspace.gitConfig?.targetBranch || workspace.gitConfig?.defaultBranch || repo.defaultBranch || 'main';

  // Single-flight claim. Released on every exit path below.
  const leaseToken = randomUUID();
  const ownsLease = and(eq(missions.id, missionId), eq(missions.branchRefreshLeaseToken, leaseToken));
  const [claimed] = await db
    .update(missions)
    .set({ branchRefreshLeaseUntil: new Date(Date.now() + BRANCH_REFRESH_LEASE_MS), branchRefreshLeaseToken: leaseToken })
    .where(and(
      eq(missions.id, missionId),
      or(isNull(missions.branchRefreshLeaseUntil), lt(missions.branchRefreshLeaseUntil, new Date())),
    ))
    .returning({ id: missions.id });
  if (!claimed) {
    return { kind: 'skipped', reason: 'in_flight' };
  }
  const releaseLease = () =>
    db.update(missions).set({ branchRefreshLeaseUntil: null, branchRefreshLeaseToken: null }).where(ownsLease);
  // The mission may still take a write from this trigger: the fence every
  // commit-boundary UPDATE carries, so a state change mid-refresh wins.
  const stillEligible = trigger === 'start'
    ? notInArray(missions.status, refusedStatuses(trigger))
    : and(notInArray(missions.status, refusedStatuses(trigger)), eq(missions.isHeld, false));
  /** Why a fenced write matched nothing: the mission changed state, or ownership moved on. */
  const whyFenced = async (): Promise<MissionBranchRefreshOutcome> => {
    const now = await db.query.missions.findFirst({ where: sqlWhere(eq(missions.id, missionId)) });
    const changed = now ? ineligibility(now, trigger) : null;
    return changed ? { kind: 'skipped', reason: changed, detail: now?.status } : { kind: 'skipped', reason: 'in_flight' };
  };

  try {
    // The pre-lease snapshot may be stale after another caller finishes.
    const current = await db.query.missions.findFirst({ where: sqlWhere(eq(missions.id, missionId)) });
    if (!current || current.branchRefreshLeaseToken !== leaseToken) return { kind: 'skipped', reason: 'in_flight' };
    const changed = ineligibility(current, trigger);
    if (changed) return { kind: 'skipped', reason: changed, detail: current.status };
    // A conflict task is in flight: stop retrying until it is settled — its PR
    // merged AND the branch provably caught up, or it ended without a merge.
    // Every later trunk advance coalesces into it rather than opening another.
    if (current.branchRefreshConflictTaskId) {
      const settled = await settleConflictTask({
        taskId: current.branchRefreshConflictTaskId,
        missionId,
        branch,
        trunk,
        workspaceId: workspace.id,
        installationId,
        repoFullName: repo.fullName,
      });
      if (settled.kind === 'reserved') {
        // The pointer names a task row that was never written: the caller that
        // reserved it died (or is still inserting). Finish its dispatch under
        // the SAME id. The insert is idempotent on that id, so a slow original
        // and this caller produce one task between them, and a crash between
        // reservation and insert can no longer stop refreshing for good.
        let trunkSha: string | null = null;
        try {
          const trunkRef = await githubApi(installationId, `/repos/${repo.fullName}/git/ref/heads/${trunk}`);
          trunkSha = typeof trunkRef?.object?.sha === 'string' ? trunkRef.object.sha : null;
        } catch { /* reported below */ }
        if (!trunkSha) return { kind: 'error', detail: `could not resolve ${trunk} head sha` };
        const done = await dispatchBranchRefreshConflictTask({
          mission, branch, trunk, trunkSha, installationId, workspaceId: workspace.id, repoFullName: repo.fullName,
          leaseToken, stillEligible, reservedTaskId: current.branchRefreshConflictTaskId,
        });
        if (done.kind === 'fenced') return whyFenced();
        return { kind: 'conflict', conflictTaskId: done.taskId, dispatched: done.dispatched };
      }
      if (settled.kind === 'open') {
        return { kind: 'skipped', reason: 'conflict_task_open', conflictTaskId: current.branchRefreshConflictTaskId, ...(settled.detail ? { detail: settled.detail } : {}) };
      }
      if (settled.kind === 'unverified') {
        return { kind: 'skipped', reason: 'refresh_unverified', conflictTaskId: current.branchRefreshConflictTaskId, detail: settled.detail };
      }
      await db
        .update(missions)
        .set({ branchRefreshConflictTaskId: null })
        .where(and(eq(missions.id, missionId), eq(missions.branchRefreshConflictTaskId, current.branchRefreshConflictTaskId), eq(missions.branchRefreshLeaseToken, leaseToken)));
    }

    let trunkSha: string;
    try {
      const trunkRef = await githubApi(installationId, `/repos/${repo.fullName}/git/ref/heads/${trunk}`);
      trunkSha = trunkRef?.object?.sha;
      if (typeof trunkSha !== 'string' || !trunkSha) {
        return { kind: 'error', detail: `could not resolve ${trunk} head sha` };
      }
    } catch (err) {
      return { kind: 'error', detail: `could not read ${trunk}: ${githubErrorMessage(err)}` };
    }

    // Idempotency debounce: dev has not moved past the last refresh this
    // mission actually landed, so there is nothing new to merge in.
    if (current.branchRefreshHeadSha === trunkSha) {
      return { kind: 'skipped', reason: 'already_current' };
    }

    const ensured = await ensureMissionIntegrationBranch(missionId, { workspaceId: workspace.id });
    if (!ensured.ok) {
      return { kind: 'skipped', reason: ensured.reason === 'empty_repo' ? 'empty_repo' : 'no_repo', detail: ensured.detail };
    }
    if (ensured.created) {
      // Freshly cut from trunk — already current by construction.
      await db.update(missions).set({ branchRefreshHeadSha: trunkSha, branchRefreshedAt: new Date() }).where(ownsLease);
      return { kind: 'skipped', reason: 'already_current' };
    }

    // The mission PR may have merged while this ran: re-read it at the boundary.
    if ((await findMissionPrOwner(missionId))?.state === 'merged') {
      return { kind: 'skipped', reason: 'mission_pr_merged' };
    }
    // Slow repo/ref work can outlive the lease. Fence the API call against a
    // successor that already acquired ownership or reserved a conflict task,
    // and against the mission leaving the state this trigger may write to.
    const [renewed] = await db.update(missions)
      .set({ branchRefreshLeaseUntil: new Date(Date.now() + BRANCH_REFRESH_LEASE_MS) })
      .where(and(ownsLease, isNull(missions.branchRefreshConflictTaskId), stillEligible))
      .returning({ id: missions.id });
    if (!renewed) return whyFenced();

    let merged: { sha?: string } | null;
    try {
      merged = await githubApi(installationId, `/repos/${repo.fullName}/merges`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          base: branch,
          head: trunk,
          commit_message: `Merge ${trunk} into ${branch} (mission branch refresh)`,
        }),
      });
    } catch (err) {
      const status = githubErrorStatus(err);
      if (status === 409) {
        const conflict = await dispatchBranchRefreshConflictTask({
          mission,
          branch,
          trunk,
          trunkSha,
          installationId,
          workspaceId: workspace.id,
          repoFullName: repo.fullName,
          leaseToken,
          stillEligible,
        });
        if (conflict.kind === 'fenced') return whyFenced();
        fireGateEvent({
          gate: GATE_SLUGS.MISSION_BRANCH_REFRESH,
          surface: 'mission-branch-refresh',
          outcome: 'stranded',
          reason: `${branch} has merge conflicts with ${trunk}`,
          workspaceId: workspace.id,
          missionId,
          callerOrigin: 'system',
          detail: { branch, trunk, conflictTaskId: conflict.taskId, dispatched: conflict.dispatched },
        });
        return { kind: 'conflict', conflictTaskId: conflict.taskId, dispatched: conflict.dispatched };
      }
      return { kind: 'error', detail: `merges API failed: ${githubErrorMessage(err)}` };
    }

    // 204 → null (githubApi): GitHub says the branch already contains trunk.
    await db.update(missions).set({ branchRefreshHeadSha: trunkSha, branchRefreshedAt: new Date() }).where(ownsLease);
    if (!merged) {
      return { kind: 'skipped', reason: 'already_current' };
    }

    fireGateEvent({
      gate: GATE_SLUGS.MISSION_BRANCH_REFRESH,
      surface: 'mission-branch-refresh',
      outcome: 'accepted',
      reason: `merged ${trunk} into ${branch}`,
      workspaceId: workspace.id,
      missionId,
      callerOrigin: 'system',
      detail: { branch, trunk, mergeCommitSha: merged.sha ?? null },
    });
    await postRefreshNote(missionId, `Merged \`${trunk}\` into \`${branch}\` cleanly (${merged.sha?.slice(0, 7) ?? 'no sha'}).`);
    return { kind: 'merged', headSha: trunkSha };
  } finally {
    await releaseLease().catch(() => {});
  }
}

/** Mission feed visibility. Best-effort — a failed note must never affect the refresh. */
async function postRefreshNote(missionId: string, body: string, title = 'Integration branch refreshed'): Promise<void> {
  try {
    await db.insert(missionNotes).values({
      missionId,
      authorType: 'system',
      type: 'update',
      title,
      body,
      status: 'open',
    });
  } catch (err) {
    console.error(`[mission-branch-refresh] failed to post note for mission ${missionId}:`, err);
  }
}

type ConflictTaskSettlement =
  | { kind: 'open'; detail?: string }
  | { kind: 'reserved' }
  | { kind: 'cleared' }
  | { kind: 'unverified'; detail: string };

/**
 * Is the mission's one conflict-resolution task done with?
 *
 * A task reaching a terminal status is not enough: a builder completes once its
 * PR is open, and clearing the pointer then let every later trunk merge 409 into
 * a fresh task and a fresh PR for the same conflict. So the task's PR decides:
 *
 *  - no task row behind the pointer → `reserved`: a dispatch reserved the id
 *    and has not inserted it (or died first). The caller finishes it under the
 *    same id;
 *  - task still running, or a retry it spawned (`parentTaskId`) still running,
 *    or its PR still open → `open` (later trunk advances coalesce into it; it
 *    merges trunk again before landing);
 *  - PR closed unmerged, or the task ended with no PR → `cleared` (a person
 *    judged it; the next refresh may try again);
 *  - PR merged → the branch must provably contain the trunk sha the refresh was
 *    for and the mission head it started from (`verifyRefreshLanded`). Proven →
 *    `cleared`. Not proven → `unverified`: the pointer stays set so no
 *    replacement task is dispatched, the violation is recorded once, and every
 *    later call re-checks — a repair that lands a real merge clears it.
 */
async function settleConflictTask(args: {
  taskId: string;
  missionId: string;
  branch: string;
  trunk: string;
  workspaceId: string;
  installationId: number;
  repoFullName: string;
}): Promise<ConflictTaskSettlement> {
  const { taskId, missionId, branch, trunk, workspaceId, installationId, repoFullName } = args;
  const conflictTask = await db.query.tasks.findFirst({
    where: sqlWhere(eq(tasks.id, taskId)),
    columns: { id: true, status: true, context: true },
  });
  // A missing row is a reservation (see dispatch), never a release.
  if (!conflictTask) return { kind: 'reserved' };
  if (!(TERMINAL_TASK_STATUSES as readonly string[]).includes(conflictTask.status)) return { kind: 'open' };
  // A failed attempt's retry carries the repair on under a new task id: the
  // repair is not over while it runs, so no second conflict task is opened.
  const liveRetry = await db.query.tasks.findFirst({
    where: sqlWhere(and(eq(tasks.parentTaskId, taskId), notInArray(tasks.status, [...TERMINAL_TASK_STATUSES]))),
    columns: { id: true },
  });
  if (liveRetry) return { kind: 'open', detail: `retry ${liveRetry.id} is still running` };

  const prWorker = await db.query.workers.findFirst({
    where: sqlWhere(and(eq(workers.taskId, taskId), isNotNull(workers.prNumber))),
    columns: { prNumber: true },
    orderBy: sqlOrderBy([desc(workers.createdAt)]),
  });
  if (!prWorker?.prNumber) return { kind: 'cleared' };

  let pr: { state?: string; merged?: boolean; head?: { sha?: string } } | null;
  try {
    pr = await githubApi(installationId, `/repos/${repoFullName}/pulls/${prWorker.prNumber}`);
  } catch (err) {
    return { kind: 'open', detail: `could not read PR #${prWorker.prNumber}: ${githubErrorMessage(err)}` };
  }
  if (!pr) return { kind: 'open', detail: `could not read PR #${prWorker.prNumber}` };
  if (!pr.merged) {
    return pr.state === 'closed' ? { kind: 'cleared' } : { kind: 'open', detail: `PR #${prWorker.prNumber} is still open` };
  }

  const refresh = integrationRefreshOf(conflictTask.context) ?? { trunk: null, trunkSha: null, missionHeadSha: null };
  const verdict = await verifyRefreshLanded({
    installationId,
    repoFullName,
    branch,
    trunk: refresh.trunk ?? trunk,
    refresh,
    prHeadSha: typeof pr.head?.sha === 'string' ? pr.head.sha : null,
  });
  if (verdict.ok) return { kind: 'cleared' };
  if (verdict.transient) return { kind: 'open', detail: verdict.reason };

  const ctx = (conflictTask.context ?? {}) as Record<string, unknown>;
  if (!ctx.refreshInvariantViolation) {
    // Recorded once on the task, so the page, the gate ledger and the mission
    // feed each say it one time — not on every hourly sweep.
    await db.update(tasks)
      .set({ context: { ...ctx, refreshInvariantViolation: { reason: verdict.reason, branchHead: verdict.branchHead, prNumber: prWorker.prNumber, at: new Date().toISOString() } } })
      .where(eq(tasks.id, taskId))
      .catch((err) => console.error(`[mission-branch-refresh] could not record violation on task ${taskId}:`, err));
    fireGateEvent({
      gate: GATE_SLUGS.MISSION_BRANCH_REFRESH,
      surface: 'mission-branch-refresh',
      outcome: 'stranded',
      reason: verdict.reason,
      workspaceId,
      taskId,
      missionId,
      callerOrigin: 'system',
      detail: { branch, trunk, prNumber: prWorker.prNumber, branchHead: verdict.branchHead, trunkSha: verdict.trunkSha, missing: verdict.missing, invariant: 'refresh_ancestry' },
    });
    await postRefreshNote(
      missionId,
      `PR #${prWorker.prNumber} merged into \`${branch}\`, but the branch still does not contain ${verdict.missing.join(' or ')} — it was squashed or rebased, so \`${trunk}\` is not in the branch's history and the same conflict would come back. ` +
        `No new refresh task will be opened for this. To repair: merge current \`${trunk}\` into \`${branch}\` with a real merge commit (open a PR from a branch cut from \`${branch}\` after \`git merge origin/${trunk}\`, and land it with "Create a merge commit"). Never force-push \`${branch}\`. ` +
        `Refreshing resumes on its own once the branch contains ${verdict.trunkSha ? verdict.trunkSha.slice(0, 7) : trunk}.`,
      'Integration branch refresh did not land',
    );
  }
  return { kind: 'unverified', detail: verdict.reason };
}

/**
 * Dispatch the one conflict-resolution task this mission is allowed to have in
 * flight. Atomically reserves the pointer under the lease owner's token before
 * insertion, so an expired caller cannot dispatch alongside its successor.
 *
 * With `reservedTaskId`, it finishes a reservation whose row was never written
 * instead: it re-asserts the pointer under this caller's lease and inserts
 * under that id. Either way the insert is idempotent on the id, so the one
 * reservation yields at most one task however many callers finish it.
 */
async function dispatchBranchRefreshConflictTask(args: {
  mission: { id: string; title: string };
  branch: string;
  trunk: string;
  trunkSha: string;
  installationId: number;
  workspaceId: string;
  repoFullName: string;
  leaseToken: string;
  /** The mission-state fence (`stillEligible` in the caller). */
  stillEligible: SQL | undefined;
  reservedTaskId?: string;
}): Promise<{ kind: 'task'; taskId: string; dispatched: boolean } | { kind: 'fenced' }> {
  const { mission, branch, trunk, trunkSha, installationId, workspaceId, repoFullName, leaseToken, stillEligible, reservedTaskId } = args;

  // Reserve the pointer before insertion. A missing task behind this pointer
  // is a reservation, never permission to dispatch a second task.
  const taskId = reservedTaskId ?? randomUUID();
  const [reserved] = await db.update(missions)
    .set({ branchRefreshConflictTaskId: taskId })
    .where(and(
      eq(missions.id, mission.id),
      eq(missions.branchRefreshLeaseToken, leaseToken),
      reservedTaskId ? eq(missions.branchRefreshConflictTaskId, reservedTaskId) : isNull(missions.branchRefreshConflictTaskId),
      stillEligible,
    ))
    .returning({ id: missions.id });
  if (!reserved) {
    const current = await db.query.missions.findFirst({ where: sqlWhere(eq(missions.id, mission.id)) });
    return current?.branchRefreshConflictTaskId && current.branchRefreshConflictTaskId !== reservedTaskId
      ? { kind: 'task', taskId: current.branchRefreshConflictTaskId, dispatched: false } : { kind: 'fenced' };
  }

  // The mission work the refresh must keep: proven present after it lands.
  let missionHeadSha: string | null = null;
  try {
    const ref = await githubApi(installationId, `/repos/${repoFullName}/git/ref/heads/${branch.split('/').map(encodeURIComponent).join('/')}`);
    missionHeadSha = typeof ref?.object?.sha === 'string' ? ref.object.sha : null;
  } catch { /* best effort — verification then checks the trunk side only */ }

  const description = `Merging \`${trunk}\` into this mission's integration branch \`${branch}\` hit merge conflicts. This is routine upkeep (docs/design/mission-delivery-arc.md P5, superseded) — dev is kept merged into every active mission branch automatically, and this is the one case that needs a person's judgment.

## Instructions

1. Fetch and branch from the integration branch itself:
   \`\`\`bash
   git fetch origin
   git checkout -b <your-branch> origin/${branch}
   git merge origin/${trunk}
   \`\`\`
2. Where the repo defines it, run \`bun run conflicts:generated\` first. It regenerates the conflicted files a script writes (a specs index, the Drizzle journal, snapshots and migrations, a lint baseline) instead of merging their text, and lists every conflict left. Exit 0 means nothing is left: go to step 4.
3. Resolve what it lists on the merits — keep both intents, do NOT use blanket \`--ours\`/\`--theirs\` — then run \`bun run conflicts:generated\` again to finish the generated files it was waiting on. If it says a regenerated migration's SQL differs from the one it replaced, re-add the missing hand-written statement with \`bun db:generate --custom\`, never by editing an existing file.
   Without that script: if both sides added Drizzle migrations at the same index, do NOT hand-resolve the journal/snapshot conflict. Resolve the rest, then run \`bun run migrations:regenerate --base=origin/${trunk}\`: it takes \`${trunk}\`'s drizzle files as-is and regenerates this branch's migration on top.
   These two scripts are the only sanctioned way to move a migration. Never rename, renumber or edit a migration \`.sql\`, journal or snapshot by hand: the merge-safety check accepts a moved migration only when the new file holds exactly the old one's SQL, and treats anything else as rewriting migration history, which needs a person.
4. Run \`bun run test\`, \`bun run type-check\`, \`bun run specs:check\` — all green.
5. Push your branch and open a PR with base \`${branch}\`.

**This PR must land as a merge commit, not a squash** — a squash would drop \`${trunk}\`'s commits from this branch's ancestry, and the exact same conflict would reappear on the very next refresh. Say so in the PR body. Every buildd merge door lands it as a merge commit on its own; a person merging it on GitHub must pick "Create a merge commit". After it merges, buildd checks that \`${branch}\` really contains \`${trunk}\` ${trunkSha.slice(0, 7)} before it counts the refresh as done.`;

  let newTask;
  try {
    [newTask] = await db
      .insert(tasks)
      .values({
        id: taskId,
        workspaceId,
        title: `chore(mission): merge ${trunk} into the ${mission.title} integration branch`,
        description,
        missionId: mission.id,
        taskClass: 'work',
        kind: 'engineering',
        creationSource: 'conflict',
        status: 'pending',
        priority: 8,
        outputRequirement: 'pr_required',
        pathManifest: ['**'],
        context: {
          baseBranch: branch,
          requireMergeCommit: true,
          // Read by integration-refresh.ts: what this refresh must prove landed.
          refreshTrunk: trunk,
          refreshTrunkSha: trunkSha,
          refreshMissionHeadSha: missionHeadSha,
          failureContext: {
            summary: `${branch} has merge conflicts with ${trunk}. Merge the integration branch in and resolve on the merits.`,
            errorType: 'merge_conflict' as const,
          },
        },
      })
      .onConflictDoNothing()
      .returning();
  } catch (error) {
    // Only the caller that reserved the id releases it. One finishing another's
    // reservation leaves it for the next attempt: the original may yet insert.
    if (!reservedTaskId) {
      await db.update(missions).set({ branchRefreshConflictTaskId: null })
        .where(and(eq(missions.id, mission.id), eq(missions.branchRefreshConflictTaskId, taskId)));
    }
    throw error;
  }
  // The id already has its row: the other party to this reservation wrote it.
  if (!newTask) return { kind: 'task', taskId, dispatched: false };

  const workspace = await db.query.workspaces.findFirst({ where: sqlWhere(eq(workspaces.id, workspaceId)) });
  if (workspace) {
    await announceTaskCreated(newTask, workspace).catch(() => {});
  }
  await wakeTask(newTask.id, 'conflict.retry').catch(() => {});
  await postRefreshNote(
    mission.id,
    `\`${branch}\` has merge conflicts with \`${trunk}\`. Dispatched a conflict-resolution task: ${newTask.id}. ` +
      `No further refresh attempts until it finishes.`,
  );
  console.log(`[mission-branch-refresh] dispatched conflict task ${newTask.id} for mission ${mission.id} (${repoFullName})`);
  return { kind: 'task', taskId: newTask.id, dispatched: true };
}

export interface MissionBranchRefreshSweepResult {
  scanned: number;
  merged: number;
  conflicts: number;
  skipped: number;
  errors: number;
}

/** Something will use the branch: a non-terminal task, or the mission's PR still open. */
async function missionInUse(missionId: string): Promise<boolean> {
  const live = await db.query.tasks.findFirst({
    where: sqlWhere(and(eq(tasks.missionId, missionId), notInArray(tasks.status, [...TERMINAL_TASK_STATUSES]))),
    columns: { id: true },
  });
  if (live) return true;
  return (await findMissionPrOwner(missionId))?.state === 'open';
}

/**
 * The daily backstop. A refresh otherwise runs only when a mission task starts
 * (or, for the mission PR, when the kernel updates it to land), so a mission
 * that sits a while without one would build up a single large conflict. Each
 * active, opted-in mission still in use is refreshed once its last confirmed
 * refresh is older than `BRANCH_REFRESH_BACKSTOP_MS`; an idle mission is left
 * alone, since nothing will cut from its branch. Runs from the hourly
 * pr-reconcile cron; a mission inside the window costs one DB read.
 *
 * It is also the reconciler for work a request left unfinished, so two more
 * conditions make a mission due before its day is up:
 *  - an abandoned lease: `branchRefreshLeaseUntil` set and past. Every exit
 *    path clears it, so a set, expired lease means its holder died mid-refresh
 *    (a start refresh past its budget whose request was torn down);
 *  - a conflict pointer: the next refresh settles it (or finishes a
 *    reservation whose row was never written), so a merged repair is
 *    recognised within the hour rather than at the next task start.
 *
 * A paused, held or budget-exhausted mission is never swept: the backstop is
 * unsolicited work, and a start (the resume) refreshes it instead.
 */
export async function sweepMissionBranchRefresh(): Promise<MissionBranchRefreshSweepResult> {
  const candidates = await db.query.missions.findMany({
    where: sqlWhere(and(
      eq(missions.integrationBranchEnabled, true),
      notInArray(missions.status, refusedStatuses('backstop')),
      eq(missions.isHeld, false),
    )),
    columns: { id: true, branchRefreshedAt: true, branchRefreshLeaseUntil: true, branchRefreshConflictTaskId: true },
  });

  const result: MissionBranchRefreshSweepResult = { scanned: 0, merged: 0, conflicts: 0, skipped: 0, errors: 0 };
  const now = Date.now();
  const staleBefore = now - BRANCH_REFRESH_BACKSTOP_MS;
  for (const m of candidates) {
    result.scanned++;
    try {
      const refreshedAt = m.branchRefreshedAt ? new Date(m.branchRefreshedAt).getTime() : null;
      const leaseUntil = m.branchRefreshLeaseUntil ? new Date(m.branchRefreshLeaseUntil).getTime() : null;
      const due = refreshedAt == null || refreshedAt <= staleBefore
        || (leaseUntil != null && leaseUntil < now)
        || m.branchRefreshConflictTaskId != null;
      if (!due || !(await missionInUse(m.id))) {
        result.skipped++;
        continue;
      }
      const outcome = await refreshMissionIntegrationBranch(m.id, { trigger: 'backstop' });
      if (outcome.kind === 'merged') result.merged++;
      else if (outcome.kind === 'conflict') result.conflicts++;
      else if (outcome.kind === 'error') result.errors++;
      else result.skipped++;
    } catch (err) {
      result.errors++;
      console.error(`[mission-branch-refresh] sweep failed for mission ${m.id}:`, err);
    }
  }
  return result;
}

/** A claimed task, as far as the start trigger reads it. */
export interface StartingTask {
  missionId?: string | null;
  context?: unknown;
}

/**
 * A mission task is starting: bring its integration branch up to date first,
 * so the work cuts its branch from current trunk instead of building on a base
 * that will conflict later.
 *
 * Only a task whose `context.baseBranch` IS its mission's integration branch
 * counts: fix and CI-fix retries base on their PR's branch, and the refresh
 * conflict task (`requireMergeCommit`) does its own merge. Each mission is
 * refreshed once however many of its tasks start in this claim.
 *
 * Bounded and fail-open: the caller waits at most `budgetMs` and is never
 * failed by it, and the task starts on the branch as it is, fresh or not. A
 * refresh still running at the budget is handed to `keepAlive` (the claim's
 * subscriber passes `after()`, so the platform keeps the request alive for
 * it). It holds the single-flight lease, so a concurrent start coalesces into
 * it. Nothing depends on that promise surviving: if the request is torn down
 * first, the lease is left set and expires, and the backstop treats an
 * expired lease as due (`sweepMissionBranchRefresh`).
 * Returns each mission's outcome, or `timed_out`, for the caller's log.
 */
export async function refreshMissionBranchesBeforeStart(
  starting: StartingTask[],
  opts: { budgetMs?: number; keepAlive?: (pending: Promise<unknown>) => void } = {},
): Promise<Record<string, MissionBranchRefreshOutcome | 'timed_out'>> {
  const out: Record<string, MissionBranchRefreshOutcome | 'timed_out'> = {};
  try {
    const wanted = new Map<string, Set<string>>();
    for (const t of starting) {
      const ctx = (t.context ?? {}) as Record<string, unknown>;
      if (!t.missionId || typeof ctx.baseBranch !== 'string' || ctx.requireMergeCommit === true) continue;
      const bases = wanted.get(t.missionId) ?? new Set<string>();
      bases.add(ctx.baseBranch);
      wanted.set(t.missionId, bases);
    }
    if (wanted.size === 0) return out;

    const rows = await db.query.missions.findMany({
      where: sqlWhere(inArray(missions.id, [...wanted.keys()])),
      columns: { id: true, workingBranch: true, integrationBranchEnabled: true },
    });
    const due = rows.filter((m) => {
      const branch = missionIntegrationBase(m);
      return branch != null && (wanted.get(m.id)?.has(branch) ?? false);
    });
    if (due.length === 0) return out;

    const budgetMs = opts.budgetMs ?? START_REFRESH_BUDGET_MS;
    await Promise.all(due.map(async (m) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const refresh = refreshMissionIntegrationBranch(m.id, { trigger: 'start' }).catch((err): MissionBranchRefreshOutcome => ({
        kind: 'error', detail: githubErrorMessage(err),
      }));
      const timeout = new Promise<'timed_out'>((resolve) => { timer = setTimeout(() => resolve('timed_out'), budgetMs); });
      out[m.id] = await Promise.race([refresh, timeout]);
      clearTimeout(timer);
      if (out[m.id] === 'timed_out') {
        try { opts.keepAlive?.(refresh); } catch { /* best effort: the backstop owns recovery */ }
      }
    }));
  } catch (err) {
    console.error('[mission-branch-refresh] start refresh failed; the claim proceeds on the branch as it is:', err);
  }
  return out;
}
