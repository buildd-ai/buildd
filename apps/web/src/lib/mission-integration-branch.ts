/**
 * Option A′ — mission integration branches.
 *
 * A mission that has opted in (`missions.integrationBranchEnabled`) keeps
 * per-task branches and per-task PRs exactly as it has always had them. The
 * single change is that a mission task's PR **base** is the mission's
 * integration branch (`missions.workingBranch`) instead of trunk. When the
 * mission's work is done the integration branch opens one PR into trunk, and
 * that mission PR is the single human gate — see `merge-policy.ts` for where
 * the tier applies.
 *
 * The pure predicates live in `@buildd/core/mission-integration` so that
 * merge-policy resolution and the completion criterion can ask the same
 * question without importing a GitHub client. This module is the IO half:
 * it makes the branch exist.
 */

import { db } from '@buildd/core/db';
import { githubRepos, missionNotes, missions, workerErrorTraces, workspaces } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { resolveMissionRepoWorkspaceId } from '@/lib/mission-repo-workspace';
import { githubApi } from '@/lib/github';
import { missionIntegrationBase } from '@buildd/core/mission-integration';
import { recordGateEvent, GATE_SLUGS } from '@buildd/core/gate-events';
import {
  MISSION_BRANCH_UNRESOLVED,
  missionBranchUnresolvedDetail,
  missionBranchUnresolvedExcerpt,
  missionBranchUnresolvedReason,
  type MissionBranchUnresolvedInput,
} from '@buildd/core/mission-branch-trace';

export { resolveMissionRepoWorkspaceId };

/**
 * Extract the HTTP status out of the error `githubApi` throws on non-2xx.
 *
 * The thrown message is `GitHub API error: ${status} ${body}` (see
 * `@/lib/github`), so the response body travels with the status and the
 * predicates below can read it.
 */
function githubErrorStatus(err: unknown): number | null {
  const msg = err instanceof Error ? err.message : String(err);
  const m = /GitHub API error: (\d{3})/.exec(msg);
  return m ? Number(m[1]) : null;
}

function githubErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Does this 422 mean "the ref you asked me to create is already there"?
 *
 * 422 is NOT a synonym for that. `POST /git/refs` also answers 422 for a sha
 * that does not exist (mistyped, or GC'd between the trunk lookup and the
 * create), for a ref name it refuses, and for generic validation failures. In
 * every one of those the branch was not created — so reporting success means
 * the caller posts no note, nothing points at the branch, and then every task
 * PR of the mission fails to open against a base ref that is absent. The only
 * 422 whose post-condition matches ours is the one that says so.
 */
function isReferenceAlreadyExists(err: unknown): boolean {
  return /reference already exists/i.test(githubErrorMessage(err));
}

/**
 * An unborn repository — no commits, so `refs/heads/*` cannot exist and cannot
 * be created. Its own reason because it is the one failure here that no retry
 * fixes: somebody has to push a first commit.
 */
function isEmptyRepository(err: unknown): boolean {
  return githubErrorStatus(err) === 409 && /repository is empty/i.test(githubErrorMessage(err));
}

export type EnsureIntegrationBranchResult =
  | { ok: true; branch: string; created: boolean }
  | {
      ok: false;
      reason: 'not_opted_in' | 'no_working_branch' | 'no_repo' | 'empty_repo' | 'api_error';
      detail?: string;
    };

/**
 * Make sure the mission's integration branch exists on the remote, cut from
 * trunk.
 *
 * This has to happen before any task PR can target it: GitHub rejects a pull
 * request whose base ref does not exist, so without this the first task of an
 * opted-in mission would fail to open a PR at all.
 *
 * Idempotent, and safe under concurrency — two callers racing to create the
 * same ref produce one 201 and one 422 "Reference already exists", and THAT
 * 422 is treated as success rather than as an error, because it means exactly
 * what we wanted to be true. Every other 422 is a failure: see
 * `isReferenceAlreadyExists`.
 */
