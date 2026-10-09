/**
 * Opt-in check that a team member can read the workspace's GitHub repository.
 *
 * With `gitConfig.memberRepoAccess` off (the default), team membership is the
 * whole access check: a member sees everything Buildd can see in the repo
 * through its GitHub App installation. With it set to `require_read`, a person
 * (dashboard session or OAuth MCP session — never an API key or a runner) must
 * also hold read or higher on the repo on GitHub itself before Buildd shows
 * them code, files tasks for them, or lets chat work over the workspace.
 *
 * Identity: users.githubId (numeric, set on GitHub sign-in or linked by email).
 * The login is not stored, so it is resolved from the id each time the cache
 * is cold (GET /user/{id}), then the repo permission is read with the
 * installation token (GET /repos/{owner}/{repo}/collaborators/{login}/permission).
 * The repo comes from the workspace's github_repos FK, never the free-text
 * workspaces.repo column.
 *
 * Fails closed: when the setting is on and anything cannot be confirmed, the
 * answer is `check_failed` and access is refused. Owners are not exempt.
 */

import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { users, workspaces } from '@buildd/core/db/schema';
import { getInstallationToken } from '@buildd/core/github-installation-auth';
import { TTLCache } from './cache';
import { getKey, setWithTtl } from './redis';
import {
  memberRepoAccessMessage,
  resolveMemberRepoAccessMode,
  type MemberRepoAccessMode,
  type MemberRepoAccessResult,
} from './member-repo-access-shared';

export * from './member-repo-access-shared';

export const MEMBER_REPO_ACCESS_TTL_SEC = 10 * 60;

export interface WorkspaceRepoFacts {
  mode: MemberRepoAccessMode;
  repoFullName: string | null;
  /** GitHub's numeric installation id (github_installations.installation_id). */
  installationId: number | null;
}

export interface GitHubReply {
  status: number;
  body: unknown;
}

export interface MemberRepoAccessDeps {
  loadWorkspace(workspaceId: string): Promise<WorkspaceRepoFacts | null>;
  loadGithubId(userId: string): Promise<string | null>;
  github(installationId: number, path: string): Promise<GitHubReply>;
  cacheGet(key: string): Promise<MemberRepoAccessResult | null>;
  cacheSet(key: string, value: MemberRepoAccessResult): Promise<void>;
}

const READ_OR_HIGHER = new Set(['read', 'triage', 'write', 'maintain', 'admin']);

function denied(reason: MemberRepoAccessResult['reason'], repoFullName: string | null): MemberRepoAccessResult {
  return { allowed: false, reason, repoFullName };
}

/** The check itself, with every side effect injected. */
export async function checkMemberRepoAccess(
  userId: string,
  workspaceId: string,
  deps: MemberRepoAccessDeps,
): Promise<MemberRepoAccessResult> {
  let ws: WorkspaceRepoFacts | null;
  try {
    ws = await deps.loadWorkspace(workspaceId);
  } catch {
    // Cannot read the setting. Unknown is not "off".
    return denied('check_failed', null);
  }
  if (!ws) return denied('check_failed', null);
  if (ws.mode === 'off') return { allowed: true, reason: 'off', repoFullName: ws.repoFullName };

  const repo = ws.repoFullName;
  if (!repo || !ws.installationId || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    return denied('check_failed', repo);
  }

  let githubId: string | null;
  try {
    githubId = await deps.loadGithubId(userId);
  } catch {
    return denied('check_failed', repo);
  }
  if (!githubId || !/^\d+$/.test(githubId)) return denied('no_github_link', repo);

  const key = `member-repo-access:${workspaceId}:${userId}:${githubId}:${repo.toLowerCase()}`;
  const cached = await deps.cacheGet(key).catch(() => null);
  if (cached) return cached;

  let result: MemberRepoAccessResult;
  try {
    const user = await deps.github(ws.installationId, `/user/${githubId}`);
    if (user.status === 404) {
      // The linked GitHub account no longer exists: linking a current one fixes it.
      return denied('no_github_link', repo);
    }
    const login = user.status === 200 ? (user.body as { login?: unknown } | null)?.login : null;
    if (typeof login !== 'string' || !/^[A-Za-z0-9-]+$/.test(login)) return denied('check_failed', repo);

    const perm = await deps.github(ws.installationId, `/repos/${repo}/collaborators/${login}/permission`);
    if (perm.status === 404) {
      result = denied('not_collaborator', repo);
    } else if (perm.status !== 200) {
      return denied('check_failed', repo);
    } else {
      const p = (perm.body as { permission?: unknown } | null)?.permission;
      if (typeof p !== 'string') return denied('check_failed', repo);
      result = READ_OR_HIGHER.has(p)
        ? { allowed: true, reason: 'collaborator', repoFullName: repo }
        : denied('not_collaborator', repo);
    }
  } catch {
    return denied('check_failed', repo);
  }

  // Only GitHub's own answers are cached; a failure is retried next request.
  await deps.cacheSet(key, result).catch(() => {});
  return result;
}

