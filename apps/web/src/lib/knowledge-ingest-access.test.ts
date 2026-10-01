/**
 * Ingest-job access: canClaim links plus the account's OWN team's open
 * workspaces. The open-workspace WHERE is rendered through PgDialect and the
 * stub answers by it, so an unscoped query would hand back another team's row.
 */
import { describe, expect, it, mock } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';

const render = (w: any) => new PgDialect().sqlToQuery(w);
const table = [
  { id: 'ws-a-open', teamId: 'team-a', accessMode: 'open' },
  { id: 'ws-b-open', teamId: 'team-b', accessMode: 'open' },
];
const mockWorkspacesFindMany = mock(async (args: any) => {
  const q = render(args.where);
  return table.filter(r =>
    q.params.includes(r.accessMode) && (!q.sql.includes('"team_id"') || q.params.includes(r.teamId)));
});

mock.module('@buildd/core/db', () => ({
  db: { query: { workspaces: { findMany: mockWorkspacesFindMany } } },
}));
mock.module('@/lib/account-workspace-cache', () => ({
  getAccountWorkspacePermissions: mock(async () => [
    { workspaceId: 'ws-linked', canClaim: true, canCreate: false },
    { workspaceId: 'ws-view-only', canClaim: false, canCreate: true },
  ]),
}));

const { getIngestAccessibleWorkspaceIds } = await import('./knowledge-ingest-access');

describe('getIngestAccessibleWorkspaceIds', () => {
  it('is canClaim links plus the own team\'s open workspaces, never another team\'s', async () => {
    const ids = await getIngestAccessibleWorkspaceIds({ id: 'acct-a', teamId: 'team-a' });
    expect([...ids].sort()).toEqual(['ws-a-open', 'ws-linked']);
    expect(render(mockWorkspacesFindMany.mock.calls[0][0].where).params).toEqual(['open', 'team-a']);
  });

  it('an account with no team gets its links only', async () => {
    mockWorkspacesFindMany.mockClear();
    const ids = await getIngestAccessibleWorkspaceIds({ id: 'acct-x', teamId: null });
    expect([...ids]).toEqual(['ws-linked']);
    expect(mockWorkspacesFindMany).not.toHaveBeenCalled();
  });

  it('a workspace-restricted token reaches only its own workspaces', async () => {
    const ids = await getIngestAccessibleWorkspaceIds({ id: 'acct-a', teamId: 'team-a', workspaceIds: ['ws-linked'] });
    expect([...ids]).toEqual(['ws-linked']);
  });
});
