/**
 * The app shell's shared read (spec 3ef37387 R-17, R-23). The statements are
 * rendered through a QueryBuilder (a mocked db would hide every predicate);
 * the derivation and the cache run on plain rows. Illustrative ids only.
 */
import { describe, expect, it, beforeEach } from 'bun:test';
import { QueryBuilder } from 'drizzle-orm/pg-core';
import {
  appChromeQueries, clearAppChromeCache, deriveAppChrome, invalidateAppChrome, loadAppChromeUncached,
  type TeamRow, type WorkspaceRow,
} from './app-chrome';

const USER = '11111111-1111-4111-8111-111111111111';

const team = (over: Partial<TeamRow> & { id: string }): TeamRow => ({
  name: over.id, slug: over.id, personalUserId: null, timezone: null, role: 'member',
  joinedAt: '2026-01-01T00:00:00Z', memberCount: 1, ownerCount: 1, ...over,
});

describe('appChromeQueries: scoped to the user in SQL', () => {
  const q = appChromeQueries(USER, new QueryBuilder());

  it('teams: the user\'s memberships and personal team, never every team', () => {
    const { sql, params } = q.teams.toSQL();
    expect(sql).toMatch(/from "teams" left join "team_members" on \(\("team_members"\."team_id" = "teams"\."id"\) and \("team_members"\."user_id" = \$\d+\)\)/);
    expect(sql).toMatch(/where \(\("team_members"\."user_id" = \$\d+\) or \("teams"\."personal_user_id" = \$\d+\)\)$/);
    expect(params.filter(p => p === USER).length).toBe(3);
  });

  it('workspaces: only those of the user\'s teams', () => {
    const { sql, params } = q.workspaces.toSQL();
    expect(sql).toMatch(/from "workspaces" where/);
    expect(sql).toContain('"teams"."personal_user_id" = $1');
    expect(sql).toContain('"team_members"."user_id" = $2');
    expect(params).toEqual([USER, USER]);
  });
});

describe('deriveAppChrome', () => {
  const rows: TeamRow[] = [
    team({ id: 'team-b', role: 'owner', joinedAt: '2026-03-01T00:00:00Z', memberCount: 3, ownerCount: 1, timezone: 'Europe/Berlin' }),
    team({ id: 'team-a', role: 'admin', joinedAt: '2026-02-01T00:00:00Z' }),
    // A personal team with no membership row: in scope, not in the switcher.
    team({ id: 'team-p', role: null, joinedAt: null, personalUserId: USER }),
  ];
  const ws: WorkspaceRow[] = [
    { id: 'ws-1', name: 'one', teamId: 'team-b' },
    { id: 'ws-2', name: 'two', teamId: 'team-a' },
  ];

  it('lists member teams oldest first, with counts', () => {
    const c = deriveAppChrome(USER, null, rows, ws);
    expect(c.teams.map(t => t.id)).toEqual(['team-a', 'team-b']);
    expect(c.teams[1]).toMatchObject({ role: 'owner', memberCount: 3, ownerCount: 1 });
    expect(c.workspaceIds).toEqual(['ws-1', 'ws-2']);
  });

  it('a valid cookie wins, with that team\'s workspaces, zone and role', () => {
    const c = deriveAppChrome(USER, 'team-b', rows, ws);
    expect(c.scope).toEqual({ teamId: 'team-b', workspaces: [{ id: 'ws-1', name: 'one' }], timezone: 'Europe/Berlin' });
    expect(c.role).toBe('owner');
  });

  it('a cookie naming a team the user left falls back to the default rule', () => {
    // Personal has no workspaces, so the first other team (by id) with one wins.
    const c = deriveAppChrome(USER, 'team-gone', rows, ws);
    expect(c.scope.teamId).toBe('team-a');
  });

  it('a personal team with workspaces is the default', () => {
    const c = deriveAppChrome(USER, undefined, rows, [...ws, { id: 'ws-p', name: 'mine', teamId: 'team-p' }]);
    expect(c.scope.teamId).toBe('team-p');
    expect(c.role).toBeNull();
  });

  it('no teams: no scope', () => {
    expect(deriveAppChrome(USER, 'x', [], []).scope).toEqual({ teamId: null, workspaces: [], timezone: null });
  });
});

describe('loadAppChromeUncached: 30 s per user and team cookie', () => {
  let reads = 0;
  let fail = false;
  const deps = {
    read: async (): Promise<[TeamRow[], WorkspaceRow[]]> => {
      reads++;
      if (fail) throw new Error('db down');
      return [[team({ id: 'team-a' })], [{ id: 'ws-1', name: 'one', teamId: 'team-a' }]];
    },
  };
  beforeEach(() => { reads = 0; fail = false; clearAppChromeCache(); });

  it('a second load reads nothing', async () => {
    await loadAppChromeUncached(USER, null, deps);
    await loadAppChromeUncached(USER, null, deps);
    expect(reads).toBe(1);
  });

  it('a different team cookie is its own entry', async () => {
    await loadAppChromeUncached(USER, null, deps);
    await loadAppChromeUncached(USER, 'team-a', deps);
    expect(reads).toBe(2);
  });

  it('invalidateAppChrome drops every entry of that user', async () => {
    await loadAppChromeUncached(USER, null, deps);
    await loadAppChromeUncached(USER, 'team-a', deps);
    invalidateAppChrome(USER);
    await loadAppChromeUncached(USER, null, deps);
    await loadAppChromeUncached(USER, 'team-a', deps);
    expect(reads).toBe(4);
  });

  it('a failure propagates and is not cached', async () => {
    fail = true;
    await expect(loadAppChromeUncached(USER, null, deps)).rejects.toThrow('db down');
    fail = false;
    await loadAppChromeUncached(USER, null, deps);
    expect(reads).toBe(2);
  });
});
