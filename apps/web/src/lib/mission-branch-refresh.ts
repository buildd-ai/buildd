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
 */

import { randomUUID } from 'node:crypto';
import { db } from '@buildd/core/db';
import { missions, missionNotes, tasks, workers, workspaces, githubRepos } from '@buildd/core/db/schema';
import { TERMINAL_TASK_STATUSES } from '@buildd/shared';
import { and, desc, eq, inArray, isNotNull, lt, isNull, or, sql } from 'drizzle-orm';
import { githubApi } from '@/lib/github';
import { missionIntegrationBase } from '@buildd/core/mission-integration';
import { GATE_SLUGS, fireGateEvent } from '@/lib/gate-ledger';
import { announceTaskCreated, wakeTask } from '@/lib/dispatch-authority';
import { resolveMissionRepoWorkspaceId } from '@/lib/mission-repo-workspace';
import { ensureMissionIntegrationBranch } from '@/lib/mission-integration-branch';
import { findMissionPrOwner } from '@/lib/mission-pr';
import { workspaceRepoMatches } from '@/lib/repo-scope';
import { integrationRefreshOf, verifyRefreshLanded } from '@/lib/integration-refresh';

/** How long a single-flight claim holds, before another caller may retry it. */
export const BRANCH_REFRESH_LEASE_MS = 45_000;

function githubErrorStatus(err: unknown): number | null {
  const msg = err instanceof Error ? err.message : String(err);
  const m = /GitHub API error: (\d{3})/.exec(msg);
  return m ? Number(m[1]) : null;
}

function githubErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export type MissionBranchRefreshOutcome =
  | {
      kind: 'skipped';
      reason:
        | 'not_opted_in'
        | 'mission_terminal'
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
 * debounce mechanisms. Never throws: every failure mode is a typed outcome.
 */
export async function refreshMissionIntegrationBranch(
  missionId: string,
): Promise<MissionBranchRefreshOutcome> {
  const mission = await db.query.missions.findFirst({
    where: eq(missions.id, missionId),
    columns: {
      id: true,
      title: true,
      status: true,
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
  if (mission.status === 'completed' || mission.status === 'archived') {
    return { kind: 'skipped', reason: 'mission_terminal', detail: mission.status };
  }

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
    where: eq(workspaces.id, resolved.workspaceId),
    columns: { id: true, githubRepoId: true, githubInstallationId: true, gitConfig: true },
  });
  if (!workspace?.githubRepoId || !workspace.githubInstallationId) {
    return { kind: 'skipped', reason: 'no_repo', detail: 'workspace not linked to a GitHub repo' };
  }
  const repo = await db.query.githubRepos.findFirst({
    where: eq(githubRepos.id, workspace.githubRepoId),
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

  try {
    // The pre-lease snapshot may be stale after another caller finishes.
    const current = await db.query.missions.findFirst({ where: eq(missions.id, missionId) });
    if (!current || current.branchRefreshLeaseToken !== leaseToken) return { kind: 'skipped', reason: 'in_flight' };
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
      await db.update(missions).set({ branchRefreshHeadSha: trunkSha }).where(ownsLease);
      return { kind: 'skipped', reason: 'already_current' };
    }

    // Slow repo/ref work can outlive the lease. Fence the API call against a
    // successor that already acquired ownership or reserved a conflict task.
    const [renewed] = await db.update(missions)
      .set({ branchRefreshLeaseUntil: new Date(Date.now() + BRANCH_REFRESH_LEASE_MS) })
      .where(and(ownsLease, isNull(missions.branchRefreshConflictTaskId)))
      .returning({ id: missions.id });
    if (!renewed) return { kind: 'skipped', reason: 'in_flight' };

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
        });
        if (!conflict) return { kind: 'skipped', reason: 'in_flight' };
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
    await db.update(missions).set({ branchRefreshHeadSha: trunkSha }).where(ownsLease);
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
  | { kind: 'cleared' }
  | { kind: 'unverified'; detail: string };

/**
 * Is the mission's one conflict-resolution task done with?
 *
 * A task reaching a terminal status is not enough: a builder completes once its
 * PR is open, and clearing the pointer then let every later trunk merge 409 into
 * a fresh task and a fresh PR for the same conflict. So the task's PR decides:
 *
 *  - task still running, or its PR still open → `open` (later trunk advances
 *    coalesce into it; it merges trunk again before landing);
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
    where: eq(tasks.id, taskId),
    columns: { id: true, status: true, context: true },
  });
  // A missing row is an in-progress reservation (see dispatch), never a release.
  if (!conflictTask || !(TERMINAL_TASK_STATUSES as readonly string[]).includes(conflictTask.status)) {
    return { kind: 'open' };
  }

  const prWorker = await db.query.workers.findFirst({
    where: and(eq(workers.taskId, taskId), isNotNull(workers.prNumber)),
    columns: { prNumber: true },
    orderBy: [desc(workers.createdAt)],
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
}): Promise<{ taskId: string; dispatched: boolean } | null> {
  const { mission, branch, trunk, trunkSha, installationId, workspaceId, repoFullName, leaseToken } = args;

  // Reserve the pointer before insertion. A missing task behind this pointer
  // is an in-progress reservation, never permission to dispatch another task.
  const taskId = randomUUID();
  const [reserved] = await db.update(missions)
    .set({ branchRefreshConflictTaskId: taskId })
    .where(and(eq(missions.id, mission.id), eq(missions.branchRefreshLeaseToken, leaseToken), isNull(missions.branchRefreshConflictTaskId)))
    .returning({ id: missions.id });
  if (!reserved) {
    const current = await db.query.missions.findFirst({ where: eq(missions.id, mission.id) });
    return current?.branchRefreshConflictTaskId
      ? { taskId: current.branchRefreshConflictTaskId, dispatched: false } : null;
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
2. Resolve every conflict on the merits — keep both intents, do NOT use blanket \`--ours\`/\`--theirs\`.
3. **Migrations**: if both sides added Drizzle migrations at the same index, do NOT hand-resolve the journal/snapshot conflict. Take \`${trunk}\`'s migration hunk in \`schema.ts\` byte-identically (\`git show <${trunk}-sha> -- packages/core/db/schema.ts | git apply\`), take its \`.sql\`/snapshot/journal files as-is, then run \`cd packages/core && bun db:generate\` so this branch's own schema changes land at the next free index on top. The schema.ts line stays byte-identical to ${trunk}, so the eventual merge back is clean.
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
    if (!newTask) throw new Error('Conflict task insertion returned no task');
  } catch (error) {
    await db.update(missions).set({ branchRefreshConflictTaskId: null })
      .where(and(eq(missions.id, mission.id), eq(missions.branchRefreshConflictTaskId, taskId)));
    throw error;
  }

  const workspace = await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId) });
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
  return { taskId: newTask.id, dispatched: true };
}

export interface MissionBranchRefreshSweepResult {
  scanned: number;
  merged: number;
  conflicts: number;
  skipped: number;
  errors: number;
}

/**
 * Backstop for a lost webhook delivery: refresh every active, opted-in
 * mission regardless of whether a dev-merge event ever reached us. Each
 * mission's own debounce makes repeating this cheap — a mission the webhook
 * already caught up to costs one DB read and no GitHub call.
 */
export async function sweepMissionBranchRefresh(): Promise<MissionBranchRefreshSweepResult> {
  const candidates = await db.query.missions.findMany({
    where: and(
      eq(missions.integrationBranchEnabled, true),
      sql`${missions.status} NOT IN ('completed', 'archived')`,
    ),
    columns: { id: true },
  });

  const result: MissionBranchRefreshSweepResult = { scanned: 0, merged: 0, conflicts: 0, skipped: 0, errors: 0 };
  for (const m of candidates) {
    result.scanned++;
    try {
      const outcome = await refreshMissionIntegrationBranch(m.id);
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

/**
 * Webhook trigger: a PR merged into a workspace's trunk. Refresh every active,
 * opted-in mission scoped to that workspace — the fast path; `sweepMissionBranchRefresh`
 * is the backstop for a lost delivery.
 *
 * Scoped to workspaces whose configured trunk is exactly `baseRef`: a merge
 * into some other branch of the same repo (a release branch, a long-lived
 * feature branch) is not the event this exists to react to.
 */
export async function refreshMissionBranchesForTrunkMerge(input: {
  repoFullName: string;
  baseRef: string;
}): Promise<void> {
  const linkedWorkspaces = await db.query.workspaces.findMany({
    where: workspaceRepoMatches(input.repoFullName),
    columns: { id: true, gitConfig: true },
  });
  const trunkWorkspaces = linkedWorkspaces.filter((w) => {
    const trunk = w.gitConfig?.targetBranch || w.gitConfig?.defaultBranch;
    return trunk ? trunk === input.baseRef : input.baseRef === 'main' || input.baseRef === 'master';
  });
  if (trunkWorkspaces.length === 0) return;

  const activeMissions = await db.query.missions.findMany({
    where: and(
      inArray(missions.workspaceId, trunkWorkspaces.map((w) => w.id)),
      eq(missions.integrationBranchEnabled, true),
      sql`${missions.status} NOT IN ('completed', 'archived')`,
    ),
    columns: { id: true },
  });

  for (const m of activeMissions) {
    try {
      await refreshMissionIntegrationBranch(m.id);
    } catch (err) {
      console.error(`[mission-branch-refresh] trigger failed for mission ${m.id}:`, err);
    }
  }
}
