/**
 * GET /api/missions filter + ordering, asserted on the SQL drizzle renders
 * (a mocked db would make every predicate unobservable).
 */
import { describe, expect, it } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { buildMissionListWhere, missionListOrderBy, parseMissionListSort, escapeLike } from './mission-list-query';

const dialect = new PgDialect();
const render = (s: SQL | undefined) => dialect.sqlToQuery(s!);

describe('buildMissionListWhere', () => {
  it('always scopes to the caller teams', () => {
    const q = render(buildMissionListWhere({ teamIds: ['t1', 't2'] }));
    expect(q.sql).toBe('"missions"."team_id" in ($1, $2)');
    expect(q.params).toEqual(['t1', 't2']);
  });

  it('q is a case-insensitive title substring, AND-ed with the team scope', () => {
    const q = render(buildMissionListWhere({ teamIds: ['t1'], q: 'Memory done' }));
    expect(q.sql).toBe('("missions"."team_id" in ($1) and "missions"."title" ilike $2)');
    expect(q.params).toEqual(['t1', '%Memory done%']);
  });

  it('q escapes LIKE wildcards so "100%" is literal', () => {
    const q = render(buildMissionListWhere({ teamIds: ['t1'], q: '100%_x\\' }));
    expect(q.params[1]).toBe('%100\\%\\_x\\\\%');
    expect(escapeLike('a_b')).toBe('a\\_b');
  });

  it('blank q adds no predicate', () => {
    const q = render(buildMissionListWhere({ teamIds: ['t1'], q: '   ' }));
    expect(q.sql).not.toContain('ilike');
  });

  it('status=open excludes completed and archived; other statuses match exactly', () => {
    const open = render(buildMissionListWhere({ teamIds: ['t1'], status: 'open' }));
    expect(open.sql).toContain('"missions"."status" not in ($2, $3)');
    expect(open.params).toEqual(['t1', 'completed', 'archived']);
    const done = render(buildMissionListWhere({ teamIds: ['t1'], status: 'completed' }));
    expect(done.sql).toContain('"missions"."status" = $2');
  });

  it('workspaceId and q combine with the team scope', () => {
    const q = render(buildMissionListWhere({ teamIds: ['t1'], workspaceId: 'w1', q: 'chat' }));
    expect(q.sql).toBe('("missions"."team_id" in ($1) and "missions"."workspace_id" = $2 and "missions"."title" ilike $3)');
    expect(q.params).toEqual(['t1', 'w1', '%chat%']);
  });
});

describe('missionListOrderBy', () => {
  it('default keeps the dashboard order: priority first', () => {
    const [first] = missionListOrderBy('priority');
    expect(render(first as SQL).sql).toBe('"missions"."priority" desc');
  });

  it('recent orders by latest activity (task start or update), newest first', () => {
    const [first, second] = missionListOrderBy('recent');
    expect(render(first as SQL).sql).toBe('greatest("missions"."last_task_started_at", "missions"."updated_at") desc');
    expect(render(second as SQL).sql).toBe('"missions"."created_at" desc');
  });

  it('parseMissionListSort accepts only "recent"', () => {
    expect(parseMissionListSort('recent')).toBe('recent');
    expect(parseMissionListSort(null)).toBe('priority');
    expect(parseMissionListSort('bogus')).toBe('priority');
  });
});
