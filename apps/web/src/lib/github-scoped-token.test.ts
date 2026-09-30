import { describe, it, expect, mock } from 'bun:test';

mock.module('./github', () => ({ generateAppJWT: () => 'app-jwt' }));

import { mintRepoScopedInstallationToken, scopedTokenPermissions, TASK_TOKEN_PERMISSIONS } from './github-scoped-token';

function res(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('scopedTokenPermissions', () => {
  it('takes the lower of wanted and installed, and drops what the installation lacks', () => {
    expect(scopedTokenPermissions({ contents: 'write', pull_requests: 'read', metadata: 'read', administration: 'write' })).toEqual({
      contents: 'write',
      pull_requests: 'read',
      metadata: 'read',
    });
  });

  it('never asks for more than wanted even when the installation has admin', () => {
    expect(scopedTokenPermissions({ contents: 'admin', checks: 'write' })).toEqual({ contents: 'write', checks: 'read' });
  });

  // Workflow-file changes are escalated to a person, not pushed by a task run.
  it('never requests workflows, even when the installation grants it', () => {
    expect(TASK_TOKEN_PERMISSIONS).not.toHaveProperty('workflows');
    expect(scopedTokenPermissions({ contents: 'write', workflows: 'write' })).toEqual({ contents: 'write' });
  });

  it('unknown installed set: no permissions field (still repo-scoped)', () => {
    expect(scopedTokenPermissions(null)).toBeUndefined();
    expect(scopedTokenPermissions({})).toBeUndefined();
  });
});

describe('mintRepoScopedInstallationToken', () => {
  it('asks GitHub for a token limited to the one repository id', async () => {
    let sent: { url: string; init: RequestInit } | null = null;
    const fetchMock = (async (url: string, init: RequestInit) => {
      sent = { url, init };
      return res(201, { token: 'ghs_scoped', expires_at: '2026-01-01T01:00:00Z', repositories: [{ id: 42 }] });
    }) as unknown as typeof fetch;
    const out = await mintRepoScopedInstallationToken(
      { installationId: 7, repoId: 42, installedPermissions: { contents: 'write' } },
      { fetch: fetchMock },
    );
    expect(out.token).toBe('ghs_scoped');
    expect(out.expiresAt.toISOString()).toBe('2026-01-01T01:00:00.000Z');
    expect(sent!.url).toBe('https://api.github.com/app/installations/7/access_tokens');
    expect((sent!.init.headers as Record<string, string>).Authorization).toBe('Bearer app-jwt');
    expect(JSON.parse(String(sent!.init.body))).toEqual({ repository_ids: [42], permissions: { contents: 'write' } });
  });

  it('refuses a token GitHub scoped to anything but exactly that repository', async () => {
    const fetchMock = (async () => res(201, {
      token: 'ghs_wide', expires_at: '2026-01-01T01:00:00Z', repositories: [{ id: 42 }, { id: 43 }],
    })) as unknown as typeof fetch;
    await expect(mintRepoScopedInstallationToken({ installationId: 7, repoId: 42 }, { fetch: fetchMock })).rejects.toThrow(/exactly/);
  });

  it('surfaces a GitHub error', async () => {
    const fetchMock = (async () => res(422, { message: 'permissions exceed installation' })) as unknown as typeof fetch;
    await expect(mintRepoScopedInstallationToken({ installationId: 7, repoId: 42 }, { fetch: fetchMock })).rejects.toThrow(/422/);
  });
});
