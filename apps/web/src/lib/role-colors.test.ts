import { describe, expect, it } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import { teamRolesWhere } from './role-colors';

// Regression: the list read roles only through a workspace join, so a team
// whose roles are team-level (workspaceId NULL, the default shape) drew every
// live-agent dot in the fallback colour.
describe('teamRolesWhere', () => {
  const { sql, params } = new PgDialect().sqlToQuery(teamRolesWhere('team-1')!);

  it('reads team-level roles as well as workspace-scoped ones', () => {
    expect(sql).toContain('"workspaces"."team_id" = $1');
    expect(sql).toContain('"workspace_skills"."workspace_id" is null');
    expect(sql).toContain('"workspace_skills"."team_id" = $2');
    expect(params.slice(0, 2)).toEqual(['team-1', 'team-1']);
  });

  it('only enabled roles', () => {
    expect(sql).toContain('"workspace_skills"."is_role" = $3');
    expect(sql).toContain('"workspace_skills"."enabled" = $4');
  });
});
