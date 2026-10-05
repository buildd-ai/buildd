import { describe, it, expect, beforeEach, mock } from 'bun:test';

const mockMint = mock((_p: any) => Promise.resolve({ token: 'ghs_scoped', expiresAt: new Date('2026-01-01T01:00:00Z') }));
mock.module('@/lib/github-scoped-token', () => ({ mintRepoScopedInstallationToken: mockMint }));

import { authorizeGithubRepoGrant, mintGithubRepoGrant, REPO_GRANT_CAPABILITIES } from './github';
import type { AgentPrincipal } from './principal';

// ── fixtures (illustrative) ───────────────────────────────────────────────────

const PRINCIPAL: AgentPrincipal = {
  kind: 'agent_run', via: 'dispatch', workerId: 'worker-1', taskId: 'task-1',
  workspaceId: 'ws-1', teamId: 'team-1', accountId: 'account-1',
};

const repoA = {
  id: 'repo-row-a', repoId: 1111, owner: 'acme', name: 'widget', fullName: 'acme/widget',
  installation: { installationId: 99, suspendedAt: null, permissions: { contents: 'write' } },
};

beforeEach(() => mockMint.mockClear());

describe('authorizeGithubRepoGrant', () => {
  it('grants the linked repo, for the git data plane only', () => {
    const d = authorizeGithubRepoGrant(PRINCIPAL, { githubRepoId: 'repo-row-a', githubRepo: repoA });
    expect(d.allowed).toBe(true);
    if (!d.allowed) return;
    expect(d.resource).toEqual({ type: 'github_repo', id: 'repo-row-a' });
    expect(d.repo.fullName).toBe('acme/widget');
    expect(d.capabilities).toEqual(['git.read', 'git.push_task_branch']);
    // PR mutations go through buildd's control plane, never a raw token.
    expect(REPO_GRANT_CAPABILITIES.some(c => c.startsWith('pr.'))).toBe(false);
  });

  it('refuses a joined repo row that is not the workspace’s FK', () => {
    const d = authorizeGithubRepoGrant(PRINCIPAL, { githubRepoId: 'repo-row-b', githubRepo: repoA });
    expect(!d.allowed && d.reasonCode).toBe('no_linked_repo');
  });

  it('refuses a workspace with no link, whatever else it carries', () => {
    // workspaces.repo (free text) is not an input: only the FK is read.
    const ws = { githubRepoId: null, githubRepo: null, repo: 'https://github.com/acme/other' } as any;
    const d = authorizeGithubRepoGrant(PRINCIPAL, ws);
    expect(!d.allowed && d.reasonCode).toBe('no_linked_repo');
  });

  it('refuses a repo with no installation', () => {
    const d = authorizeGithubRepoGrant(PRINCIPAL, { githubRepoId: 'repo-row-a', githubRepo: { ...repoA, installation: null } });
    expect(!d.allowed && d.reasonCode).toBe('no_linked_repo');
  });

  it('refuses a suspended installation', () => {
    const repo = { ...repoA, installation: { ...repoA.installation, suspendedAt: new Date() } };
    const d = authorizeGithubRepoGrant(PRINCIPAL, { githubRepoId: 'repo-row-a', githubRepo: repo });
    expect(!d.allowed && d.reasonCode).toBe('installation_suspended');
  });
});

describe('mintGithubRepoGrant', () => {
  it('mints for exactly the decided repo and installation', async () => {
    const d = authorizeGithubRepoGrant(PRINCIPAL, { githubRepoId: 'repo-row-a', githubRepo: repoA });
    if (!d.allowed) throw new Error('expected an allowed decision');
    const minted = await mintGithubRepoGrant(d);
    expect(minted.token).toBe('ghs_scoped');
    expect(mockMint).toHaveBeenCalledTimes(1);
    expect(mockMint).toHaveBeenCalledWith({ installationId: 99, repoId: 1111, installedPermissions: { contents: 'write' } });
  });
});
