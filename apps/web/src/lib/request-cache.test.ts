import { describe, it, expect, beforeEach, mock } from 'bun:test';

/**
 * Guards that the per-request auth/scope helpers are wrapped in React
 * `cache()`, so the protected layout and the page it renders share one result
 * instead of each paying for the same authorization queries.
 *
 * Why the `react` module is stubbed rather than used as-is: under the unit-test
 * runner, `react` resolves to its *client* build, whose `cache` export is
 * literally `fn.apply(null, arguments)` — an identity pass-through. Only the
 * `react-server` conditional export carries the memoizing implementation, and
 * nothing in this harness selects that condition. So a test that called a
 * helper twice and asserted one DB round trip would pass whether or not the
 * wrap existed: it would be measuring the stub, not the code.
 *
 * Instead this file substitutes a memoizing `cache` with the semantics React's
 * server build actually has (keyed on the full argument list, by value for
 * primitives) and asserts two things that *are* falsifiable: which exports go
 * through it, and that it keys on arguments rather than collapsing callers.
 * The argument-keying assertions matter most — these are authorization
 * helpers, so a cache that ignored `userId` would be a tenancy bug.
 */

/** Exports we deliberately do NOT wrap, and the reason, asserted below. */
const NOT_CACHED = [
  // Takes object arguments (`{ id }`, `{ teamId }`). React `cache()` keys on
  // referential identity for non-primitives, so fresh object literals at the
  // call site would miss every time and only grow the cache.
  'resolveAccountTeamIds',
  // Take a NextRequest — never referentially equal between calls.
  'getRequestPrincipal',
  'requireSessionUser',
  // Pure delegate to the cached getCurrentUser; wrapping adds a second cache
  // for zero additional dedupe.
  'requireUser',
] as const;

/**
 * Every store handed out by the `cache` stub below. React's real cache lives
 * for one request; each `it` here stands in for one request, so `beforeEach`
 * clears them all. Without that, an earlier test's memo makes a later test's
 * "first" call free and the assertions measure nothing.
 */
const stores: Array<Map<string, unknown>> = [];
const resetRequestCaches = () => stores.forEach(s => s.clear());

mock.module('react', () => ({
  cache: (fn: (...args: any[]) => any) => {
    const store = new Map<string, any>();
    stores.push(store);
    const memoized = (...args: any[]) => {
      const key = JSON.stringify(args.map(a => (a && typeof a === 'object' ? { __ref: true } : a)));
      if (!store.has(key)) store.set(key, fn(...args));
      return store.get(key);
    };
    // Tag so the structural assertions below can tell wrapped from unwrapped.
    (memoized as any).__isRequestCached = true;
    return memoized;
  },
}));

const calls: Record<string, number> = {};
const bump = (name: string) => {
  calls[name] = (calls[name] ?? 0) + 1;
};

let usersRow: any = { id: 'u-1', email: 'a@example.test', name: 'A', image: null, timezone: null };
let teamsRow: any = { id: 'team-personal', slug: 'personal-u-1' };
let teamMembersRows: any[] = [{ teamId: 'team-shared' }];
let workspacesRows: any[] = [{ id: 'ws-1' }];
let workspaceRow: any = { teamId: 'team-shared', accessMode: 'closed' };
let membershipRow: any = { role: 'member' };
let linkRow: any = { canClaim: true, canCreate: true };

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      users: { findFirst: async () => (bump('users.findFirst'), usersRow) },
      teams: { findFirst: async () => (bump('teams.findFirst'), teamsRow) },
      teamMembers: {
        findFirst: async () => (bump('teamMembers.findFirst'), membershipRow),
        findMany: async () => (bump('teamMembers.findMany'), teamMembersRows),
      },
      workspaces: {
        findFirst: async () => (bump('workspaces.findFirst'), workspaceRow),
        findMany: async () => (bump('workspaces.findMany'), workspacesRows),
      },
      accountWorkspaces: { findFirst: async () => (bump('accountWorkspaces.findFirst'), linkRow) },
    },
    selectDistinct: () => ({
      from: () => ({ where: async () => (bump('selectDistinct'), workspacesRows) }),
    }),
    select: () => ({
      from: () => ({ where: () => ({ groupBy: async () => (bump('select'), []) }) }),
    }),
  },
}));

