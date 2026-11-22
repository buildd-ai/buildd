import { describe, it, expect, mock, beforeEach } from 'bun:test';

type Row = { id: string; name: string; repo: string | null; teamId: string };
let rows: Row[] = [];
const TEAM = 'team-a';

// The resolver filters by team in SQL; the stub applies the same rule so a
// test can show another team's matching repo never resolves.
mock.module('@buildd/core/db', () => ({
  db: {
    select: () => ({ from: () => ({ where: async () => rows.filter((r) => r.teamId === TEAM) }) }),
    query: {},
  },
}));
mock.module('@/lib/workspace-resolver', () => ({ getLinkedWorkspaceIds: async () => [] }));
mock.module('@/lib/granted-links', () => ({ readReachLink: async () => null }));

import { resolveRepoParam } from './mcp-request-scope';

const account = { id: 'acc-1', teamId: TEAM };

describe('resolveRepoParam', () => {
  beforeEach(() => {
    rows = [
      { id: 'ws-app', name: 'The App', repo: 'https://github.com/acme/app', teamId: TEAM },
      { id: 'ws-other', name: 'Other', repo: 'git@github.com:acme/other.git', teamId: TEAM },
    ];
  });

  for (const ref of ['acme/app', 'ACME/App', 'app', 'https://github.com/acme/app.git', 'git@github.com:acme/app.git', 'acme/app/']) {
    it(`resolves ${ref}`, async () => {
      expect(await resolveRepoParam(ref, account)).toEqual({ kind: 'ok', workspaceId: 'ws-app' });
    });
  }

  it('matches a stored ssh form', async () => {
    expect(await resolveRepoParam('acme/other', account)).toEqual({ kind: 'ok', workspaceId: 'ws-other' });
  });

  it('does not pick when a bare name is ambiguous, and lists owner/repo only', async () => {
    rows.push({ id: 'ws-app2', name: 'App 2', repo: 'https://github.com/beta/app', teamId: TEAM });
    const r = await resolveRepoParam('app', account);
    expect(r).toEqual({ kind: 'ambiguous', candidates: ['acme/app', 'beta/app'] });
    expect(JSON.stringify(r)).not.toContain('ws-app');
  });

  it("never resolves another team's repo", async () => {
    rows = [{ id: 'ws-x', name: 'x', repo: 'https://github.com/acme/app', teamId: 'team-b' }];
    expect(await resolveRepoParam('acme/app', account)).toEqual({ kind: 'none' });
    expect(await resolveRepoParam('app', account)).toEqual({ kind: 'none' });
  });

  it('an unknown repo resolves to nothing', async () => {
    expect(await resolveRepoParam('acme/nope', account)).toEqual({ kind: 'none' });
  });
});
