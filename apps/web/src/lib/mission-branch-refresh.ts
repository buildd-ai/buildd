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
 * context, honored by `auto-merge.ts` / `pr-landing.ts`) — squashing it would
 * lose the ancestry the merge was for, and the same conflict would reappear on
 * the very next refresh.
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

import { db } from '@buildd/core/db';
import { missions, missionNotes, tasks, workspaces, githubRepos } from '@buildd/core/db/schema';
import { TERMINAL_TASK_STATUSES } from '@buildd/shared';
import { and, eq, inArray, lt, isNull, or, sql } from 'drizzle-orm';
import { githubApi } from '@/lib/github';
import { missionIntegrationBase } from '@buildd/core/mission-integration';
import { GATE_SLUGS, fireGateEvent } from '@/lib/gate-ledger';
import { announceTaskCreated, wakeTask } from '@/lib/dispatch-authority';
import { resolveMissionRepoWorkspaceId } from '@/lib/mission-repo-workspace';
import { ensureMissionIntegrationBranch } from '@/lib/mission-integration-branch';
import { findMissionPrOwner } from '@/lib/mission-pr';
import { workspaceRepoMatches } from '@/lib/repo-scope';

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

  // A conflict task is still live: stop retrying until it finishes (self-heals
  // once it observes the task reached a terminal status).
  if (mission.branchRefreshConflictTaskId) {
    const conflictTask = await db.query.tasks.findFirst({
      where: eq(tasks.id, mission.branchRefreshConflictTaskId),
      columns: { id: true, status: true },
    });
    const terminal = !conflictTask || (TERMINAL_TASK_STATUSES as readonly string[]).includes(conflictTask.status);
    if (!terminal) {
      return { kind: 'skipped', reason: 'conflict_task_open', conflictTaskId: mission.branchRefreshConflictTaskId };
    }
    await db
      .update(missions)
      .set({ branchRefreshConflictTaskId: null })
      .where(and(eq(missions.id, missionId), eq(missions.branchRefreshConflictTaskId, mission.branchRefreshConflictTaskId)));
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
  const [claimed] = await db
    .update(missions)
    .set({ branchRefreshLeaseUntil: new Date(Date.now() + BRANCH_REFRESH_LEASE_MS) })
    .where(and(
      eq(missions.id, missionId),
      or(isNull(missions.branchRefreshLeaseUntil), lt(missions.branchRefreshLeaseUntil, new Date())),
    ))
    .returning({ id: missions.id });
  if (!claimed) {
    return { kind: 'skipped', reason: 'in_flight' };
  }
  const releaseLease = () =>
    db.update(missions).set({ branchRefreshLeaseUntil: null }).where(eq(missions.id, missionId));

  try {
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
    if (mission.branchRefreshHeadSha === trunkSha) {
      return { kind: 'skipped', reason: 'already_current' };
    }

    const ensured = await ensureMissionIntegrationBranch(missionId, { workspaceId: workspace.id });
    if (!ensured.ok) {
      return { kind: 'skipped', reason: ensured.reason === 'empty_repo' ? 'empty_repo' : 'no_repo', detail: ensured.detail };
    }
    if (ensured.created) {
      // Freshly cut from trunk — already current by construction.
      await db.update(missions).set({ branchRefreshHeadSha: trunkSha }).where(eq(missions.id, missionId));
      return { kind: 'skipped', reason: 'already_current' };
    }

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
          workspaceId: workspace.id,
          repoFullName: repo.fullName,
        });
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
    await db.update(missions).set({ branchRefreshHeadSha: trunkSha }).where(eq(missions.id, missionId));
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
async function postRefreshNote(missionId: string, body: string): Promise<void> {
  try {
    await db.insert(missionNotes).values({
      missionId,
      authorType: 'system',
      type: 'update',
      title: 'Integration branch refreshed',
      body,
      status: 'open',
    });
  } catch (err) {
    console.error(`[mission-branch-refresh] failed to post note for mission ${missionId}:`, err);
  }
}

/**
 * Dispatch the one conflict-resolution task this mission is allowed to have in
 * flight. Returns the existing task when one is already open (the single
 * caller here only reaches this after confirming the column was null, but a
 * concurrent dispatch could still race the UPDATE below).
 */
async function dispatchBranchRefreshConflictTask(args: {
  mission: { id: string; title: string };
  branch: string;
  trunk: string;
  workspaceId: string;
  repoFullName: string;
}): Promise<{ taskId: string; dispatched: boolean }> {
  const { mission, branch, trunk, workspaceId, repoFullName } = args;

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

**This PR must land as a merge commit, not a squash** — a squash would drop \`${trunk}\`'s commits from this branch's ancestry, and the exact same conflict would reappear on the very next refresh. Say so in the PR body. If you call \`merge_pr\` yourself, pass \`mergeMethod: "merge"\` explicitly.`;

  const [newTask] = await db
    .insert(tasks)
    .values({
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
        failureContext: {
          summary: `${branch} has merge conflicts with ${trunk}. Merge the integration branch in and resolve on the merits.`,
          errorType: 'merge_conflict' as const,
        },
      },
    })
    .onConflictDoNothing()
    .returning();

  if (!newTask) {
    // Extremely unlikely race: another caller inserted first. Re-read whatever
    // the column now holds rather than reporting a phantom dispatch.
    const current = await db.query.missions.findFirst({
      where: eq(missions.id, mission.id),
      columns: { branchRefreshConflictTaskId: true },
    });
    return { taskId: current?.branchRefreshConflictTaskId ?? '', dispatched: false };
  }

  await db.update(missions).set({ branchRefreshConflictTaskId: newTask.id }).where(eq(missions.id, mission.id));

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
