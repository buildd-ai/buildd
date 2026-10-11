/**
 * BRANCH NAMING CONTRACT
 *
 * The single source of truth for the git branch a task's worker checks out.
 *
 * The claim route (`api/workers/claim/route.ts`) is the only writer of
 * `workers.branch`, so whatever it computes here IS the branch that exists.
 * Anything that needs that name before the worker exists — `approve-plan.ts`
 * resolving a plan step's stacked `baseBranch` ref — must call this function
 * rather than re-deriving the rule. It used to hand-mirror it and drifted:
 * the copy omitted `useBuildBranch` (so a workspace with both a `branchPrefix`
 * and `useBuildBranch` got a `<prefix>…` ref while the claim route created a
 * `buildd/…` one) and omitted the shared mission-branch override entirely.
 * A predicted ref that never exists is not a loud failure — the runner just
 * fetches `origin/<ref>`, misses, and silently starts fresh from the default
 * branch, which is the stacked-branch mechanism quietly not working.
 */

import { MISSION_BRANCH_PREFIX } from './mission-integration';

/** The subset of `workspaces.gitConfig` that decides a branch name. */
export interface BranchNameGitConfig {
  branchingStrategy?: 'none' | 'trunk' | 'gitflow' | 'feature' | 'custom' | string;
  branchPrefix?: string;
  useBuildBranch?: boolean;
}

export interface TaskBranchNameInput {
  /** The task's UUID — the first 8 chars go into the branch name. */
  taskId: string;
  /** The task title, sanitized into the branch slug. */
  title: string;
  /** `workspaces.gitConfig`, or null/undefined for repo defaults. */
  gitConfig?: BranchNameGitConfig | null;
  /**
   * A shared branch this task's worker should push to instead of getting a
   * generated one, read from `context.headBranch`. Usually seeded from
   * `missions.workingBranch` for a mission's shared integration branch, but
   * the field itself is generic: `create_task`'s `headBranch` param writes
   * the same key directly for a one-off task that must land on an existing
   * branch. When present it wins outright: the task is not given a branch of
   * its own — unless it equals `baseBranch` (see `pinnedHeadBranch`).
   */
  sharedHeadBranch?: unknown;
  /** `context.baseBranch` — where the task's PR is based. */
  baseBranch?: unknown;
}

/**
 * The head a task pins via `context.headBranch`, or null.
 *
 * A pinned head equal to the task's own `baseBranch` is not a head: a PR
 * cannot run from a branch into itself. That shape is a mission integration
 * branch written into both keys (approve-plan did this for every child of an
 * opted-in mission), and honouring it put every task of the mission on the
 * mission branch itself, where no head identifies whose work it is. Such a
 * task gets its own generated head, based on the integration branch.
 */
export function pinnedHeadBranch(context: unknown): string | null {
  if (!context || typeof context !== 'object') return null;
  const { headBranch, baseBranch } = context as { headBranch?: unknown; baseBranch?: unknown };
  if (typeof headBranch !== 'string' || headBranch.length === 0) return null;
  return headBranch === baseBranch ? null : headBranch;
}

/** Title → branch slug: lowercase, non-alphanumerics collapsed to `-`, 30 chars. */
export function sanitizeBranchTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .substring(0, 30);
}

/**
 * The branch name a task's worker will check out.
 *
 * Precedence (must stay identical to the claim route's insert):
 *   1. `sharedHeadBranch` — a pinned shared head, unless it is `baseBranch`.
 *   2. `branchingStrategy === 'none'` → `task-<id8>` (no slug at all).
 *   3. `useBuildBranch` → `buildd/<id8>-<slug>`, outranking `branchPrefix`.
 *   4. `branchPrefix` → `<prefix><id8>-<slug>`.
 *   5. default → `buildd/<id8>-<slug>`.
 */
export function generateTaskBranchName(input: TaskBranchNameInput): string {
  const { taskId, title, gitConfig } = input;

  const sharedHeadBranch = pinnedHeadBranch({ headBranch: input.sharedHeadBranch, baseBranch: input.baseBranch });
  if (sharedHeadBranch) return sharedHeadBranch;

  const taskIdShort = taskId.substring(0, 8);
  if (gitConfig?.branchingStrategy === 'none') return `task-${taskIdShort}`;

  const slug = sanitizeBranchTitle(title);
  if (gitConfig?.useBuildBranch) return `buildd/${taskIdShort}-${slug}`;
  if (gitConfig?.branchPrefix) return `${gitConfig.branchPrefix}${taskIdShort}-${slug}`;
  return `buildd/${taskIdShort}-${slug}`;
}

export interface MissionBranchNameInput {
  /** The mission's UUID — the first 8 chars go into the branch name. */
  missionId: string;
  /** The mission title, slugified into the branch name. */
  title: string;
}

/**
 * The working branch name for an Option A′ mission's integration branch.
 *
 * Title → lowercase, non-alphanumeric runs collapsed to `-`, leading/trailing
 * `-` stripped, truncated to 40 characters, falling back to `mission` when
 * empty — then `MISSION_BRANCH_PREFIX` + the first 8 characters of the
 * mission id.
 *
 * The single definition: `runMission` (apps/web/src/lib/mission-run.ts) and
 * mission creation (apps/web/src/app/api/missions/route.ts) both call this
 * rather than re-deriving the rule — see the docstring on
 * `@buildd/core/mission-integration` for why duplicating exactly this logic
 * once already caused a two-generators bug.
 */
export function generateMissionBranchName(input: MissionBranchNameInput): string {
  const { missionId, title } = input;
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'mission';
  const shortId = missionId.slice(0, 8);
  return `${MISSION_BRANCH_PREFIX}${slug}-${shortId}`;
}
