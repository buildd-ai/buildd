import { describe, expect, it } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import { buildPrListWhere, needsAttention, parsePrListState, prSignals, rankPrs, shapePrRows, waitingReason, type PrListRow } from './pr-list';

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

  it('attention reads every open PR: waiting-on-you is decided after the query', () => {
    expect(render({ workspaceIds: ws, state: 'attention' })).toEqual(render({ workspaceIds: ws, state: 'open' }));
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
  workspaceId: 'ws-a', workspaceName: 'a', taskId: 't', taskTitle: 'T', missionId: null, missionTitle: null, baseRef: null, missionWorkingBranch: null, missionIntegration: null,
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

  it('attention keeps every open PR in order; needsAttention narrows it once signals are in', () => {
    const out = shapePrRows([
      row({ prUrl: 'u1', status: 'ci_running' }), row({ prUrl: 'u2', status: 'ci_failed' }), row({ prUrl: 'u3', status: 'conflict' }),
    ], 'attention');
    expect(out.map(r => r.prUrl)).toEqual(['u3', 'u2', 'u1']);
    expect(out.filter(needsAttention).map(r => r.prUrl)).toEqual(['u3', 'u2']);
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

describe('shapePrRows keeps every worker id of a PR', () => {
  // A reviewer escalation can sit on another worker's task than the latest.
  it('so the attention lookup sees all of them', () => {
    const out = shapePrRows([row({ workerId: 'a' }), row({ workerId: 'b', lastCheckedAt: new Date('2026-09-28T00:00:00Z') })], 'open');
    expect(out[0].workerIds.sort()).toEqual(['a', 'b']);
  });
});

describe('prSignals', () => {
  const noAttention = { inbox: new Map<string, string>(), reviewing: new Set<string>(), conflictFix: new Set<string>(), ciFix: new Set<string>(), ciFixAttempts: new Map<string, number>() };
  const now = new Date('2026-09-28T12:00:00Z');

  it('a quiet PR carries nothing', () => {
    expect(prSignals(shapePrRows([row({ lastCheckedAt: now })], 'open')[0], noAttention, now)).toEqual({});
  });

  it('waiting on you names why, from any worker of the PR', () => {
    const r = shapePrRows([row({ workerId: 'a' }), row({ workerId: 'b' })], 'open')[0];
    const s = prSignals(r, { ...noAttention, inbox: new Map([['a', 'reviewer escalated']]) }, now);
    expect(s.waitingOnYou).toBe('reviewer escalated');
  });

  it('an agent already on it: conflict fix, CI fix, or review', () => {
    const r = shapePrRows([row({ workerId: 'a', status: 'ci_failed' })], 'open')[0];
    const key = 'ws-a:1';
    expect(prSignals(r, { ...noAttention, ciFix: new Set([key]) }, now).resolving).toBe('ci');
    expect(prSignals(r, { ...noAttention, conflictFix: new Set([key]) }, now).resolving).toBe('conflict');
    expect(prSignals(r, { ...noAttention, reviewing: new Set(['a']) }, now).resolving).toBe('review');
  });

  // Not workers.prCheckFailureCount: that counts failed GitHub lookups and resets on success.
  it('fix attempts on a red PR, from the CI-retry tasks buildd dispatched for it', () => {
    const red = shapePrRows([row({ status: 'ci_failed', lastCheckedAt: now })], 'open')[0];
    expect(prSignals(red, { ...noAttention, ciFixAttempts: new Map([['ws-a:1', 2]]) }, now)).toEqual({ ciFixAttempts: 2 });
    expect(prSignals(red, noAttention, now)).toEqual({});
    const green = shapePrRows([row({ status: 'ci_green', lastCheckedAt: now })], 'open')[0];
    expect(prSignals(green, { ...noAttention, ciFixAttempts: new Map([['ws-a:1', 2]]) }, now)).toEqual({});
  });

  it('into a mission branch, not the trunk', () => {
    const r = shapePrRows([row({ baseRef: 'mission/x', missionWorkingBranch: 'mission/x', missionIntegration: true, lastCheckedAt: now })], 'open')[0];
    expect(prSignals(r, noAttention, now)).toEqual({ intoMissionBranch: 'mission/x' });
  });

  it('a state last checked over an hour ago says how old it is', () => {
    const r = shapePrRows([row({ lastCheckedAt: new Date('2026-09-28T09:00:00Z') })], 'open')[0];
    expect(prSignals(r, noAttention, now)).toEqual({ checkedHoursAgo: 3 });
  });
});

// "merge is yours" is a claim about the PR as it is now. PR #3673 was listed
// as "approved, merge is yours" while GitHub reported it dirty with red checks.
describe('waitingReason', () => {
  const approved = { conflictFixesSpent: false, escalated: false, approved: true };

  it('says merge is yours only for an approved PR that is green and mergeable', () => {
    expect(waitingReason({ ...approved, status: 'ci_green' })).toBe('approved, merge is yours');
  });

  it('#3673 shape: approved but conflicting or red says so, never "merge is yours"', () => {
    expect(waitingReason({ ...approved, status: 'conflict' })).toBe('approved but conflicting, not mergeable');
    expect(waitingReason({ ...approved, status: 'ci_failed' })).toBe('approved but CI red, not mergeable');
  });

  it.each(['ci_running', 'pr_open', null])('approved with CI %s is not mergeable yet', (status) => {
    expect(waitingReason({ ...approved, status })).toBe('approved but CI not green yet, not mergeable');
  });

  it('#3502 shape: an escalation on a conflicting PR names the conflict too', () => {
    expect(waitingReason({ ...approved, approved: false, escalated: true, status: 'conflict' })).toBe('reviewer escalated, conflicting');
    expect(waitingReason({ ...approved, approved: false, escalated: true, status: 'ci_green' })).toBe('reviewer escalated');
  });

  it('spent conflict fixes win over every other reading', () => {
    expect(waitingReason({ ...approved, conflictFixesSpent: true, status: 'conflict' })).toBe('conflict fixes used up');
  });

  it('a human-merge PR names a red or conflicting state', () => {
    const human = { conflictFixesSpent: false, escalated: false, approved: false };
    expect(waitingReason({ ...human, status: 'ci_green' })).toBe('human merge');
    expect(waitingReason({ ...human, status: 'ci_failed' })).toBe('human merge, CI red');
  });
});

describe('needsAttention', () => {
  const base = shapePrRows([row({})], 'open')[0];
  it('conflicts, red CI, or waiting on you', () => {
    expect(needsAttention({ ...base, status: 'conflict' })).toBe(true);
    expect(needsAttention({ ...base, status: 'ci_failed' })).toBe(true);
    expect(needsAttention({ ...base, status: 'ci_green', waitingOnYou: 'human merge' })).toBe(true);
    expect(needsAttention({ ...base, status: 'ci_running' })).toBe(false);
  });
});

describe('rankPrs', () => {
  const base = shapePrRows([row({})], 'open')[0];
  it('waiting on you, then red nobody is fixing, then red being fixed, then the rest', () => {
    const out = rankPrs([
      { ...base, prUrl: 'rest', status: 'ci_running' },
      { ...base, prUrl: 'fixing', status: 'conflict', resolving: 'conflict' as const },
      { ...base, prUrl: 'red', status: 'ci_failed' },
      { ...base, prUrl: 'you', status: 'ci_green', waitingOnYou: 'human merge' },
    ]);
    expect(out.map(r => r.prUrl)).toEqual(['you', 'red', 'fixing', 'rest']);
  });
});
