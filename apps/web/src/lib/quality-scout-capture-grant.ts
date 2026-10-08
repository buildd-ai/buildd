/**
 * The capture credential a Scout runner claim carries: a GitHub App
 * installation token minted for ONE claimed run whose probes include a
 * surface probe, so the runner can dispatch `visual-qa.yml` and read its
 * artifact (design artifact `quality-scout-runner-host` §8).
 *
 * Scope, narrowest the installation supports:
 *  - one repository: the workspace's github_repos link, never anything the
 *    runner sent (`repository_ids: [repoId]`, and the mint refuses a token
 *    GitHub did not scope to exactly that repo);
 *  - Actions write (dispatch, list runs, read artifacts) plus the implicit
 *    metadata read. No contents, pull requests, issues or checks: none of the
 *    capture port's calls need them.
 *  - Refused when the installation's permission set is unknown: an unnarrowed
 *    request would inherit every permission the installation has.
 *
 * Lifetime: GitHub mints installation tokens for an hour and offers nothing
 * shorter. The grant's `expiresAt` is clipped to the run's lease (see
 * `claimScoutRunForRunner`); the runner stops using the token there and
 * revokes it when the run ends. The token is never stored here: no column,
 * no cache, no log line. Every mint and refusal is recorded in the capability
 * ledger (`github.scout_capture_grant`) with ids only.
 *
 * Only reached for a trusted host-runner key (`accounts.hostRunner`), after
 * the lease is won.
 */
import { and, eq } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { workspaces } from '@buildd/core/db/schema';
import { resolveVisualQaConfig } from '@buildd/core/visual-qa-page-source';
import type { ScoutRun } from '@buildd/core/quality-scout/types';
import type { ScoutCaptureUnavailableReason } from '@buildd/shared';
import { recordCapabilityDecision } from '@/lib/agent-capabilities/audit';
import type { LinkedGithubRepo } from '@/lib/agent-capabilities/github';
import { mintRepoScopedInstallationToken, scopedTokenPermissions, type PermissionLevel, type ScopedInstallationToken } from '@/lib/github-scoped-token';
import type { ScoutCaptureMint } from '@/lib/quality-scout-runner-host';

/** What a capture token may do: `visual-qa.yml` dispatch, its runs, its artifact. */
export const SCOUT_CAPTURE_TOKEN_PERMISSIONS: Readonly<Record<string, PermissionLevel>> = {
  actions: 'write',
  metadata: 'read',
};

export interface ScoutCaptureWorkspace {
  id: string;
  gitConfig: { visualQa?: unknown } | null;
  githubRepoId: string | null;
  githubRepo: LinkedGithubRepo | null;
}

export type ScoutCaptureGrantDecision =
  | {
      allowed: true;
      repo: { repoId: number; fullName: string; rowId: string };
      installationId: number;
      permissions: Record<string, PermissionLevel>;
    }
  | { allowed: false; reason: ScoutCaptureUnavailableReason };

/**
 * May this workspace's claimed run get a capture token, and with exactly
 * which permissions. Pure: no GitHub call, no DB.
 */
export function authorizeScoutCaptureGrant(ws: ScoutCaptureWorkspace, claimedRepo: string): ScoutCaptureGrantDecision {
  // Sandbox page source only; a preview is a browser runner's (a later slice).
  if (resolveVisualQaConfig(ws.gitConfig?.visualQa).pageSource !== 'sandbox') return { allowed: false, reason: 'page_source_not_sandbox' };
  const repo = ws.githubRepo;
  if (!ws.githubRepoId || !repo || repo.id !== ws.githubRepoId || !repo.installation) return { allowed: false, reason: 'no_linked_repo' };
  // The claim named this repo; the token is for that one and no other.
  if (repo.fullName.toLowerCase() !== claimedRepo.toLowerCase()) return { allowed: false, reason: 'no_linked_repo' };
  if (repo.installation.suspendedAt) return { allowed: false, reason: 'installation_suspended' };
  const permissions = scopedTokenPermissions(repo.installation.permissions, SCOUT_CAPTURE_TOKEN_PERMISSIONS);
  // Unknown installed set (undefined) would mint an unnarrowed token; too little would fail at dispatch.
  if (!permissions || permissions.actions !== 'write') return { allowed: false, reason: 'permissions_unavailable' };
  return {
    allowed: true,
    repo: { repoId: repo.repoId, fullName: repo.fullName, rowId: repo.id },
    installationId: repo.installation.installationId,
    permissions,
  };
}

