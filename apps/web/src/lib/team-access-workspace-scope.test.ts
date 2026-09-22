import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';

/**
 * getUserWorkspaceIds is the authorization scope for every session-authenticated
 * dashboard read, and it used to cost four strictly sequential statements:
 * personal team by slug -> that team's workspaces -> the user's memberships ->
 * those teams' workspaces. neon-http has no pooling, so each was a full HTTP
 * round trip.
 *
 * It is now one statement. Because a wrong answer here is an authorization bug
 * rather than a slow page, these tests assert the *set* returned and -- since a
 * mocked `db` makes every predicate unobservable -- render the WHERE clause
 * through PgDialect and assert both arms of the union are actually in it.
 */

let capturedWhere: unknown = null;
let rows: Array<{ id: string }> = [];
let roundTrips = 0;
/** Anything the old four-statement implementation would have called. */
let legacyCalls = 0;

const legacy = () => {
  legacyCalls++;
  return Promise.resolve([] as any[]);
};

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      teams: { findFirst: legacy },
      teamMembers: { findMany: legacy },
      workspaces: { findMany: legacy, findFirst: legacy },
      accountWorkspaces: { findFirst: legacy },
    },
    selectDistinct: () => ({
      from: () => ({
        where: (w: unknown) => {
          capturedWhere = w;
          roundTrips++;
          return Promise.resolve(rows);
        },
      }),
    }),
  },
}));

const { getUserWorkspaceIds } = await import('./team-access');

const renderWhere = () => new PgDialect().sqlToQuery(capturedWhere as any);

describe('getUserWorkspaceIds', () => {
  beforeEach(() => {
    capturedWhere = null;
    rows = [];
    roundTrips = 0;
    legacyCalls = 0;
  });

  it('resolves the whole scope in a single round trip', async () => {
    rows = [{ id: 'ws-1' }];
    await getUserWorkspaceIds('user-1');
    expect(roundTrips).toBe(1);
    expect(legacyCalls).toBe(0);
  });

  it('returns exactly the set of workspace ids the query yields', async () => {
    rows = [{ id: 'ws-b' }, { id: 'ws-a' }, { id: 'ws-c' }];
    const result = await getUserWorkspaceIds('user-1');
    expect(new Set(result)).toEqual(new Set(['ws-a', 'ws-b', 'ws-c']));
    expect(result).toHaveLength(3);
  });

  it('deduplicates a workspace reachable through both the personal team and a membership', async () => {
    // One statement with two OR'd subqueries can still return a row twice if
    // SELECT DISTINCT were dropped, so the set contract is enforced in JS too.
    rows = [{ id: 'ws-shared' }, { id: 'ws-shared' }, { id: 'ws-other' }];
    const result = await getUserWorkspaceIds('user-1');
    expect(new Set(result)).toEqual(new Set(['ws-shared', 'ws-other']));
    expect(result).toHaveLength(2);
  });

  it('returns an empty array when the user can reach no workspace', async () => {
    rows = [];
    expect(await getUserWorkspaceIds('user-1')).toEqual([]);
  });

  it('keeps both arms of the scope: personal team by slug OR team membership', async () => {
    await getUserWorkspaceIds('user-1');
    const { sql } = renderWhere();
    const normalized = sql.replace(/\s+/g, ' ').toLowerCase();

    // Arm 1 — the personal-team fallback for users with no team_members row.
    expect(normalized).toContain('"teams"."slug"');
    expect(normalized).toContain('from "teams"');
    // Arm 2 — real team memberships.
    expect(normalized).toContain('"team_members"."user_id"');
    expect(normalized).toContain('from "team_members"');
    // Union, not intersection: dropping either arm silently narrows or widens
    // what the viewer may see.
    expect(normalized).toContain(' or ');
    expect(normalized).not.toContain(' and ');
    // Both arms constrain the same column on the outer table.
    expect(normalized.match(/"workspaces"\."team_id" in \(select/g)).toHaveLength(2);
  });

  it('passes the user id as a bound parameter, never interpolated into the SQL', async () => {
    await getUserWorkspaceIds("user-1' or true --");
    const { sql, params } = renderWhere();
    expect(sql).not.toContain('user-1');
    expect(params).toContain("user-1' or true --");
    expect(params).toContain("personal-user-1' or true --");
  });

  it('scopes the personal-team arm to this user only', async () => {
    await getUserWorkspaceIds('user-1');
    const { params } = renderWhere();
    // The slug convention is `personal-{userId}` — see getUserDefaultTeamId.
    expect(params).toContain('personal-user-1');
    expect(params).not.toContain('personal-user-2');
  });
});
