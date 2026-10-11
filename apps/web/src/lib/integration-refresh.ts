/**
 * The integration-refresh PR: the one PR whose whole purpose is ancestry.
 *
 * `mission-branch-refresh.ts` dispatches a conflict-resolution task when
 * merging trunk into a mission's integration branch hits a conflict. Its PR
 * (`context.requireMergeCommit`) targets the integration branch and carries a
 * merge of trunk. Three things follow, and every merge door must agree on them:
 *
 *  1. **Merge method.** It must land as a merge commit. A squash writes the
 *     right tree but leaves trunk out of the branch's ancestry, so the branch is
 *     still hundreds of commits behind and the same conflict reappears on the
 *     next refresh. `resolveMergeMethod` is the one rule: a refresh PR is
 *     `merge` whatever the caller asked for; anything else keeps its request.
 *
 *  2. **Effective delta.** Its GitHub file list is measured from the stale fork
 *     point, so it lists every trunk change since then — already reviewed, and
 *     often including trunk's own migration rewrites, which read as "deletes a
 *     generated migration". The gates judge `trunk...head` instead: exactly what
 *     the mission (and the conflict resolution) adds on top of trunk, mission
 *     migrations and schema edits included.
 *
 *  3. **Proof.** A merged PR is not a refreshed branch. `verifyRefreshLanded`
 *     reads the integration branch's live head and checks that the trunk sha the
 *     refresh was for, and the mission head it started from, are both ancestors.
 */

import { githubApi } from '@/lib/github';

export type MergeMethod = 'merge' | 'squash' | 'rebase';

/** What a refresh task records about itself (task context). */
export interface IntegrationRefreshContext {
  /** Trunk branch name the refresh merges in (e.g. `dev`). Absent on tasks created before it was recorded. */
  trunk: string | null;
  /** Trunk head the refresh was dispatched for. */
  trunkSha: string | null;
  /** Integration branch head when the refresh was dispatched — the mission work that must survive. */
  missionHeadSha: string | null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/** Null when the task is not an integration refresh. */
export function integrationRefreshOf(context: unknown): IntegrationRefreshContext | null {
  const ctx = context as Record<string, unknown> | null | undefined;
  if (!ctx || ctx.requireMergeCommit !== true) return null;
  return {
    trunk: str(ctx.refreshTrunk),
    trunkSha: str(ctx.refreshTrunkSha),
    missionHeadSha: str(ctx.refreshMissionHeadSha),
  };
}

/** The merge method a door must use for this task's PR. Never squash or rebase a refresh. */
export function resolveMergeMethod(context: unknown, requested?: MergeMethod | null): MergeMethod {
  if (integrationRefreshOf(context)) return 'merge';
  return requested ?? 'squash';
}

/**
 * The ref a refresh PR's effective delta is measured from: the trunk it merges
 * in. Null for any other PR (its own PR diff is the right one).
 */
export function refreshDeltaBase(
  context: unknown,
  gitConfig?: { targetBranch?: string | null; defaultBranch?: string | null } | null,
): string | null {
  const refresh = integrationRefreshOf(context);
  if (!refresh) return null;
  return refresh.trunk ?? gitConfig?.targetBranch ?? gitConfig?.defaultBranch ?? null;
}

export interface DeltaFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string | null;
  previous_filename?: string | null;
}

/** GitHub caps a compare's file list at 300; a list that long may be truncated. */
export const COMPARE_FILES_CAP = 300;

type Api = (installationId: number, path: string, options?: RequestInit) => Promise<any>;

function encodeRef(ref: string): string {
  return ref.split('/').map(encodeURIComponent).join('/');
}

/**
 * Files `head` changes relative to `base`'s fork point (three-dot compare).
 * Null when the read fails or the list may be truncated — callers then keep the
 * PR's own (larger) file list, so a failed read never relaxes a gate.
 */
