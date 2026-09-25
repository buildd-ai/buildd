import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';

/**
 * The dedupe lookup's WHERE clause, rendered to SQL.
 *
 * The behavioural tests in `mission-criteria-prose.test.ts` mock drizzle, so the
 * predicate is unobservable there — a lookup that forgot to scope by criterion
 * would still pass them. This file keeps the real schema and drizzle, stubs only
 * `db`, and asserts on the SQL the dialect actually emits.
 */

const findManyArgs: any[] = [];
mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      missions: {
        findFirst: () => Promise.resolve({
          id: 'mission-1', title: 'M', description: null, teamId: 'team-1', workspaceId: 'ws-1',
        }),
      },
      workspaces: { findFirst: () => Promise.resolve({ id: 'ws-1' }) },
      secrets: { findFirst: () => Promise.resolve({ id: 's' }) },
      tasks: {
        findMany: (args: any) => {
          findManyArgs.push(args);
          return Promise.resolve([{
            id: 'open-task', status: 'in_progress', result: null, createdAt: new Date(), updatedAt: new Date(),
            context: { criteriaProseEval: { missionId: 'mission-1', criterionIndex: 2, fingerprint: 'fp' } },
          }]);
        },
      },
    },
    insert: () => { throw new Error('must not insert: an open task exists'); },
  },
}));
mock.module('@/lib/task-dispatch', () => ({ dispatchNewTask: () => Promise.resolve() }));

const { resolveProseCriterion } = await import('./mission-criteria-prose');
const dialect = new PgDialect();

describe('resolveProseCriterion — dedupe lookup scoping', () => {
  beforeEach(() => { findManyArgs.length = 0; });

  it('scopes by mission, then by the marker mission id AND criterion index', async () => {
    const res = await resolveProseCriterion({
      missionId: 'mission-1', criterionIndex: 2, text: 't', fingerprint: 'fp',
      evidence: { deliverables: [], artifacts: [] },
    });
    expect(res.kind).toBe('pending');

    const { sql, params } = dialect.sqlToQuery(findManyArgs[0].where);
    expect(sql).toContain('"tasks"."mission_id" = $1');
    expect(sql).toMatch(/"tasks"\."context" -> 'criteriaProseEval' ->> 'missionId' = \$2/);
    expect(sql).toMatch(/"tasks"\."context" -> 'criteriaProseEval' ->> 'criterionIndex' = \$3/);
    expect(sql).toMatch(/ and /i);
    expect(params).toEqual(['mission-1', 'mission-1', '2']);
  });
});
