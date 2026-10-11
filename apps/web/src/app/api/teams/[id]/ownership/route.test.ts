/**
 * POST /api/teams/[id]/ownership — an owner hands ownership to an existing
 * member: the target becomes owner, the caller becomes admin.
 *
 * The db mock records the batch it is handed, so a test asserts which writes
 * were sent and in what order (promote before demote), not just a status.
 */
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const TEAM = '11111111-1111-4111-8111-111111111111';
const TARGET = '22222222-2222-4222-8222-222222222222';
const STRANGER = '33333333-3333-4333-8333-333333333333';

let memberships: Record<string, { role: string } | undefined> = {};
let team: { slug: string } | undefined;
let batches: Array<Array<{ set: any; where: any }>> = [];
// What each statement in the batch returns (rows it updated).
let batchResult: unknown[][] = [];

mock.module('@/lib/auth-helpers', () => ({
  requireSessionUser: async () => ({ user: { id: 'caller' } }),
}));

mock.module('drizzle-orm', () => ({
  eq: (a: any, b: any) => ({ type: 'eq', a, b }),
  ne: (a: any, b: any) => ({ type: 'ne', a, b }),
  and: (...args: any[]) => ({ type: 'and', args }),
  sql: (strings: TemplateStringsArray, ...values: any[]) => ({ type: 'sql', strings: [...strings], values }),
}));

mock.module('@buildd/core/db/schema', () => ({
  teams: { id: 'teams.id', slug: 'teams.slug', permissionOverrides: 'teams.permission_overrides' },
  teamMembers: { teamId: 'teamMembers.teamId', userId: 'teamMembers.userId', role: 'teamMembers.role' },
}));

function userIdIn(where: any): string | undefined {
  return where?.args?.find((c: any) => c.a === 'teamMembers.userId')?.b;
}

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      teams: { findFirst: async () => team },
      teamMembers: {
        findFirst: async (q: any) => {
          const userId = userIdIn(q.where);
          const m = userId ? memberships[userId] : undefined;
          return m ? { teamId: TEAM, userId, ...m } : undefined;
        },
      },
    },
    update: () => ({
      set: (set: any) => ({ where: (where: any) => ({ returning: () => ({ set, where }) }) }),
    }),
    batch: async (statements: Array<{ set: any; where: any }>) => {
      batches.push(statements);
      return batchResult;
    },
  },
}));

const clamps: Array<{ teamId: string; userId: string; role: string | null }> = [];
let clampResult = 0;
mock.module('@/lib/creator-key-clamp', () => ({
  clampCreatorKeys: async (opts: { teamId: string; userId: string; role: string | null }) => {
    clamps.push({ teamId: opts.teamId, userId: opts.userId, role: opts.role });
    return clampResult;
  },
}));

import { POST } from './route';

function transfer(body: unknown) {
  return POST(
    new NextRequest(`http://localhost:3000/api/teams/${TEAM}/ownership`, {
      method: 'POST',
      headers: new Headers({ 'content-type': 'application/json' }),
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: TEAM }) },
  );
}

beforeEach(() => {
  memberships = {};
  team = { slug: 'acme' };
  batches = [];
  batchResult = [[{ userId: TARGET }], [{ userId: 'caller' }]];
  clamps.length = 0;
  clampResult = 0;
});

describe('POST /api/teams/[id]/ownership', () => {
  it('promotes the target to owner, then demotes the caller to admin, in one batch', async () => {
    memberships.caller = { role: 'owner' };
    memberships[TARGET] = { role: 'member' };
    const res = await transfer({ userId: TARGET });
    expect(res.status).toBe(200);
    expect(batches).toHaveLength(1);
    const [promote, demote] = batches[0];
    expect(promote.set).toEqual({ role: 'owner' });
    expect(userIdIn(promote.where)).toBe(TARGET);
    expect(demote.set).toEqual({ role: 'admin' });
    expect(userIdIn(demote.where)).toBe('caller');
  });

  it('only demotes the caller once the target really is an owner', async () => {
    memberships.caller = { role: 'owner' };
    memberships[TARGET] = { role: 'admin' };
    await transfer({ userId: TARGET });
    const [, demote] = batches[0];
    // The guard is a subquery in the same statement, so it sees the promote.
    const guard = demote.where.args.find((c: any) => c.type === 'sql');
    expect(guard).toBeDefined();
    expect(guard.values).toContain(TARGET);
  });

  it('clamps the demoted caller\'s keys to admin and reports the count', async () => {
    memberships.caller = { role: 'owner' };
    memberships[TARGET] = { role: 'member' };
    clampResult = 1;
    const res = await transfer({ userId: TARGET });
    expect(await res.json()).toEqual({ success: true, clampedKeys: 1 });
    expect(clamps).toEqual([{ teamId: TEAM, userId: 'caller', role: 'admin' }]);
  });

  it('does not clamp when the demote matched nothing', async () => {
    memberships.caller = { role: 'owner' };
    memberships[TARGET] = { role: 'member' };
    batchResult = [[{ userId: TARGET }], []];
    const res = await transfer({ userId: TARGET });
    expect(await res.json()).toEqual({ success: true, clampedKeys: 0 });
    expect(clamps).toHaveLength(0);
  });

  it('409s and reports nothing changed when the target left mid-request', async () => {
    memberships.caller = { role: 'owner' };
    memberships[TARGET] = { role: 'member' };
    batchResult = [[], []];
    const res = await transfer({ userId: TARGET });
    expect(res.status).toBe(409);
    expect(clamps).toHaveLength(0);
  });

  it('403s an admin, and writes nothing', async () => {
    memberships.caller = { role: 'admin' };
    memberships[TARGET] = { role: 'member' };
    const res = await transfer({ userId: TARGET });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toContain('assign_team_owner');
    expect(batches).toHaveLength(0);
  });

  it('403s a non-member', async () => {
    memberships[TARGET] = { role: 'member' };
    expect((await transfer({ userId: TARGET })).status).toBe(403);
    expect(batches).toHaveLength(0);
  });

  it('404s a target who is not a member', async () => {
    memberships.caller = { role: 'owner' };
    expect((await transfer({ userId: STRANGER })).status).toBe(404);
    expect(batches).toHaveLength(0);
  });

  it('400s a transfer to yourself', async () => {
    memberships.caller = { role: 'owner' };
    expect((await transfer({ userId: 'caller' })).status).toBe(400);
    expect(batches).toHaveLength(0);
  });

  it('400s a target who is already an owner', async () => {
    memberships.caller = { role: 'owner' };
    memberships[TARGET] = { role: 'owner' };
    expect((await transfer({ userId: TARGET })).status).toBe(400);
    expect(batches).toHaveLength(0);
  });

  it('400s without a userId', async () => {
    memberships.caller = { role: 'owner' };
    expect((await transfer({})).status).toBe(400);
    expect(batches).toHaveLength(0);
  });

  it('400s on a personal team', async () => {
    team = { slug: 'personal-caller' };
    memberships.caller = { role: 'owner' };
    memberships[TARGET] = { role: 'member' };
    expect((await transfer({ userId: TARGET })).status).toBe(400);
    expect(batches).toHaveLength(0);
  });
});
