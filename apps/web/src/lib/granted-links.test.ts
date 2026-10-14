/**
 * The live re-check on a person-granted account_workspaces row (spec "One
 * runner for every team you run", R-3), rendered to SQL.
 *
 * A mocked `db` makes a WHERE clause unobservable, so these pin the predicate
 * itself: which columns join to which, and what makes a grant still hold. A
 * wrong join (team to workspace id), a dropped membership check, or a role
 * list that lets a member keep a restricted workspace each fail here. The
 * same predicate runs against real rows in apps/web/tests/db/runner-picks-reach.test.ts.
 */
import { describe, expect, it, mock } from 'bun:test';
import { PgDialect, QueryBuilder, alias } from 'drizzle-orm/pg-core';

mock.module('@buildd/core/db', () => ({ db: new QueryBuilder() }));

const { accountWorkspaces } = await import('@buildd/core/db/schema');
const { sqlWhere } = await import('@buildd/core/db/relational-sql');
const { grantedLinkStillValid, liveGrantedLinksQuery, liveLinkCondition } = await import('./granted-links');

const dialect = new PgDialect();
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
const render = (expr: Parameters<PgDialect['sqlToQuery']>[0]) => norm(dialect.sqlToQuery(expr).sql);

describe('grantedLinkStillValid', () => {
  const text = render(grantedLinkStillValid());

  it("joins the granting person's membership to the workspace's own team", () => {
    expect(text).toContain('from "workspaces" "gw" inner join "team_members" "gm" on "gm"."team_id" = "gw"."team_id"');
  });

  it('matches the row\'s workspace and the person who granted it', () => {
    expect(text).toContain('"gw"."id" = "account_workspaces"."workspace_id"');
    expect(text).toContain('"gm"."user_id" = "account_workspaces"."granted_by_user_id"');
  });

  it('never holds once a team admin removed it', () => {
    expect(text).toMatch(/^\("account_workspaces"\."removed_by_user_id" is null and exists /);
  });

  it('holds for an open workspace at any role, a restricted one only for owners and admins', () => {
    expect(text).toContain(`("gw"."access_mode" = 'open' or "gm"."role" in ('owner', 'admin'))`);
    expect(text).not.toContain("'member'");
  });
});

describe('liveLinkCondition', () => {
  it('leaves an unmarked row as it was and re-checks a granted one', () => {
    const text = render(liveLinkCondition());
    expect(text).toMatch(/^\("account_workspaces"\."granted_by_user_id" is null or \("account_workspaces"\."removed_by_user_id" is null and exists \(select 1 /);
  });

  it('re-points the row columns at the alias inside a relational query, not the subquery tables', () => {
    const d0 = alias(accountWorkspaces, 'd0');
    const raw = sqlWhere(liveLinkCondition())!.RAW(d0, {});
    const text = render(raw);
    expect(text).toContain('"d0"."granted_by_user_id" is null');
    expect(text).toContain('"gw"."id" = "d0"."workspace_id"');
    expect(text).toContain('"gm"."user_id" = "d0"."granted_by_user_id"');
    expect(text).not.toContain('"account_workspaces".');
  });
});

describe('liveGrantedLinksQuery', () => {
  it("reads only this account's granted rows that still hold", () => {
    const q = liveGrantedLinksQuery('acct-1').toSQL();
    const text = norm(q.sql);
    expect(text).toContain('from "account_workspaces"');
    expect(text).toContain('"account_workspaces"."account_id" = $1');
    expect(text).toContain('"account_workspaces"."granted_by_user_id" is not null');
    expect(text).toContain('exists (select 1 from "workspaces" "gw"');
    expect(q.params).toEqual(['acct-1']);
  });
});
