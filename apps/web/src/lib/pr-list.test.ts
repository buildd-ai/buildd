import { describe, expect, it } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import { buildPrListWhere, parsePrListState, shapePrRows, type PrListRow } from './pr-list';

/** WHERE clauses rendered through PgDialect, so their shape is observable. */
const dialect = new PgDialect();
const render = (opts: Parameters<typeof buildPrListWhere>[0]) => {
  const q = dialect.sqlToQuery(buildPrListWhere(opts));
  return { sql: q.sql, params: q.params };
};

describe('parsePrListState', () => {
  it('defaults to open', () => {
    expect(parsePrListState(null)).toEqual({ state: 'open' });
    expect(parsePrListState('')).toEqual({ state: 'open' });
  });

  it('takes the known states', () => {
    for (const s of ['open', 'attention', 'conflict', 'ci_failed', 'merged'] as const) expect(parsePrListState(s)).toEqual({ state: s });
  });

  it('refuses closed: the list is for work in flight, never the pile of abandoned PRs', () => {
    const r = parsePrListState('closed');
    expect('error' in r && r.error).toContain('get_pr');
  });

  it('refuses anything else with the valid values', () => {
    const r = parsePrListState('mergeable');
    expect('error' in r && r.error).toContain('attention');
  });
});

describe('buildPrListWhere', () => {
  const ws = ['ws-a', 'ws-b'];

  it('always scopes to the given workspaces and to rows with a PR', () => {
    const q = render({ workspaceIds: ws, state: 'open' });
    expect(q.sql).toContain('"workers"."workspace_id" in');
    expect(q.params).toEqual(expect.arrayContaining(ws));
    expect(q.sql).toContain('"workers"."pr_url" is not null');
  });

  it('open: unmerged and not closed or unresolvable', () => {
    const q = render({ workspaceIds: ws, state: 'open' });
    expect(q.sql).toContain('"workers"."merged_at" is null');
    expect(q.sql).toContain('not in');
    expect(q.params).toEqual(expect.arrayContaining(['merged', 'closed', 'unresolvable']));
  });

  it('attention: conflicts and red CI only', () => {
    const q = render({ workspaceIds: ws, state: 'attention' });
    expect(q.params).toEqual(expect.arrayContaining(['conflict', 'ci_failed']));
    expect(q.params).not.toContain('closed');
  });

  it('conflict and ci_failed narrow to that one status', () => {
    expect(render({ workspaceIds: ws, state: 'conflict' }).params).toContain('conflict');
    expect(render({ workspaceIds: ws, state: 'ci_failed' }).params).toContain('ci_failed');
  });

  it('merged: merged within the window, never closed ones', () => {
    const since = new Date('2026-09-01T00:00:00Z');
    const q = render({ workspaceIds: ws, state: 'merged', since });
    expect(q.sql).toContain('"workers"."merged_at" >=');
    expect(q.params).not.toContain('closed');
  });
});

const row = (over: Partial<PrListRow>): PrListRow => ({
  workerId: 'w', prNumber: 1, prUrl: 'https://github.com/o/r/pull/1', status: 'pr_open', mergedAt: null,
  lastCheckedAt: null, conflictDetectedAt: null, startedAt: new Date('2026-09-20T00:00:00Z'),
  workspaceId: 'ws-a', workspaceName: 'a', taskId: 't', taskTitle: 'T', missionId: null, missionTitle: null,
  ...over,
});

describe('shapePrRows', () => {
  it('one row per PR: the most recently checked worker says its state', () => {
    const out = shapePrRows([
      row({ workerId: 'old', status: 'ci_failed', lastCheckedAt: new Date('2026-09-20T00:00:00Z') }),
      row({ workerId: 'new', status: 'ci_running', lastCheckedAt: new Date('2026-09-21T00:00:00Z') }),
    ], 'open');
    expect(out.map(r => [r.workerId, r.status])).toEqual([['new', 'ci_running']]);
  });

  it('a PR any of whose workers saw it merge is merged, not open', () => {
    const rows = [
      row({ workerId: 'stale', status: 'ci_failed', lastCheckedAt: new Date('2026-09-25T00:00:00Z') }),
      row({ workerId: 'done', status: 'merged', mergedAt: new Date('2026-09-22T00:00:00Z') }),
    ];
    expect(shapePrRows(rows, 'open')).toEqual([]);
    expect(shapePrRows(rows, 'attention')).toEqual([]);
    expect(shapePrRows(rows, 'merged').map(r => r.status)).toEqual(['merged']);
  });

  it('a closed PR is never listed', () => {
    const rows = [row({ status: 'conflict' }), row({ workerId: 'c', status: 'closed' })];
    for (const s of ['open', 'attention', 'conflict', 'merged'] as const) expect(shapePrRows(rows, s)).toEqual([]);
  });

  it('attention keeps conflicts and red CI only', () => {
    const out = shapePrRows([
      row({ prUrl: 'u1', status: 'ci_running' }), row({ prUrl: 'u2', status: 'ci_failed' }), row({ prUrl: 'u3', status: 'conflict' }),
    ], 'attention');
    expect(out.map(r => r.prUrl)).toEqual(['u3', 'u2']);
  });

  it('open: conflicts first, then red CI, then the rest by recency', () => {
    const out = shapePrRows([
      row({ prUrl: 'u1', status: 'ci_running', startedAt: new Date('2026-09-25T00:00:00Z') }),
      row({ prUrl: 'u2', status: 'ci_failed' }),
      row({ prUrl: 'u3', status: 'conflict' }),
      row({ prUrl: 'u4', status: 'pr_open', startedAt: new Date('2026-09-26T00:00:00Z') }),
    ], 'open');
    expect(out.map(r => r.prUrl)).toEqual(['u3', 'u2', 'u4', 'u1']);
  });

  it('merged: newest merge first', () => {
    const out = shapePrRows([
      row({ prUrl: 'u1', status: 'merged', mergedAt: new Date('2026-09-20T00:00:00Z') }),
      row({ prUrl: 'u2', status: 'merged', mergedAt: new Date('2026-09-22T00:00:00Z') }),
    ], 'merged');
    expect(out.map(r => r.prUrl)).toEqual(['u2', 'u1']);
  });
});