export interface ScoutCaptureGrantDeps {
  loadWorkspace(workspaceId: string, teamId: string): Promise<ScoutCaptureWorkspace | null>;
  mint(q: { installationId: number; repoId: number; permissions: Record<string, PermissionLevel> }): Promise<ScopedInstallationToken>;
  record: typeof recordCapabilityDecision;
}

export const dbScoutCaptureGrantDeps: ScoutCaptureGrantDeps = {
  async loadWorkspace(workspaceId, teamId) {
    const ws = await db.query.workspaces.findFirst({
      where: and(eq(workspaces.id, workspaceId), eq(workspaces.teamId, teamId)),
      columns: { id: true, gitConfig: true, githubRepoId: true },
      with: {
        githubRepo: {
          columns: { id: true, repoId: true, owner: true, name: true, fullName: true },
          with: { installation: { columns: { installationId: true, suspendedAt: true, permissions: true } } },
        },
      },
    });
    if (!ws) return null;
    return {
      id: ws.id,
      gitConfig: (ws.gitConfig ?? null) as ScoutCaptureWorkspace['gitConfig'],
      githubRepoId: ws.githubRepoId ?? null,
      githubRepo: (ws.githubRepo ?? null) as LinkedGithubRepo | null,
    };
  },
  mint: ({ installationId, repoId, permissions }) =>
    // `wanted` is the already-narrowed set; the installed set is passed as the
    // same map so scopedTokenPermissions keeps it exactly.
    mintRepoScopedInstallationToken({ installationId, repoId, installedPermissions: permissions, wanted: permissions }),
  record: recordCapabilityDecision,
};

/** The claim's `mintCaptureGrant` for a caller: team-scoped, audited, never stored. */
export function scoutCaptureGrantMinter(
  caller: { accountId: string; teamId: string },
  deps: ScoutCaptureGrantDeps = dbScoutCaptureGrantDeps,
): (q: { run: ScoutRun; repo: string; leaseExpiresAt: Date }) => Promise<ScoutCaptureMint> {
  return async ({ run, repo }) => {
    const audit = {
      capability: 'github.scout_capture_grant' as const,
      workspaceId: run.workspaceId,
      accountId: caller.accountId,
      principalVia: 'runner_key' as const,
    };
    const ws = await deps.loadWorkspace(run.workspaceId, caller.teamId);
    const decision = ws ? authorizeScoutCaptureGrant(ws, repo) : ({ allowed: false, reason: 'no_linked_repo' } as const);
    if (!decision.allowed) {
      void deps.record({ ...audit, decision: 'refused', resource: `scout_run:${run.id}`, reasonCode: decision.reason });
      return { ok: false, reason: decision.reason };
    }
    try {
      const minted = await deps.mint({ installationId: decision.installationId, repoId: decision.repo.repoId, permissions: decision.permissions });
      void deps.record({ ...audit, decision: 'allowed', resource: `github_repo:${decision.repo.rowId}`, reasonCode: `scout_run:${run.id}`, expiresAt: minted.expiresAt });
      return {
        ok: true,
        grant: { token: minted.token, expiresAt: minted.expiresAt.toISOString(), repository: decision.repo.fullName, pageSource: 'sandbox' },
      };
    } catch (err) {
      void deps.record({ ...audit, decision: 'refused', resource: `github_repo:${decision.repo.rowId}`, reasonCode: 'mint_failed' });
      console.error('[quality-scout] capture token mint failed:', err instanceof Error ? err.message.slice(0, 160) : 'unknown error');
      return { ok: false, reason: 'mint_failed' };
    }
  };
}
