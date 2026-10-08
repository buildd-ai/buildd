import { describe, expect, it, mock } from 'bun:test';

// The pure calculations never touch the DB; stub it so the module loads alone.
mock.module('@buildd/core/db', () => ({ db: {} }));

const {
  computeRework, computeChainDurations, computeRaisedToClaimed, countDecisions, summarizeDurations,
} = await import('./early-release-metrics');
type ReleaseRow = import('./early-release-metrics').ReleaseRow;
type ChainRow = import('./early-release-metrics').ChainRow;

const HOUR = 3_600_000;
const t0 = new Date('2026-10-01T00:00:00Z');
const at = (hours: number) => new Date(t0.getTime() + hours * HOUR);

function release(over: Partial<ReleaseRow> & Pick<ReleaseRow, 'id' | 'dependentTaskId'>): ReleaseRow {
  return { upstreamTaskId: 'up', decision: 'start_now', decidedAt: t0, revokedAt: null, dependentStatus: 'in_progress', ...over };
}

describe('computeRework', () => {
  const releases: ReleaseRow[] = [
    release({ id: 'r1', dependentTaskId: 'd1' }),
    release({ id: 'r2', dependentTaskId: 'd2', decision: 'start_stacked' }),
    release({ id: 'r3', dependentTaskId: 'd3' }),
    release({ id: 'r4', dependentTaskId: 'd4', revokedAt: at(2) }),
    release({ id: 'r5', dependentTaskId: 'd5', dependentStatus: 'cancelled' }),
    // Held, not released: never in the denominator, and its events never count.
    release({ id: 'r6', dependentTaskId: 'd6', decision: 'wait' }),
  ];

  it('counts refresh, escalate and cancel as rework over all released dependents', () => {
    const rework = computeRework(releases, [
      { taskId: 'd1', releaseId: 'r1', action: 'refresh' },
      { taskId: 'd2', releaseId: 'r2', action: 'escalate' },
      { taskId: 'd6', releaseId: 'r6', action: 'refresh' },
    ]);
    expect(rework).toEqual({ released: 5, reworked: 4, rate: 4 / 5, refreshed: 1, escalated: 1, cancelled: 2 });
  });

  it('counts a dependent once however many rework events it got', () => {
    const rework = computeRework(releases, [
      { taskId: 'd1', releaseId: 'r1', action: 'refresh' },
      { taskId: 'd1', releaseId: 'r1', action: 'refresh' },
      { taskId: 'd1', releaseId: 'r1', action: 'escalate' },
    ]);
    expect(rework.reworked).toBe(3); // d1 + the two cancellations
    expect(rework.refreshed).toBe(1);
    expect(rework.escalated).toBe(1);
  });

  it('falls back to the event task id when the release id is missing, and ignores non-rework actions', () => {
    const rework = computeRework(releases, [
      { taskId: 'd3', releaseId: null, action: 'refresh' },
      { taskId: 'd1', releaseId: 'r1', action: 'ignore' },
      { taskId: 'd1', releaseId: 'r1', action: 'refresh_skipped_no_pr' },
      { taskId: 'elsewhere', releaseId: null, action: 'refresh' },
    ]);
    expect(rework.refreshed).toBe(1);
    expect(rework.reworked).toBe(3);
  });

  it('reports a null rate rather than 0 when nothing was released', () => {
    expect(computeRework([release({ id: 'r', dependentTaskId: 'd', decision: 'wait' })], []))
      .toEqual({ released: 0, reworked: 0, rate: null, refreshed: 0, escalated: 0, cancelled: 0 });
  });
});

