/**
 * Every settings section reads the active team from loadSettingsContext, and
 * the shell, Home, chat availability and the chat API read it from
 * resolveActiveTeamId / resolveActiveTeamScope. They must agree.
 *
 * Regression: with no `buildd-team` cookie, settings took the first team by
 * join date while the shell took pickDefaultTeam's choice (the first team with
 * workspaces). A person on three teams whose personal team came first saw the
 * header, and chat, on one team while AI features and Model providers switched
 * chat on for another. Fixture names are illustrative.
 */
import { beforeEach, describe, expect, it, mock } from 'bun:test';

const TEAMS = [
  { id: 'team-personal', name: 'Personal', slug: 'personal-user-1', role: 'owner', memberCount: 1 },
  { id: 'team-acme', name: 'Acme', slug: 'acme', role: 'owner', memberCount: 3 },
  { id: 'team-beta', name: 'Beta', slug: 'beta', role: 'member', memberCount: 2 },
];

let cookie: string | undefined;
let active: string | null = 'team-acme';
const activeCalls: Array<[string, string | null | undefined]> = [];

mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: async () => ({ id: 'user-1', email: 'a@example.com' }) }));
mock.module('next/headers', () => ({ cookies: async () => ({ get: (n: string) => (n === 'buildd-team' && cookie ? { value: cookie } : undefined) }) }));
mock.module('next/navigation', () => ({ redirect: (to: string) => { throw new Error(`redirect ${to}`); } }));
mock.module('@buildd/core/db', () => ({ db: { query: { workspaces: { findMany: async () => [] }, accounts: { findMany: async () => [] } } } }));
mock.module('@/lib/team-access', () => ({
  getUserTeamsWithDetails: async () => TEAMS,
  getUserWorkspaceIds: async () => [],
  resolveActiveTeamId: async (userId: string, c: string | null | undefined) => { activeCalls.push([userId, c]); return active; },
}));

const { loadSettingsContext } = await import('./settings-context');

beforeEach(() => {
  cookie = undefined;
  active = 'team-acme';
  activeCalls.length = 0;
});

describe('loadSettingsContext — active team', () => {
  it('uses the shared active-team resolver when the first team is not the active one', async () => {
    const ctx = await loadSettingsContext();
    expect(ctx.currentTeamId).toBe('team-acme');
    expect(ctx.currentTeam?.name).toBe('Acme');
    expect(ctx.isTeamAdmin).toBe(true);
    expect(activeCalls).toEqual([['user-1', undefined]]);
  });

  it('passes the cookie through, so a chosen team wins', async () => {
    cookie = 'team-beta';
    active = 'team-beta';
    const ctx = await loadSettingsContext();
    expect(activeCalls).toEqual([['user-1', 'team-beta']]);
    expect(ctx.currentTeamId).toBe('team-beta');
    expect(ctx.isTeamAdmin).toBe(false);
  });

  it('has no active team when the user has none', async () => {
    active = null;
    const ctx = await loadSettingsContext();
    expect(ctx.currentTeamId).toBeNull();
    expect(ctx.currentTeam).toBeNull();
    expect(ctx.isTeamAdmin).toBe(false);
  });
});
