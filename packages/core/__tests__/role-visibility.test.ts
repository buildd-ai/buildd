import { describe, it, expect } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  effectiveVisibleRoles,
  isRoleRowVisibleTo,
  personalRoleVisibleSql,
  pickVisibleRoleRow,
  pickVisibleRoleRowLazy,
  roleRowsInScope,
  roleRowsVisibleTo,
  type VisibleRoleRow,
} from '../role-visibility';

const TEAM = 'team-a';
const WS = 'ws-1';
const ALICE = 'user-alice';
const BOB = 'user-bob';

const row = (o: Partial<VisibleRoleRow> & { id: string }): VisibleRoleRow => ({
  slug: 'reviewer', workspaceId: null, teamId: TEAM, ownerUserId: null, visibility: 'team', ...o,
});

const teamDefault = row({ id: 'r-team' });
const override = row({ id: 'r-override', workspaceId: WS });
const otherWsOverride = row({ id: 'r-other-ws', workspaceId: 'ws-2' });
const alicePrivate = row({ id: 'r-alice', ownerUserId: ALICE, visibility: 'private' });
const bobPrivate = row({ id: 'r-bob', ownerUserId: BOB, visibility: 'private' });
const bobShared = row({ id: 'r-bob-shared', ownerUserId: BOB, visibility: 'team' });
const otherTeam = row({ id: 'r-other-team', teamId: 'team-b' });

const ctx = (requesterUserId: string | null) => ({ teamId: TEAM, workspaceId: WS, requesterUserId });

describe('isRoleRowVisibleTo', () => {
  const cases: Array<[string, VisibleRoleRow, string | null, boolean]> = [
    ['team default, no requester', teamDefault, null, true],
    ['workspace override', override, ALICE, true],
    ['another workspace override', otherWsOverride, ALICE, false],
    ['another team', otherTeam, ALICE, false],
    ['private / own', alicePrivate, ALICE, true],
    ['private / other member', alicePrivate, BOB, false],
    ['private / no requester', alicePrivate, null, false],
    ['shared / other member', bobShared, ALICE, true],
    ['shared / no requester', bobShared, null, true],
  ];
  for (const [name, r, requester, expected] of cases) {
    it(name, () => expect(isRoleRowVisibleTo(r, ctx(requester))).toBe(expected));
  }
});

describe('pickVisibleRoleRow precedence', () => {
  it('workspace override beats the requester own personal row', () => {
    expect(pickVisibleRoleRow([alicePrivate, teamDefault, override], 'reviewer', ctx(ALICE))?.id).toBe('r-override');
  });

  it('own personal row beats a shared one and the team default', () => {
    expect(pickVisibleRoleRow([teamDefault, bobShared, alicePrivate], 'reviewer', ctx(ALICE))?.id).toBe('r-alice');
  });

  it('shared personal row beats the team default', () => {
    expect(pickVisibleRoleRow([teamDefault, bobShared], 'reviewer', ctx(ALICE))?.id).toBe('r-bob-shared');
  });

  it("never applies another member's private row", () => {
    expect(pickVisibleRoleRow([bobPrivate, teamDefault], 'reviewer', ctx(ALICE))?.id).toBe('r-team');
    expect(pickVisibleRoleRow([bobPrivate], 'reviewer', ctx(ALICE))).toBeNull();
    expect(pickVisibleRoleRow([bobPrivate], 'reviewer', ctx(null))).toBeNull();
  });

  it('two shared rows from different owners resolve by id, whatever the input order', () => {
    const a = row({ id: 'r-a', ownerUserId: 'u1', visibility: 'team' });
    const b = row({ id: 'r-b', ownerUserId: 'u2', visibility: 'team' });
    expect(pickVisibleRoleRow([b, a], 'reviewer', ctx(null))?.id).toBe('r-a');
    expect(pickVisibleRoleRow([a, b], 'reviewer', ctx(null))?.id).toBe('r-a');
  });

  it('a team default is ignored without a task team', () => {
    expect(pickVisibleRoleRow([teamDefault], 'reviewer', { teamId: null, workspaceId: WS, requesterUserId: null })).toBeNull();
  });
});

describe('effectiveVisibleRoles', () => {
  it('drops other members private roles from the list', () => {
    const other = row({ id: 'r-x', slug: 'bobs-helper', ownerUserId: BOB, visibility: 'private' });
    const mine = row({ id: 'r-y', slug: 'alices-helper', ownerUserId: ALICE, visibility: 'private' });
    const slugs = effectiveVisibleRoles([teamDefault, other, mine, override], ctx(ALICE)).map(r => r.id).sort();
    expect(slugs).toEqual(['r-override', 'r-y']);
  });
});

describe('pickVisibleRoleRowLazy', () => {
  it('does not resolve the requester when no personal row exists for the slug', async () => {
    let calls = 0;
    const r = await pickVisibleRoleRowLazy([teamDefault], 'reviewer', ctx(null), async () => { calls++; return ALICE; });
    expect(r?.id).toBe('r-team');
    expect(calls).toBe(0);
  });

  it('resolves the requester when a personal row is in play', async () => {
    const r = await pickVisibleRoleRowLazy([teamDefault, alicePrivate], 'reviewer', ctx(null), async () => ALICE);
    expect(r?.id).toBe('r-alice');
  });
});

describe('SQL predicate (rendered)', () => {
  const dialect = new PgDialect();
  const render = (q: Parameters<PgDialect['sqlToQuery']>[0]) => dialect.sqlToQuery(q);

  it('with a requester: team row, shared, or owned by the requester', () => {
    const { sql, params } = render(personalRoleVisibleSql(ALICE));
    expect(sql).toBe('("workspace_skills"."owner_user_id" is null or "workspace_skills"."visibility" = $1 or "workspace_skills"."owner_user_id" = $2)');
    expect(params).toEqual(['team', ALICE]);
  });

  it('without a requester: team rows and shared rows only', () => {
    const { sql, params } = render(personalRoleVisibleSql(null));
    expect(sql).toBe('("workspace_skills"."owner_user_id" is null or "workspace_skills"."visibility" = $1)');
    expect(params).toEqual(['team']);
  });

  it('roleRowsVisibleTo scopes to the team, its defaults and this workspace override', () => {
    const { sql, params } = render(roleRowsVisibleTo({ teamId: TEAM, workspaceId: WS, requesterUserId: BOB }));
    expect(sql).toContain('"workspace_skills"."team_id" = $1');
    expect(sql).toContain('("workspace_skills"."workspace_id" is null or "workspace_skills"."workspace_id" = $2)');
    expect(sql).toContain('"workspace_skills"."owner_user_id" = $4');
    expect(params).toEqual([TEAM, WS, 'team', BOB]);
  });

  it('roleRowsInScope is the same scope with no per-person filter (rows must be picked in JS)', () => {
    const { sql, params } = render(roleRowsInScope({ teamId: TEAM, workspaceId: WS }));
    expect(sql).toBe('("workspace_skills"."team_id" = $1 and ("workspace_skills"."workspace_id" is null or "workspace_skills"."workspace_id" = $2))');
    expect(params).toEqual([TEAM, WS]);
  });
});