describe('computeChainDurations', () => {
  const raised = new Map([['upA', at(0)], ['upB', at(4)], ['upLate', at(50)]]);
  const modes = new Map([['optedIn', 'rule_only' as const], ['off', 'off' as const]]);
  const chain = (over: Partial<ChainRow> & Pick<ChainRow, 'dependentTaskId'>): ChainRow =>
    ({ workspaceId: 'off', upstreamTaskIds: ['upA'], mergedAt: at(10), released: false, ...over });

  it('splits released dependents from never-opted-in ones, measuring from upstream PR raised to dependent merged', () => {
    const result = computeChainDurations([
      chain({ dependentTaskId: 'r1', workspaceId: 'optedIn', released: true, mergedAt: at(3) }),
      chain({ dependentTaskId: 'r2', workspaceId: 'optedIn', released: true, mergedAt: at(5) }),
      chain({ dependentTaskId: 'n1', mergedAt: at(20) }),
      chain({ dependentTaskId: 'n2', mergedAt: at(30) }),
      chain({ dependentTaskId: 'n3', mergedAt: at(40) }),
    ], raised, modes);
    expect(result.released).toEqual({ n: 2, p50Ms: 3 * HOUR, p90Ms: 5 * HOUR });
    expect(result.notOptedIn).toEqual({ n: 3, p50Ms: 30 * HOUR, p90Ms: 40 * HOUR });
  });

  it('anchors on the latest upstream PR raise when a dependent has several upstreams', () => {
    const result = computeChainDurations([chain({ dependentTaskId: 'n', upstreamTaskIds: ['upA', 'upB'], mergedAt: at(10) })], raised, modes);
    expect(result.notOptedIn).toEqual({ n: 1, p50Ms: 6 * HOUR, p90Ms: 6 * HOUR });
  });

  it('leaves opted-in-but-held dependents out of both cohorts', () => {
    const result = computeChainDurations([chain({ dependentTaskId: 'held', workspaceId: 'optedIn' })], raised, modes);
    expect(result.released.n).toBe(0);
    expect(result.notOptedIn.n).toBe(0);
  });

  it('treats a workspace with no resolved mode as off', () => {
    const result = computeChainDurations([chain({ dependentTaskId: 'n', workspaceId: 'unknown' })], raised, modes);
    expect(result.notOptedIn.n).toBe(1);
  });

  it('skips chains with no upstream PR raise or a raise after the dependent merged', () => {
    const result = computeChainDurations([
      chain({ dependentTaskId: 'noPr', upstreamTaskIds: ['never'] }),
      chain({ dependentTaskId: 'noDeps', upstreamTaskIds: [] }),
      chain({ dependentTaskId: 'inverted', upstreamTaskIds: ['upLate'], mergedAt: at(10) }),
    ], raised, modes);
    expect(result.notOptedIn).toEqual({ n: 0, p50Ms: null, p90Ms: null });
  });
});

describe('computeRaisedToClaimed', () => {
  it('measures from the earliest release decision to the first claim, released dependents only', () => {
    const releases = [
      release({ id: 'a1', dependentTaskId: 'a', decidedAt: at(2) }),
      release({ id: 'a2', dependentTaskId: 'a', decidedAt: at(1) }),
      release({ id: 'b', dependentTaskId: 'b', decision: 'start_stacked', decidedAt: at(0) }),
      release({ id: 'w', dependentTaskId: 'w', decision: 'wait', decidedAt: at(0) }),
      release({ id: 'u', dependentTaskId: 'unclaimed', decidedAt: at(0) }),
    ];
    const claims = new Map([['a', at(1.5)], ['b', at(3)], ['w', at(1)]]);
    expect(computeRaisedToClaimed(releases, claims)).toEqual({ n: 2, p50Ms: 0.5 * HOUR, p90Ms: 3 * HOUR });
  });
});

describe('countDecisions / summarizeDurations', () => {
  it('counts every decision in the window', () => {
    expect(countDecisions([
      release({ id: '1', dependentTaskId: 'a' }),
      release({ id: '2', dependentTaskId: 'b', decision: 'wait' }),
      release({ id: '3', dependentTaskId: 'c', decision: 'start_stacked' }),
      release({ id: '4', dependentTaskId: 'd', decision: 'wait' }),
    ])).toEqual({ start_now: 1, start_stacked: 1, wait: 2 });
  });

  it('uses nearest-rank quantiles and nulls for an empty set', () => {
    expect(summarizeDurations([])).toEqual({ n: 0, p50Ms: null, p90Ms: null });
    expect(summarizeDurations([10, 1, 2, 3, 4, 5, 6, 7, 8, 9])).toEqual({ n: 10, p50Ms: 5, p90Ms: 9 });
  });
});
