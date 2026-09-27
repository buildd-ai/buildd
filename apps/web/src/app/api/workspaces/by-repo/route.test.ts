import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockAuthenticateApiKey = mock(async () => ({ id: 'acct-1', teamId: 'team-1' }) as any);
const mockFindFirst = mock(async () => null as any);

mock.module('@/lib/api-auth', () => ({ authenticateApiKey: mockAuthenticateApiKey }));
mock.module('@/lib/repo-scope', () => ({ workspaceRepoMatches: (repo: string) => ({ repo }) }));
mock.module('@buildd/core/db', () => ({
  db: { query: { workspaces: { findFirst: mockFindFirst } } },
}));
mock.module('@buildd/core/db/schema', () => ({ workspaces: {} }));

import { GET } from './route';

function req() {
  return new NextRequest('http://localhost:3000/api/workspaces/by-repo?repo=owner/repo', {
    headers: new Headers({ authorization: 'Bearer bld_test' }),
  });
}

describe('GET /api/workspaces/by-repo', () => {
  beforeEach(() => {
    mockFindFirst.mockReset();
  });

  it('never returns webhook_config secrets', async () => {
    mockFindFirst.mockResolvedValue({
      id: 'ws-1',
      name: 'Repo workspace',
      repo: 'owner/repo',
      webhookConfig: { url: 'https://hooks.example.test', token: 'tok-SHOULD-NOT-LEAK', enabled: true },
    });
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain('SHOULD-NOT-LEAK');
    expect(body).not.toMatch(/"token"\s*:/);
    const { workspace } = JSON.parse(body);
    expect(workspace.id).toBe('ws-1');
    expect(workspace.webhookConfig.hasToken).toBe(true);
  });

  it('returns null when no workspace matches', async () => {
    mockFindFirst.mockResolvedValue(undefined);
    const data = await (await GET(req())).json();
    expect(data.workspace).toBeNull();
  });
});
