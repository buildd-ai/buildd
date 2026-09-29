/**
 * POST /api/workspaces/match-repos matches a runner's local repos against the
 * workspaces the account can reach: its links plus its own team's open
 * workspaces. "Open" is open within the owning team.
 *
 * The open-workspace WHERE is rendered through PgDialect and the stub answers
 * by it, so an unscoped query would return (and match) another team's row.
 */
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { NextRequest } from 'next/server';
import { PgDialect } from 'drizzle-orm/pg-core';

const render = (w: any) => new PgDialect().sqlToQuery(w);

const table = [
  { id: 'ws-a', name: 'A', teamId: 'team-a', accessMode: 'open', repo: 'https://github.com/org-a/app' },
  { id: 'ws-b', name: 'B', teamId: 'team-b', accessMode: 'open', repo: 'https://github.com/org-b/app' },
];

const mockAuthenticateApiKey = mock(async (_k: any) => null as any);
const mockWorkspacesFindMany = mock(async (args: any) => {
  const q = render(args.where);
  return table.filter(r =>
    q.params.includes(r.accessMode) && (!q.sql.includes('"team_id"') || q.params.includes(r.teamId)));
});

mock.module('@/lib/api-auth', () => ({ authenticateApiKey: mockAuthenticateApiKey }));
mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      accountWorkspaces: { findMany: mock(async () => []) },
      workspaces: { findMany: mockWorkspacesFindMany },
      githubInstallations: { findMany: mock(async () => []) },
    },
  },
}));

const { POST } = await import('./route');

const req = (repos: any[]) => new NextRequest('http://localhost:3000/api/workspaces/match-repos', {
  method: 'POST',
  headers: { authorization: 'Bearer bld_x', 'content-type': 'application/json' },
  body: JSON.stringify({ repos }),
});
const repo = (owner: string) => ({
  path: `/src/${owner}`, remoteUrl: `git@github.com:${owner}/app.git`, owner, repo: 'app', provider: 'github',
});

describe('POST /api/workspaces/match-repos', () => {
  beforeEach(() => {
    mockAuthenticateApiKey.mockReset();
    mockWorkspacesFindMany.mockClear();
  });

  it('401s without an account', async () => {
    mockAuthenticateApiKey.mockResolvedValue(null);
    expect((await POST(req([]))).status).toBe(401);
  });

  it('matches the account\'s own team\'s open workspace and not another team\'s', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'acct-a', teamId: 'team-a' });
    const data = await (await POST(req([repo('org-a'), repo('org-b')]))).json();
    expect(data.matched.map((m: any) => m.workspaceId)).toEqual(['ws-a']);
    expect(data.unmatchedExternal.map((m: any) => m.owner)).toEqual(['org-b']);

    const q = render(mockWorkspacesFindMany.mock.calls[0][0].where);
    expect(q.sql).toContain('"workspaces"."team_id" in');
    expect(q.params).toEqual(['open', 'team-a']);
  });
});