export async function effectiveDeltaFiles(
  installationId: number,
  repoFullName: string,
  base: string,
  headSha: string,
  api: Api = githubApi,
): Promise<DeltaFile[] | null> {
  try {
    const data = await api(installationId, `/repos/${repoFullName}/compare/${encodeRef(base)}...${headSha}`);
    const files = data?.files;
    if (!Array.isArray(files) || files.length >= COMPARE_FILES_CAP) return null;
    return files as DeltaFile[];
  } catch {
    return null;
  }
}

/**
 * Is `ancestor` reachable from `head`? GitHub's compare `ancestor...head` says
 * `ahead` or `identical` exactly when it is. Null when the read fails.
 */
export async function isAncestor(
  installationId: number,
  repoFullName: string,
  ancestor: string,
  head: string,
  api: Api = githubApi,
): Promise<boolean | null> {
  try {
    const data = await api(installationId, `/repos/${repoFullName}/compare/${ancestor}...${head}`);
    const status = data?.status;
    if (typeof status !== 'string') return null;
    return status === 'ahead' || status === 'identical';
  } catch {
    return null;
  }
}

export type RefreshLandingVerdict =
  | { ok: true; branchHead: string; trunkSha: string }
  | { ok: false; branchHead: string | null; trunkSha: string | null; missing: string[]; reason: string; /** A read failed: nothing is proven either way, ask again later. */ transient: boolean };

/**
 * After a refresh PR merged: is the integration branch actually caught up?
 *
 * Reads the branch's live head (not the PR head, not a local checkout) and
 * requires the refresh's trunk sha and its starting mission head to both be
 * ancestors. A task created before the trunk sha was recorded falls back to
 * the newest trunk commit its PR head contained (`trunk...prHead`'s merge
 * base) — what that refresh actually merged in.
 */
export async function verifyRefreshLanded(params: {
  installationId: number;
  repoFullName: string;
  branch: string;
  trunk: string;
  refresh: IntegrationRefreshContext;
  prHeadSha: string | null;
  api?: Api;
}): Promise<RefreshLandingVerdict> {
  const api = params.api ?? githubApi;
  const { installationId, repoFullName, branch, trunk, refresh } = params;

  let branchHead: string | null = null;
  try {
    const ref = await api(installationId, `/repos/${repoFullName}/git/ref/heads/${encodeRef(branch)}`);
    branchHead = str(ref?.object?.sha);
  } catch { /* handled below */ }
  if (!branchHead) {
    return { ok: false, branchHead: null, trunkSha: refresh.trunkSha, missing: [], reason: `could not read ${branch}'s head`, transient: true };
  }

  let trunkSha = refresh.trunkSha;
  if (!trunkSha && params.prHeadSha) {
    try {
      const cmp = await api(installationId, `/repos/${repoFullName}/compare/${encodeRef(trunk)}...${params.prHeadSha}`);
      trunkSha = str(cmp?.merge_base_commit?.sha);
    } catch { /* handled below */ }
  }
  if (!trunkSha) {
    return { ok: false, branchHead, trunkSha: null, missing: [], reason: `could not tell which ${trunk} commit the refresh merged in`, transient: true };
  }

  const required: Array<[string, string]> = [[trunkSha, `${trunk} ${trunkSha.slice(0, 7)}`]];
  if (refresh.missionHeadSha) required.push([refresh.missionHeadSha, `mission head ${refresh.missionHeadSha.slice(0, 7)}`]);

  const missing: string[] = [];
  for (const [sha, label] of required) {
    const reachable = await isAncestor(installationId, repoFullName, sha, branchHead, api);
    if (reachable === null) {
      return { ok: false, branchHead, trunkSha, missing: [], reason: `could not compare ${label} with ${branch}`, transient: true };
    }
    if (!reachable) missing.push(label);
  }
  if (missing.length > 0) {
    return {
      ok: false,
      branchHead,
      trunkSha,
      missing,
      reason: `${branch} (${branchHead.slice(0, 7)}) does not contain ${missing.join(' or ')} — the refresh PR merged without preserving ancestry (a squash or rebase merge)`,
      transient: false,
    };
  }
  return { ok: true, branchHead, trunkSha };
}
