/**
 * loadMissionCarryingReleaseId: the release that carries THIS mission's work,
 * found through `release_tasks` attribution — never the workspace's latest
 * release, which may have shipped after the mission and contain none of it.
 *
 * The WHERE and ORDER BY are rendered through PgDialect so the scoping is
 * observable; a mocked `db` otherwise hides every predicate.
 */
process.env.NODE_ENV = 'test';

import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';

let result: any[] = [];
const calls: { joins: any[]; where: any; orderBy: any[]; limit: number | null } = {
  joins: [],
  where: null,
  orderBy: [],
  limit: null,
};

function chain() {
  const obj: any = {
    from: () => obj,
    innerJoin: (_t: any, on: any) => {
      calls.joins.push(on);
      return obj;
    },
    where: (w: any) => {
      calls.where = w;
      return obj;
    },
    orderBy: (...o: any[]) => {
      calls.orderBy = o;
      return obj;
    },
    limit: (n: number) => {
      calls.limit = n;
      return obj;
    },
    then: (resolve: any) => resolve(result),
  };
  return obj;
}

mock.module('@buildd/core/db', () => ({ db: { select: () => chain() } }));

const { loadMissionCarryingReleaseId } = await import('./mission-carrying-release');

const dialect = new PgDialect();
const render = (w: any) => dialect.sqlToQuery(w);

beforeEach(() => {
  result = [];
  calls.joins = [];
  calls.where = null;
  calls.orderBy = [];
  calls.limit = null;
});

describe('loadMissionCarryingReleaseId', () => {
  it('returns the newest release attributed to one of this mission\'s tasks', async () => {
    result = [{ id: 'rel-carrying' }];
    expect(await loadMissionCarryingReleaseId('mission-a')).toBe('rel-carrying');

    const where = render(calls.where);
    expect(where.sql).toContain('"tasks"."mission_id" = $1');
    expect(where.params).toEqual(['mission-a']);

    // Joined through release_tasks, so only releases that contain the mission's tasks qualify.
    const joins = calls.joins.map(j => render(j).sql).join(' ');
    expect(joins).toContain('"release_tasks"."release_id"');
    expect(joins).toContain('"release_tasks"."task_id"');

    expect(calls.orderBy.map(o => render(o).sql).join(' ')).toMatch(/"releases"\."created_at" desc/);
    expect(calls.limit).toBe(1);
  });

  it('returns null when no release carries any of the mission\'s tasks', async () => {
    result = [];
    expect(await loadMissionCarryingReleaseId('mission-a')).toBeNull();
  });
});