export async function ensureMissionIntegrationBranch(
  missionId: string,
  opts?: {
    /**
     * The workspace the caller is acting in (a task's), used only when the
     * mission itself has none. See `resolveMissionRepoWorkspaceId`.
     */
    workspaceId?: string | null;
  },
): Promise<EnsureIntegrationBranchResult> {
  const mission = await db.query.missions.findFirst({
    where: eq(missions.id, missionId),
    columns: { workingBranch: true, integrationBranchEnabled: true, workspaceId: true },
  });
  if (!mission) return { ok: false, reason: 'no_repo', detail: 'mission not found' };
  if (!mission.integrationBranchEnabled) return { ok: false, reason: 'not_opted_in' };

  const branch = missionIntegrationBase(mission);
  if (!branch) return { ok: false, reason: 'no_working_branch' };

  // A task's own workspace — when the caller knows it — names the repo its
  // own PR needs the branch in, and it wins outright rather than merely
  // breaking a tie: `resolveMissionRepoWorkspaceId` treats the mission's
  // `workspaceId` as the mission's one shared repo, which is wrong for a
  // mission whose tasks span more than one repo (mission a955fed9 — buildd
  // and infrastructure tasks under one mission). Checking the mission's home
  // repo for a branch a DIFFERENT repo's task actually needs reports a false
  // "it's there" and sends that task's PR at a ref that 404s in its own repo.
  // Mission-level callers with no single task to ask (runMission, the
  // mission-PR opener) never pass this hint, so they are unaffected and keep
  // resolving to the mission's own workspace exactly as before.
  const resolved = opts?.workspaceId
    ? { workspaceId: opts.workspaceId }
    : await resolveMissionRepoWorkspaceId({
        missionId,
        missionWorkspaceId: mission.workspaceId,
      });
  if (!resolved.workspaceId) {
    return { ok: false, reason: 'no_repo', detail: resolved.detail };
  }
  const workspace = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, resolved.workspaceId),
    columns: { githubRepoId: true, githubInstallationId: true, gitConfig: true },
  });
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

  // Already there? Then we are done, and we say so — `created: false` is the
  // signal a caller needs to know it did not just reset anyone's branch.
  try {
    await githubApi(installationId, `/repos/${repo.fullName}/git/ref/heads/${branch}`);
    return { ok: true, branch, created: false };
  } catch (err) {
    if (isEmptyRepository(err)) {
      return { ok: false, reason: 'empty_repo', detail: githubErrorMessage(err) };
    }
    if (githubErrorStatus(err) !== 404) {
      return { ok: false, reason: 'api_error', detail: githubErrorMessage(err) };
    }
  }

  const trunk =
    workspace.gitConfig?.targetBranch ||
    workspace.gitConfig?.defaultBranch ||
    repo.defaultBranch ||
    'main';

  try {
    const trunkRef = await githubApi(
      installationId,
      `/repos/${repo.fullName}/git/ref/heads/${trunk}`,
    );
    const sha = trunkRef?.object?.sha;
    if (typeof sha !== 'string' || !sha) {
      return { ok: false, reason: 'api_error', detail: `could not resolve ${trunk} head` };
    }
    await githubApi(installationId, `/repos/${repo.fullName}/git/refs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: `refs/heads/${branch}`, sha }),
    });
    console.log(
      `[mission-integration-branch] created ${branch} from ${trunk}@${sha.slice(0, 7)} for mission ${missionId}`,
    );
    return { ok: true, branch, created: true };
  } catch (err) {
    // A concurrent caller won the race and the ref is already there: the
    // post-condition we care about holds, so this is success. Read the BODY,
    // not just the 422 — see isReferenceAlreadyExists for why a bare status
    // check turns three real failures into a silent success.
    if (githubErrorStatus(err) === 422 && isReferenceAlreadyExists(err)) {
      return { ok: true, branch, created: false };
    }
    if (isEmptyRepository(err)) {
      return { ok: false, reason: 'empty_repo', detail: githubErrorMessage(err) };
    }
    return { ok: false, reason: 'api_error', detail: githubErrorMessage(err) };
  }
}

/**
 * Record that a mission's integration branch could not be resolved, under the
 * one stable signature (`mission_branch_unresolved`) — as a gate-ledger row
 * (get_failure_analytics family="gate") and, when a worker is involved, as an
 * error trace on it (get_error_traces, grouped by pattern). Never throws.
 */
export async function reportMissionBranchUnresolved(
  input: MissionBranchUnresolvedInput & {
    surface: string;
    workspaceId?: string | null;
    taskId?: string | null;
    workerId?: string | null;
  },
): Promise<void> {
  try {
    await recordGateEvent({
      gate: GATE_SLUGS.MISSION_BRANCH_UNRESOLVED,
      surface: input.surface,
      outcome: input.fallback === 'recut_from_trunk' ? 'warned' : 'stranded',
      reason: missionBranchUnresolvedReason(input),
      workspaceId: input.workspaceId ?? null,
      missionId: input.missionId ?? null,
      taskId: input.taskId ?? null,
      workerId: input.workerId ?? null,
      callerOrigin: input.workerId ? 'worker' : 'system',
      detail: missionBranchUnresolvedDetail(input),
    });
  } catch (err) {
    console.error('[mission-integration-branch] failed to record gate event:', err);
  }
  if (input.workerId) {
    try {
      await db.insert(workerErrorTraces).values({
        workerId: input.workerId,
        taskId: input.taskId ?? null,
        pattern: MISSION_BRANCH_UNRESOLVED,
        excerpt: missionBranchUnresolvedExcerpt(input).slice(0, 500),
        source: 'mission-branch',
      });
    } catch (err) {
      console.error('[mission-integration-branch] failed to record error trace:', err);
    }
  }
  console.warn(`[mission-integration-branch] ${missionBranchUnresolvedExcerpt(input)}`);
}

/**
 * What a mission task's PR can actually base on, right now.
 *
 * `usable: false` means the integration branch is neither present nor
 * restorable, and the caller must fall back to trunk rather than refuse.
 */
export interface IntegrationBaseForTaskPr {
  usable: boolean;
  /** True when this call re-cut the branch that had been deleted. */
  recreated: boolean;
  detail?: string;
}

/**
 * Make sure a mission task can actually deliver its PR — the route out of the
 * dead end a deleted integration branch used to be.
 *
 * ## The dead end
 *
 * A mission PR merging deletes the integration branch on purpose
 * (`finalizeMissionPrMerge`). Any task of that mission claimed afterwards then
 * derives a base that does not exist: `create_pr` refuses trunk because the
 * mission HAS an integration base, and GitHub refuses the derived base because
 * it is gone. Both doors shut, from inside a sandbox, with no owner in the
 * loop. `guardMissionPrMerge` stops new instances; it does nothing for a
 * mission already in this state, and there was at least one.
 *
 * ## The choice, and why
 *
 * **Re-cut the branch from trunk and proceed** — rather than falling back to
 * trunk with a note. The mission-branch strategy's whole claim is that a
 * mission reaches trunk through exactly one merge, and trunk-fallback spends a
 * second merge on the same mission, which is the breach `mission_merged_twice`
 * exists to detect. Re-cutting keeps the shape: the remaining task PRs base on
 * the restored branch and a second mission PR carries them to trunk as one
 * merge. `openMissionIntegrationPr` is already written for exactly this — its
 * `merged` state deliberately falls THROUGH so a recreated branch gets its
 * second PR, with an `ahead_by === 0` check to stop an empty one.
 *
 * The objection to re-cutting is that a freshly cut branch carries no mission
 * history. True, and irrelevant here: we re-cut *because* there is new work
 * about to land on it. An empty stand-in is what you get from re-cutting a
 * finished mission's branch, which nothing here does.
 *
 * Trunk fallback survives as the last resort for when the branch can neither be
 * found nor created (`usable: false`). Delivering the PR to trunk with a loud
 * note beats a worker that cannot deliver at all.
 *
 * Either way the decision is RECORDED as a mission note, never silent.
 *
 * Liveness: existence is checked against GitHub (`GET /git/ref/heads/<branch>`
 * in `ensureMissionIntegrationBranch`), never against a local remote-tracking
 * ref — those report a deleted branch as present until something prunes them,
 * which is how this failure kept being misdiagnosed.
 */
export async function ensureIntegrationBaseForTaskPr(args: {
  missionId: string;
  integrationBase: string;
  taskTitle?: string | null;
  /** Where the PR would go instead, for the note. */
  fallbackBase?: string | null;
  /**
   * The task's workspace. Lets a mission created without a workspace still
   * resolve the repo its branch belongs in — see `resolveMissionRepoWorkspaceId`.
   */
  workspaceId?: string | null;
  /** For the `mission_branch_unresolved` trace. */
  taskId?: string | null;
  workerId?: string | null;
}): Promise<IntegrationBaseForTaskPr> {
  const ensured = await ensureMissionIntegrationBranch(args.missionId, { workspaceId: args.workspaceId });

  if (ensured.ok && !ensured.created) {
    return { usable: true, recreated: false };
  }

  const subject = args.taskTitle ? `\`${args.taskTitle}\`` : 'a mission task';
  const trace = {
    missionId: args.missionId,
    branch: args.integrationBase,
    where: 'create_pr' as const,
    surface: 'POST /api/github/pr',
    workspaceId: args.workspaceId ?? null,
    taskId: args.taskId ?? null,
    workerId: args.workerId ?? null,
  };

  if (ensured.ok) {
    await reportMissionBranchUnresolved({ ...trace, cause: 'missing', fallback: 'recut_from_trunk' });
    await postMissionNote(args.missionId, {
      title: `Integration branch \`${ensured.branch}\` was re-cut from trunk`,
      body:
        `${subject} needed this mission's integration branch to open its PR, and the branch was `
        + `not on the remote — either an earlier mission PR merged and deleted it, or it was never `
        + `created.\n\n`
        + `Rather than dead-end the task, buildd cut \`${ensured.branch}\` from trunk and let the `
        + `PR proceed. The work on it reaches trunk through one mission PR, as the strategy intends — `
        + `if an earlier mission PR already merged, that makes this a SECOND mission PR, one merge `
        + `for this round of work. Nothing that already shipped is affected: anything already in `
        + `trunk is where the new branch starts from.`,
    });
    return { usable: true, recreated: true };
  }

  await reportMissionBranchUnresolved({
    ...trace,
    cause: ensured.reason === 'not_opted_in' ? 'missing' : ensured.reason,
    fallback: 'trunk_pr_base',
    detail: ensured.detail ?? null,
  });
  const fallback = args.fallbackBase ? `\`${args.fallbackBase}\`` : 'trunk';
  await postMissionNote(args.missionId, {
    title: `Integration branch \`${args.integrationBase}\` is unavailable · PR falls back to ${fallback}`,
    body:
      `${subject} could not base its PR on this mission's integration branch \`${args.integrationBase}\` `
      + `(mission \`${args.missionId.slice(0, 8)}\`): the branch is absent from the remote and could `
      + `not be created (${ensured.reason}${ensured.detail ? `: ${ensured.detail}` : ''}).\n\n`
      + `The PR was opened against ${fallback} instead, so the task could deliver. This mission's `
      + `"one merge into trunk" guarantee does NOT hold for that PR: it reaches trunk on its own.\n\n`
      + `**To fix:** ${missionBranchRemedy(ensured.reason)}`,
  });
  return { usable: false, recreated: false, detail: ensured.detail ?? ensured.reason };
}

/**
 * What a person must do, per failure reason. Named so every surface that
 * reports an unresolvable branch gives the same instruction.
 */
export function missionBranchRemedy(reason: string): string {
  switch (reason) {
    case 'no_repo':
      return 'give the mission a workspace linked to a GitHub repo (manage_missions action=update '
        + 'workspaceId=<workspace>), or switch it to branchStrategy=direct if its tasks should PR '
        + 'straight to trunk.';
    case 'empty_repo':
      return 'push a first commit to the repository, then retry — a branch cannot be cut from an '
        + 'empty repo.';
    case 'no_working_branch':
      return 'run the mission organizer once (it names the branch), or switch the mission to '
        + 'branchStrategy=direct.';
    default:
      return 'check the GitHub App installation can create refs in this repo (contents: write), '
        + 'then retry; or switch the mission to branchStrategy=direct.';
  }
}

/** Best-effort mission note. A failed note must never fail a PR. */
async function postMissionNote(
  missionId: string,
  note: { title: string; body: string },
): Promise<void> {
  try {
    await db.insert(missionNotes).values({
      missionId,
      authorType: 'system',
      type: 'warning',
      title: note.title,
      body: note.body,
      status: 'open',
    });
  } catch (err) {
    console.error(`[mission-integration-branch] failed to record note for mission ${missionId}:`, err);
  }
}
