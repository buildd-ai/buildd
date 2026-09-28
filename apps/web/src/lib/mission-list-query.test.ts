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

  it('recent orders by the lastActivityAt the list prints (task start or latest task update), newest first', () => {
    const [first, second] = missionListOrderBy('recent');
    // Same value the route prints as lastActivityAt; missions with no task
    // activity fall back to updatedAt so they never sort as NULL (first).
    expect(render(first as SQL).sql).toBe(
      'coalesce(greatest("missions"."last_task_started_at", (select max(t.updated_at) from tasks t where t.mission_id = "missions"."id")), "missions"."updated_at") desc',
    );
    expect(render(second as SQL).sql).toBe('"missions"."created_at" desc');
  });

  it('the task subquery uses raw identifiers (the relational builder re-aliases every column to the root table)', () => {
    const [first] = missionListOrderBy('recent');
    expect(render(first as SQL).sql).not.toContain('"tasks"."');
  });

  it('with q, an exact (case-insensitive) title match ranks first, before the sort', () => {
    const [exact, activity] = missionListOrderBy('recent', 'Memory');
    const q = render(exact as SQL);
    expect(q.sql).toBe('lower("missions"."title") = lower($1) desc');
    expect(q.params).toEqual(['Memory']);
    expect(render(activity as SQL).sql).toStartWith('coalesce(greatest(');
    const [pExact, pFirst] = missionListOrderBy('priority', ' Memory ');
    expect(render(pExact as SQL).params).toEqual(['Memory']);
    expect(render(pFirst as SQL).sql).toBe('"missions"."priority" desc');
  });

  it('blank q adds no exact-match ranking', () => {
    expect(missionListOrderBy('recent', '  ')).toHaveLength(2);
  });

  it('parseMissionListSort accepts only "recent"', () => {
    expect(parseMissionListSort('recent')).toBe('recent');
    expect(parseMissionListSort(null)).toBe('priority');
    expect(parseMissionListSort('bogus')).toBe('priority');
  });
});
