/**
 * Who may "Approve and override" a review escalation: approve the PR's current
 * head past required findings that are still open or awaiting verification
 * (Living Spec r7 AC-45/AC-46; docs/specs/workflow-kernel-library.md §7).
 *
 * Three readings, all of them required, none a hardcoded list:
 *  1. the workspace merge policy (`gitConfig.mergePolicy.reviewOverride`):
 *     'admins' (the default) or 'off';
 *  2. the person's team role in the team that owns the workspace: owner or admin;
 *  3. their merge permission on the repo on GitHub (write, maintain or admin),
 *     read with the workspace's installation token, the way member-repo-access
 *     reads read access (users.githubId → login → collaborator permission).
 *
 * The host computes this and passes it to the kernel (`overridePermitted`,
 * `hasMergePermission` on T23 HumanResolve); the kernel refuses an approval past
 * findings without both. Fails closed: anything that cannot be confirmed is no.
 */

import { and, eq } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { teamMembers, workspaces } from '@buildd/core/db/schema';
import { sqlWhere } from '@buildd/core/db/relational-sql';
import { TTLCache } from './cache';
import { defaultMemberRepoAccessDeps, type GitHubReply } from './member-repo-access';

export type ReviewOverrideRefusal = 'policy_off' | 'role' | 'no_merge_permission' | 'no_github_link' | 'check_failed';

export interface ReviewOverridePermission {
  /** The merge policy allows an override and the person's team role may take it. */
  overridePermitted: boolean;
  /** GitHub says the person may merge on the workspace's repo. */
  hasMergePermission: boolean;
  /** The first reason this person cannot override, or null when they can. */
  refusal: ReviewOverrideRefusal | null;
}

export interface ReviewOverrideDeps {
  loadWorkspace(workspaceId: string): Promise<{ teamId: string; gitConfig: unknown; repoFullName: string | null; installationId: number | null } | null>;
  loadTeamRole(userId: string, teamId: string): Promise<string | null>;
  loadGithubId(userId: string): Promise<string | null>;
  github(installationId: number, path: string): Promise<GitHubReply>;
}

const OVERRIDE_ROLES = new Set(['owner', 'admin']);
const MERGE_OR_HIGHER = new Set(['write', 'maintain', 'admin']);

/** The workspace merge policy's answer; absent or unrecognised reads as the default, 'admins'. */
export function reviewOverridePolicyOf(gitConfig: unknown): 'admins' | 'off' {
  const mp = gitConfig && typeof gitConfig === 'object' ? (gitConfig as { mergePolicy?: unknown }).mergePolicy : null;
  const v = mp && typeof mp === 'object' ? (mp as { reviewOverride?: unknown }).reviewOverride : undefined;
  return v === 'off' ? 'off' : 'admins';
}

const no = (refusal: ReviewOverrideRefusal, overridePermitted: boolean): ReviewOverridePermission => ({ overridePermitted, hasMergePermission: false, refusal });

/** GitHub's merge-permission reading for one person on one repo. */
async function mergePermission(userId: string, repo: string, installationId: number, deps: ReviewOverrideDeps): Promise<'yes' | 'no' | 'no_github_link' | 'check_failed'> {
  const githubId = await deps.loadGithubId(userId);
  if (!githubId || !/^\d+$/.test(githubId)) return 'no_github_link';
  const user = await deps.github(installationId, `/user/${githubId}`);
  if (user.status === 404) return 'no_github_link';
  const login = user.status === 200 ? (user.body as { login?: unknown } | null)?.login : null;
  if (typeof login !== 'string' || !/^[A-Za-z0-9-]+$/.test(login)) return 'check_failed';
  const perm = await deps.github(installationId, `/repos/${repo}/collaborators/${login}/permission`);
  if (perm.status === 404) return 'no';
  if (perm.status !== 200) return 'check_failed';
  const p = (perm.body as { permission?: unknown } | null)?.permission;
  if (typeof p !== 'string') return 'check_failed';
  return MERGE_OR_HIGHER.has(p) ? 'yes' : 'no';
}

