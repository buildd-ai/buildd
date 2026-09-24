import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { QueryBuilder } from 'drizzle-orm/pg-core';

// The db is only touched by getWorkspaceErrorTraceRollup. The query SHAPE is
// tested by rendering the real builder through a db-less QueryBuilder, so the
// workspace scoping predicate is observable rather than hidden behind a mock.
const mockRows = mock(() => Promise.resolve([] as any[]));
const chain: any = {
  from: () => chain,
  innerJoin: () => chain,
  where: () => chain,
  groupBy: () => chain,
  orderBy: () => chain,
  limit: () => mockRows(),
};
mock.module('@buildd/core/db', () => ({ db: { select: () => chain } }));

import {
  buildWorkspaceErrorTraceRollupQuery,
  getWorkspaceErrorTraceRollup,
  parseRollupParams,
  ROLLUP_DEFAULT_WINDOW_MS,
  ROLLUP_MAX_LIMIT,
} from './workspace-error-traces';

const NOW = new Date('2026-08-28T12:00:00.000Z');
const SINCE = new Date('2026-08-21T12:00:00.000Z');

function render(workspaceId = 'ws-1', since = SINCE, limit = 20) {
  const q = buildWorkspaceErrorTraceRollupQuery(new QueryBuilder(), { workspaceId, since, limit }).toSQL();
  return { sql: q.sql.replace(/\s+/g, ' ').toLowerCase(), params: q.params };
}

describe('buildWorkspaceErrorTraceRollupQuery — scoping', () => {
  it('scopes by the worker\'s workspace through an inner join (traces carry no workspace_id)', () => {
    const { sql, params } = render();
    expect(sql).toContain('inner join "workers" on "worker_error_traces"."worker_id" = "workers"."id"');
    expect(sql).toContain('"workers"."workspace_id" = $');
    expect(params).toContain('ws-1');
  });

  it('applies the since window as a lower bound on the trace timestamp', () => {
    const { sql, params } = render();
    expect(sql).toContain('"worker_error_traces"."ts" > $');
    expect(params.some((p) => String(p).startsWith('2026-08-21'))).toBe(true);
  });

  it('binds only the caller-supplied workspace — the WHERE has no OR arm', () => {
    const { sql, params } = render('ws-mine');
    const where = sql.slice(sql.indexOf(' where '), sql.indexOf(' group by '));
    expect(where).not.toContain(' or ');
    expect(params.filter((p) => typeof p === 'string' && p.startsWith('ws-'))).toEqual(['ws-mine']);
  });

  it('aggregates SQL-side: groups by pattern, orders by count then recency, limits', () => {
    const { sql, params } = render('ws-1', SINCE, 7);
    expect(sql).toContain('group by "worker_error_traces"."pattern"');
    expect(sql).toMatch(/order by count\(\*\) desc, max\("worker_error_traces"."ts"\) desc/);
    expect(sql).toContain('limit $');
    expect(params[params.length - 1]).toBe(7);
  });
});

describe('buildWorkspaceErrorTraceRollupQuery — example tasks', () => {
  // `array_agg(distinct …)[1:3]` returned the three lowest-SORTING uuids, so a
  // pattern recurring today could cite tasks from a week ago.
  it('aggregates example task ids newest-first, not in uuid sort order', () => {
    const { sql } = render();
    expect(sql).toMatch(/array_agg\("worker_error_traces"."task_id"::text order by "worker_error_traces"."ts" desc\)/);
    expect(sql).not.toContain('array_agg(distinct "worker_error_traces"."task_id"');
  });
});

describe('parseRollupParams', () => {
  it('defaults to a 7-day window and a limit of 20', () => {
    const p = parseRollupParams(new URLSearchParams(), NOW);
    expect(p.since.getTime()).toBe(NOW.getTime() - ROLLUP_DEFAULT_WINDOW_MS);
    expect(p.limit).toBe(20);
  });

  it('honours a valid since and falls back on an invalid one', () => {
    expect(parseRollupParams(new URLSearchParams({ since: SINCE.toISOString() }), NOW).since).toEqual(SINCE);
    expect(parseRollupParams(new URLSearchParams({ since: 'not-a-date' }), NOW).since.getTime())
      .toBe(NOW.getTime() - ROLLUP_DEFAULT_WINDOW_MS);
  });

  it('clamps limit to [1, max]', () => {
    expect(parseRollupParams(new URLSearchParams({ limit: '0' }), NOW).limit).toBe(1);
    expect(parseRollupParams(new URLSearchParams({ limit: '100000' }), NOW).limit).toBe(ROLLUP_MAX_LIMIT);
    expect(parseRollupParams(new URLSearchParams({ limit: 'abc' }), NOW).limit).toBe(20);
  });
});

describe('getWorkspaceErrorTraceRollup', () => {
  beforeEach(() => mockRows.mockReset());

  it('normalises row shapes (counts as numbers, task ids as an array)', async () => {
    mockRows.mockResolvedValueOnce([
      {
        pattern: 'git_fatal',
        count: '5',
        taskCount: 2,
        firstSeen: new Date('2026-08-22T00:00:00Z'),
        lastSeen: new Date('2026-08-27T00:00:00Z'),
        exampleExcerpt: 'fatal: bad revision',
        exampleSource: 'bash',
        exampleTaskIds: '["t-1","t-2"]',
      },
      {
        pattern: 'oom',
        count: 1,
        taskCount: 0,
        firstSeen: '2026-08-23T00:00:00Z',
        lastSeen: '2026-08-23T00:00:00Z',
        exampleExcerpt: 'Killed',
        exampleSource: null,
        exampleTaskIds: null,
      },
    ]);
    const res = await getWorkspaceErrorTraceRollup({ workspaceId: 'ws-1', since: SINCE, limit: 20 });
    expect(res[0]).toEqual({
      pattern: 'git_fatal',
      count: 5,
      taskCount: 2,
      firstSeen: '2026-08-22T00:00:00.000Z',
      lastSeen: '2026-08-27T00:00:00.000Z',
      exampleExcerpt: 'fatal: bad revision',
      exampleSource: 'bash',
      exampleTaskIds: ['t-1', 't-2'],
    });
    expect(res[1].exampleTaskIds).toEqual([]);
    expect(res[1].firstSeen).toBe('2026-08-23T00:00:00.000Z');
  });

  it('dedupes the newest-first ids and keeps the first three distinct', async () => {
    mockRows.mockResolvedValueOnce([
      {
        pattern: 'p', count: 6, taskCount: 4, firstSeen: SINCE, lastSeen: SINCE,
        exampleExcerpt: 'x', exampleSource: null,
        exampleTaskIds: ['t-new', 't-new', 't-mid', 't-new', 't-old', 't-oldest'],
      },
    ]);
    const res = await getWorkspaceErrorTraceRollup({ workspaceId: 'ws-1', since: SINCE, limit: 20 });
    expect(res[0].exampleTaskIds).toEqual(['t-new', 't-mid', 't-old']);
  });
});
