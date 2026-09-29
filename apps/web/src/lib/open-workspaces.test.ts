/**
 * "Open" means open within the owning team. The predicate is rendered through
 * PgDialect so the team clause is observable; a mocked db's return value alone
 * would say nothing about what the WHERE asked for.
 */
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';

const mockWorkspacesFindMany = mock(async (_args: any) => [] as any[]);
const mockWorkspacesFindFirst = mock(async (_args: any) => null as any);
const mockLinksFindFirst = mock(async (_args: any) => null as any);

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workspaces: { findMany: mockWorkspacesFindMany, findFirst: mockWorkspacesFindFirst },
      accountWorkspaces: { findFirst: mockLinksFindFirst },
    },
  },
}));

const { openInTeams, listOpenWorkspaces, isOpenWithinTeams, workspaceOpenToCaller } = await import('./open-workspaces');

const render = (w: any) => new PgDialect().sqlToQuery(w);

describe('openInTeams', () => {
  it('carries both the open mode and the owning-team clause', () => {
    const q = render(openInTeams(['team-a']));
    expect(q.sql).toBe('("workspaces"."access_mode" = $1 and "workspaces"."team_id" in ($2))');
    expect(q.params).toEqual(['open', 'team-a']);
  });

  it('refuses an empty team list instead of matching every team', () => {
    expect(() => openInTeams([])).toThrow();
  });
});

describe('listOpenWorkspaces', () => {
  beforeEach(() => {
    mockWorkspacesFindMany.mockReset();
    mockWorkspacesFindMany.mockResolvedValue([]);
  });

  it('queries only the given teams', async () => {
    await listOpenWorkspaces(['team-a', 'team-a', 'team-b'], { id: true });
    const q = render(mockWorkspacesFindMany.mock.calls[0][0].where);
    expect(q.sql).toContain('"workspaces"."team_id" in ($2, $3)');
    expect(q.params).toEqual(['open', 'team-a', 'team-b']);
  });

  it('with no teams, does not query at all', async () => {
    expect(await listOpenWorkspaces([], { id: true })).toEqual([]);
    expect(mockWorkspacesFindMany).not.toHaveBeenCalled();
  });
});

describe('isOpenWithinTeams', () => {
  it('is true only for an open workspace of one of the teams', () => {
    expect(isOpenWithinTeams({ teamId: 'team-a', accessMode: 'open' }, ['team-a'])).toBe(true);
    expect(isOpenWithinTeams({ teamId: 'team-b', accessMode: 'open' }, ['team-a'])).toBe(false);
    expect(isOpenWithinTeams({ teamId: 'team-a', accessMode: 'restricted' }, ['team-a'])).toBe(false);
    expect(isOpenWithinTeams({ teamId: null, accessMode: 'open' }, ['team-a'])).toBe(false);
    expect(isOpenWithinTeams(null, ['team-a'])).toBe(false);
  });
});

describe('workspaceOpenToCaller', () => {
  beforeEach(() => {
    mockWorkspacesFindFirst.mockReset();
    mockLinksFindFirst.mockReset();
    mockLinksFindFirst.mockResolvedValue(null);
  });

  it('grants an open workspace of the caller\'s own team', async () => {
    mockWorkspacesFindFirst.mockResolvedValue({ teamId: 'team-a', accessMode: 'open' });
    expect(await workspaceOpenToCaller('ws-1', { teamIds: ['team-a'] })).toBe(true);
  });

  it('does not grant another team\'s open workspace', async () => {
    mockWorkspacesFindFirst.mockResolvedValue({ teamId: 'team-b', accessMode: 'open' });
    expect(await workspaceOpenToCaller('ws-1', { teamIds: ['team-a'] })).toBe(false);
    expect(await workspaceOpenToCaller('ws-1', { teamIds: ['team-a'], accountId: 'acct-a' })).toBe(false);
  });

  it('grants another team\'s open workspace to an account linked to it', async () => {
    mockWorkspacesFindFirst.mockResolvedValue({ teamId: 'team-b', accessMode: 'open' });
    mockLinksFindFirst.mockResolvedValue({ workspaceId: 'ws-1' });
    expect(await workspaceOpenToCaller('ws-1', { teamIds: ['team-a'], accountId: 'acct-a' })).toBe(true);
    const q = render(mockLinksFindFirst.mock.calls[0][0].where);
    expect(q.params).toEqual(['acct-a', 'ws-1']);
  });

  it('never grants a restricted workspace, link or not', async () => {
    mockWorkspacesFindFirst.mockResolvedValue({ teamId: 'team-a', accessMode: 'restricted' });
    mockLinksFindFirst.mockResolvedValue({ workspaceId: 'ws-1' });
    expect(await workspaceOpenToCaller('ws-1', { teamIds: ['team-a'], accountId: 'acct-a' })).toBe(false);
  });

  it('is false for no workspace or a missing one', async () => {
    expect(await workspaceOpenToCaller(null, { teamIds: ['team-a'] })).toBe(false);
    mockWorkspacesFindFirst.mockResolvedValue(null);
    expect(await workspaceOpenToCaller('ws-1', { teamIds: ['team-a'] })).toBe(false);
  });
});