// ── Default wiring ──────────────────────────────────────────────────────────

const l1 = new TTLCache<MemberRepoAccessResult>({ maxSize: 2000, ttlMs: MEMBER_REPO_ACCESS_TTL_SEC * 1000 });

export async function loadWorkspaceRepoFacts(workspaceId: string): Promise<WorkspaceRepoFacts | null> {
  const ws = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, workspaceId),
    columns: { gitConfig: true },
    with: {
      githubRepo: {
        columns: { fullName: true },
        with: { installation: { columns: { installationId: true } } },
      },
    },
  });
  if (!ws) return null;
  const repo = (ws as { githubRepo?: { fullName: string; installation?: { installationId: number } | null } | null }).githubRepo;
  return {
    mode: resolveMemberRepoAccessMode(ws.gitConfig),
    repoFullName: repo?.fullName ?? null,
    installationId: repo?.installation?.installationId ?? null,
  };
}

export const defaultMemberRepoAccessDeps: MemberRepoAccessDeps = {
  loadWorkspace: loadWorkspaceRepoFacts,
  async loadGithubId(userId) {
    const u = await db.query.users.findFirst({ where: eq(users.id, userId), columns: { githubId: true } });
    return u?.githubId ?? null;
  },
  async github(installationId, path) {
    const token = await getInstallationToken(installationId);
    const res = await fetch(`https://api.github.com${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    const body = res.status === 200 ? await res.json().catch(() => null) : null;
    return { status: res.status, body };
  },
  async cacheGet(key) {
    const hit = l1.get(key);
    if (hit) return hit;
    const remote = await getKey<MemberRepoAccessResult>(key);
    if (remote) l1.set(key, remote);
    return remote ?? null;
  },
  async cacheSet(key, value) {
    l1.set(key, value);
    await setWithTtl(key, value, MEMBER_REPO_ACCESS_TTL_SEC);
  },
};

/** Whether this person may use the workspace's repo-backed surfaces. */
export function memberHasRepoAccess(
  userId: string,
  workspaceId: string,
  deps: MemberRepoAccessDeps = defaultMemberRepoAccessDeps,
): Promise<MemberRepoAccessResult> {
  return checkMemberRepoAccess(userId, workspaceId, deps);
}

/**
 * The person behind a request, for this check: a dashboard session user, or
 * the user behind an OAuth MCP session. API keys, task tokens and runners
 * carry no person and are never checked.
 */
export function memberRepoAccessSubject(
  apiAccount: object | null | undefined,
  sessionUser: { id: string } | null | undefined,
): string | null {
  if (apiAccount) {
    const id = (apiAccount as { sessionUserId?: unknown }).sessionUserId;
    return typeof id === 'string' && id ? id : null;
  }
  return sessionUser?.id ?? null;
}

/**
 * The choke-point helper: null when the request may proceed, else a 403 with
 * the reason. `userId` null (an API key or runner) always proceeds.
 */
export async function assertMemberRepoAccess(
  userId: string | null,
  workspaceId: string | null,
  deps: MemberRepoAccessDeps = defaultMemberRepoAccessDeps,
): Promise<NextResponse | null> {
  if (!userId || !workspaceId) return null;
  const result = await checkMemberRepoAccess(userId, workspaceId, deps);
  if (result.allowed) return null;
  return NextResponse.json({
    error: 'member_repo_access',
    reason: result.reason,
    message: memberRepoAccessMessage(result),
  }, { status: 403 });
}

/**
 * Drop the workspaces this person fails the check on. Only workspaces with
 * the setting on are checked against GitHub; `modes` lets a caller that
 * already loaded gitConfig skip the extra read.
 */
export async function filterWorkspacesByMemberRepoAccess(
  userId: string,
  workspaceIds: Iterable<string>,
  opts: { gitConfigOf?: (id: string) => unknown; deps?: MemberRepoAccessDeps } = {},
): Promise<Set<string>> {
  const deps = opts.deps ?? defaultMemberRepoAccessDeps;
  const ids = [...workspaceIds];
  const results = await Promise.all(ids.map(async id => {
    if (opts.gitConfigOf && resolveMemberRepoAccessMode(opts.gitConfigOf(id)) === 'off') return true;
    const r = await checkMemberRepoAccess(userId, id, deps).catch(() => ({ allowed: false }));
    return r.allowed;
  }));
  return new Set(ids.filter((_, i) => results[i]));
}