/** The check, with every side effect injected. */
export async function checkReviewOverridePermission(userId: string, workspaceId: string, deps: ReviewOverrideDeps): Promise<ReviewOverridePermission> {
  try {
    const ws = await deps.loadWorkspace(workspaceId);
    if (!ws) return no('check_failed', false);
    if (reviewOverridePolicyOf(ws.gitConfig) === 'off') return no('policy_off', false);
    const role = await deps.loadTeamRole(userId, ws.teamId);
    const roleOk = !!role && OVERRIDE_ROLES.has(role);
    const repo = ws.repoFullName;
    if (!repo || !ws.installationId || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) return no(roleOk ? 'check_failed' : 'role', roleOk);
    // A person the role refuses needs no GitHub call.
    if (!roleOk) return no('role', false);
    const merge = await mergePermission(userId, repo, ws.installationId, deps);
    if (merge === 'yes') return { overridePermitted: true, hasMergePermission: true, refusal: null };
    return no(merge === 'no' ? 'no_merge_permission' : merge, true);
  } catch {
    return no('check_failed', false);
  }
}

/** The sentence a person sees when they cannot override. */
export function reviewOverrideRefusalSentence(r: ReviewOverrideRefusal, repoFullName?: string | null): string {
  const repo = repoFullName ?? 'this repository';
  switch (r) {
    case 'policy_off': return 'The merge policy does not allow approving past remaining findings.';
    case 'role': return 'Only a team owner or admin can approve past remaining findings.';
    case 'no_merge_permission': return `You do not hold merge permission on ${repo} on GitHub.`;
    case 'no_github_link': return 'Link your GitHub account to buildd, so your merge permission on the repository can be checked.';
    case 'check_failed': return 'Your merge permission on GitHub could not be checked just now. Try again in a moment.';
  }
}

/** The answer as the escalation brief takes it (EscalationBriefPermissions), with the sentence for a refusal. */
export function escalationPermissionsOf(p: ReviewOverridePermission): { overridePermitted: boolean; hasMergePermission: boolean; overrideUnavailableReason: string | null } {
  return {
    overridePermitted: p.overridePermitted,
    hasMergePermission: p.hasMergePermission,
    overrideUnavailableReason: p.refusal ? reviewOverrideRefusalSentence(p.refusal) : null,
  };
}

// ── Default wiring ──────────────────────────────────────────────────────────

// A short cache: a page that renders the decision card and the click that follows read once.
const l1 = new TTLCache<ReviewOverridePermission>({ maxSize: 2000, ttlMs: 2 * 60 * 1000 });

export const defaultReviewOverrideDeps: ReviewOverrideDeps = {
  async loadWorkspace(workspaceId) {
    const ws = await db.query.workspaces.findFirst({
      where: sqlWhere(eq(workspaces.id, workspaceId)),
      columns: { teamId: true, gitConfig: true },
      with: { githubRepo: { columns: { fullName: true }, with: { installation: { columns: { installationId: true } } } } },
    });
    if (!ws) return null;
    const repo = (ws as { githubRepo?: { fullName: string; installation?: { installationId: number } | null } | null }).githubRepo;
    return { teamId: ws.teamId, gitConfig: ws.gitConfig, repoFullName: repo?.fullName ?? null, installationId: repo?.installation?.installationId ?? null };
  },
  async loadTeamRole(userId, teamId) {
    const m = await db.query.teamMembers.findFirst({
      where: sqlWhere(and(eq(teamMembers.userId, userId), eq(teamMembers.teamId, teamId))),
      columns: { role: true },
    });
    return m?.role ?? null;
  },
  loadGithubId: defaultMemberRepoAccessDeps.loadGithubId,
  github: defaultMemberRepoAccessDeps.github,
};

/**
 * Whether this person may approve and override in this workspace. `fresh` skips the cache:
 * the door re-reads it at the click; the page render may use a recent answer.
 */
export async function reviewOverridePermission(
  userId: string,
  workspaceId: string,
  o: { fresh?: boolean; deps?: ReviewOverrideDeps } = {},
): Promise<ReviewOverridePermission> {
  const key = `${workspaceId}:${userId}`;
  if (!o.fresh && !o.deps) {
    const hit = l1.get(key);
    if (hit) return hit;
  }
  const r = await checkReviewOverridePermission(userId, workspaceId, o.deps ?? defaultReviewOverrideDeps);
  // Only a settled answer is cached; a failed check is asked again next time.
  if (!o.deps && r.refusal !== 'check_failed') l1.set(key, r);
  return r;
}