mock.module('@/auth', () => ({ auth: async () => ({ user: { id: 'u-1' } }) }));
mock.module('@/lib/api-auth', () => ({ authenticateApiKey: async () => null }));

const teamAccess: any = await import('./team-access');
const authHelpers: any = await import('./auth-helpers');

/** name → [invocation that should dedupe, a differing invocation] */
const CACHED_HELPERS: Array<[string, any, () => Promise<unknown>, () => Promise<unknown>]> = [
  ['getCurrentUser', authHelpers.getCurrentUser, () => authHelpers.getCurrentUser(), () => authHelpers.getCurrentUser()],
  ['getUserWorkspaceIds', teamAccess.getUserWorkspaceIds, () => teamAccess.getUserWorkspaceIds('u-1'), () => teamAccess.getUserWorkspaceIds('u-2')],
  ['getUserTeamIds', teamAccess.getUserTeamIds, () => teamAccess.getUserTeamIds('u-1'), () => teamAccess.getUserTeamIds('u-2')],
  ['getUserDefaultTeamId', teamAccess.getUserDefaultTeamId, () => teamAccess.getUserDefaultTeamId('u-1'), () => teamAccess.getUserDefaultTeamId('u-2')],
  ['getTeamWorkspaceIds', teamAccess.getTeamWorkspaceIds, () => teamAccess.getTeamWorkspaceIds('t-1'), () => teamAccess.getTeamWorkspaceIds('t-2')],
  ['resolveActiveTeamId', teamAccess.resolveActiveTeamId, () => teamAccess.resolveActiveTeamId('u-1', 'team-shared'), () => teamAccess.resolveActiveTeamId('u-2', 'team-shared')],
  ['verifyWorkspaceAccess', teamAccess.verifyWorkspaceAccess, () => teamAccess.verifyWorkspaceAccess('u-1', 'ws-1'), () => teamAccess.verifyWorkspaceAccess('u-2', 'ws-1')],
  ['verifyAccountWorkspaceAccess', teamAccess.verifyAccountWorkspaceAccess, () => teamAccess.verifyAccountWorkspaceAccess('acct-1', 'ws-1'), () => teamAccess.verifyAccountWorkspaceAccess('acct-2', 'ws-1')],
];

describe('per-request memoization of the auth/scope helpers', () => {
  beforeEach(() => {
    for (const k of Object.keys(calls)) delete calls[k];
    resetRequestCaches();
  });

  it('already memoizes getUserTeamsWithDetails (the in-repo precedent this extends)', () => {
    expect((teamAccess.getUserTeamsWithDetails as any).__isRequestCached).toBe(true);
  });

  for (const [name, fn] of CACHED_HELPERS) {
    it(`wraps ${name} in React cache()`, () => {
      expect(fn).toBeDefined();
      expect((fn as any).__isRequestCached).toBe(true);
    });
  }

  for (const [name, , sameArgs] of CACHED_HELPERS) {
    it(`${name} issues no further DB round trips when called again with the same arguments`, async () => {
      await sameArgs();
      const afterFirst = Object.values(calls).reduce((a, b) => a + b, 0);
      expect(afterFirst).toBeGreaterThan(0);
      await sameArgs();
      await sameArgs();
      expect(Object.values(calls).reduce((a, b) => a + b, 0)).toBe(afterFirst);
    });
  }

  for (const [name, , sameArgs, otherArgs] of CACHED_HELPERS) {
    if (name === 'getCurrentUser') continue; // zero-arg by construction
    it(`${name} does NOT serve a cached answer to a different caller`, async () => {
      await sameArgs();
      const afterFirst = Object.values(calls).reduce((a, b) => a + b, 0);
      await otherArgs();
      expect(Object.values(calls).reduce((a, b) => a + b, 0)).toBeGreaterThan(afterFirst);
    });
  }

  for (const name of NOT_CACHED) {
    it(`leaves ${name} uncached`, () => {
      const fn = teamAccess[name] ?? authHelpers[name];
      expect(fn).toBeTypeOf('function');
      expect((fn as any).__isRequestCached).toBeUndefined();
    });
  }
});
