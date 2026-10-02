import { describe, expect, it, mock } from 'bun:test';

let selectRows: any[][] = [];
const queue = () => selectRows.shift() ?? [];
const chain = () => {
  const c: any = {};
  for (const m of ['from', 'where', 'orderBy']) c[m] = () => c;
  c.limit = () => Promise.resolve(queue());
  c.then = (res: any, rej: any) => Promise.resolve(queue()).then(res, rej);
  return c;
};
let dbThrows = false;
mock.module('@buildd/core/db', () => ({
  db: { select: () => { if (dbThrows) throw new Error('db down'); return chain(); } },
}));
mock.module('@buildd/core/db/schema', () => ({
  gateEvents: { workspaceId: 'ws', gate: 'gate', occurredAt: 'at' },
  workers: { workspaceId: 'ws', prNumber: 'pr', mergedAt: 'merged', prLifecycleStatus: 'lc' },
}));
mock.module('drizzle-orm', () => ({
  and: (...a: any[]) => ({ and: a }),
  eq: (a: any, b: any) => ({ eq: [a, b] }),
  gte: (a: any, b: any) => ({ gte: [a, b] }),
  inArray: (a: any, b: any) => ({ inArray: [a, b] }),
  desc: (a: any) => ({ desc: a }),
}));

import {
  LANDING_STUCK_THRESHOLD_MS,
  computeLandingMetrics,
  getLandingMetrics,
  nearestRank,
  stuckCandidates,
  type LandingLedgerRow,
} from './pr-landing-metrics';

const NOW = new Date('2030-01-10T12:00:00.000Z');
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);
const MIN = 60_000;

const merged = (over: Partial<LandingLedgerRow> & { timeToLandMs?: number | null } = {}): LandingLedgerRow => {
  const { timeToLandMs, ...rest } = over;
  return {
    workspaceId: 'ws-1',
    outcome: 'accepted',
    occurredAt: minutesAgo(60),
    detail: {
      prNumber: 1,
      landingOutcome: 'merged',
      ...(timeToLandMs === null ? { timeToLandUnmeasured: true } : { timeToLandMs: timeToLandMs ?? 0 }),
    },
    ...rest,
  };
};

const open = (prNumber: number, approvedGreenMinutesAgo: number | null, over: Partial<LandingLedgerRow> = {}): LandingLedgerRow => ({
  workspaceId: 'ws-1',
  outcome: 'deferred',
  occurredAt: minutesAgo(5),
  detail: {
    prNumber,
    landingOutcome: 'needs_fix',
    ...(approvedGreenMinutesAgo === null ? {} : { approvedGreenAt: minutesAgo(approvedGreenMinutesAgo).toISOString() }),
  },
  ...over,
});

describe('nearestRank', () => {
  it('returns the nearest-rank percentile of an unsorted list', () => {
    const v = [50, 10, 40, 20, 30];
    expect(nearestRank(v, 0.5)).toBe(30);
    expect(nearestRank(v, 0.9)).toBe(50);
    expect(nearestRank([7], 0.9)).toBe(7);
  });
  it('does not mutate its input', () => {
    const v = [3, 1, 2];
    nearestRank(v, 0.5);
    expect(v).toEqual([3, 1, 2]);
  });
});

describe('computeLandingMetrics — time to land', () => {
  it('reports p50, p90, max and count over measured landings in the window', () => {
    const times = [1, 2, 3, 4, 5, 6, 7, 8, 9, 100].map((m) => m * MIN);
    const rows = times.map((t, i) => merged({ timeToLandMs: t, detail: { prNumber: i + 1, landingOutcome: 'merged', timeToLandMs: t } }));
    const m = computeLandingMetrics({ rows, window: '7d', now: NOW });
    expect(m.landed).toBe(10);
    expect(m.unmeasured).toBe(0);
    expect(m.timeToLand).toEqual({ count: 10, p50Ms: 5 * MIN, p90Ms: 9 * MIN, maxMs: 100 * MIN });
  });

  it('counts a landing with no measurable start as unmeasured, not as zero', () => {
    const m = computeLandingMetrics({ rows: [merged({ timeToLandMs: 10 * MIN }), merged({ timeToLandMs: null })], window: '7d', now: NOW });
    expect(m.landed).toBe(2);
    expect(m.unmeasured).toBe(1);
    expect(m.timeToLand?.count).toBe(1);
    expect(m.timeToLand?.p50Ms).toBe(10 * MIN);
  });

  it('is null (not zero) when nothing landed', () => {
    const m = computeLandingMetrics({ rows: [], window: '24h', now: NOW });
    expect(m.landed).toBe(0);
    expect(m.timeToLand).toBeNull();
  });

  it('ignores landings outside the window', () => {
    const old = merged({ occurredAt: new Date(NOW.getTime() - 2 * 24 * 60 * MIN), timeToLandMs: 99 * MIN });
    expect(computeLandingMetrics({ rows: [old], window: '24h', now: NOW }).landed).toBe(0);
    expect(computeLandingMetrics({ rows: [old], window: '7d', now: NOW }).landed).toBe(1);
  });

  it('ignores a shadow "would merge" row: nothing landed', () => {
    const shadow: LandingLedgerRow = {
      workspaceId: 'ws-1',
      outcome: 'warned',
      occurredAt: minutesAgo(10),
      detail: { prNumber: 3, shadowOutcome: 'merged', timeToLandMs: 5 * MIN },
    };
    expect(computeLandingMetrics({ rows: [shadow], window: '7d', now: NOW }).landed).toBe(0);
  });

  it('ignores a negative or non-numeric time', () => {
    const rows = [
      merged({ detail: { prNumber: 1, landingOutcome: 'merged', timeToLandMs: -5 } }),
      merged({ detail: { prNumber: 2, landingOutcome: 'merged', timeToLandMs: 'soon' } }),
    ];
    const m = computeLandingMetrics({ rows, window: '7d', now: NOW });
    expect(m.landed).toBe(2);
    expect(m.unmeasured).toBe(2);
    expect(m.timeToLand).toBeNull();
  });
});

describe('computeLandingMetrics — stuck', () => {
  it('counts PRs approved and green past the threshold, and the oldest', () => {
    const rows = [open(1, 31), open(2, 200), open(3, 5)];
    const m = computeLandingMetrics({ rows, window: '7d', now: NOW });
    expect(m.stuck.thresholdMs).toBe(LANDING_STUCK_THRESHOLD_MS);
    expect(m.stuck.count).toBe(2);
    expect(m.stuck.oldestMs).toBe(200 * MIN);
  });

  it('is exactly at the threshold: stuck', () => {
    const m = computeLandingMetrics({ rows: [open(1, 30)], window: '7d', now: NOW });
    expect(m.stuck.count).toBe(1);
  });

  it('uses only the latest decision per PR: a later merge clears it', () => {
    const rows = [open(1, 120, { occurredAt: minutesAgo(50) }), merged({ occurredAt: minutesAgo(1), detail: { prNumber: 1, landingOutcome: 'merged', timeToLandMs: 119 * MIN } })];
    expect(computeLandingMetrics({ rows, window: '7d', now: NOW }).stuck.count).toBe(0);
  });

  it('a later decision that is no longer approved-and-green clears it', () => {
    const rows = [open(1, 120, { occurredAt: minutesAgo(50) }), open(1, null, { occurredAt: minutesAgo(2) })];
    expect(computeLandingMetrics({ rows, window: '7d', now: NOW }).stuck.count).toBe(0);
  });

  it('keys by workspace as well as PR number', () => {
    const rows = [open(1, 120, { workspaceId: 'ws-1' }), open(1, 120, { workspaceId: 'ws-2' })];
    expect(computeLandingMetrics({ rows, window: '7d', now: NOW }).stuck.count).toBe(2);
  });

  it('counts a shadow row: the PR is still waiting whoever decides', () => {
    const shadow: LandingLedgerRow = {
      workspaceId: 'ws-1',
      outcome: 'warned',
      occurredAt: minutesAgo(3),
      detail: { prNumber: 9, shadowOutcome: 'merged', approvedGreenAt: minutesAgo(90).toISOString() },
    };
    expect(computeLandingMetrics({ rows: [shadow], window: '7d', now: NOW }).stuck.count).toBe(1);
  });

  it('leaves out PRs the caller says are no longer open', () => {
    const rows = [open(1, 120), open(2, 120)];
    const m = computeLandingMetrics({ rows, window: '7d', now: NOW, isOpen: (_ws, pr) => pr !== 1 });
    expect(m.stuck.count).toBe(1);
  });

  it('is zero with a null oldest when nothing is stuck', () => {
    const m = computeLandingMetrics({ rows: [open(1, 2)], window: '7d', now: NOW });
    expect(m.stuck).toEqual({ thresholdMs: LANDING_STUCK_THRESHOLD_MS, count: 0, oldestMs: null });
  });

  it('skips rows with no workspace, no PR number or an unparseable clock', () => {
    const rows: LandingLedgerRow[] = [
      open(1, 120, { workspaceId: null }),
      { workspaceId: 'ws-1', outcome: 'deferred', occurredAt: minutesAgo(1), detail: { approvedGreenAt: minutesAgo(120).toISOString() } },
      { workspaceId: 'ws-1', outcome: 'deferred', occurredAt: minutesAgo(1), detail: { prNumber: 4, approvedGreenAt: 'garbage' } },
    ];
    expect(computeLandingMetrics({ rows, window: '7d', now: NOW }).stuck.count).toBe(0);
  });
});

describe('stuckCandidates', () => {
  it('names the workspace and PR of each stuck candidate', () => {
    expect(stuckCandidates([open(7, 120)], NOW, LANDING_STUCK_THRESHOLD_MS)).toEqual([{ workspaceId: 'ws-1', prNumber: 7 }]);
  });
});

describe('getLandingMetrics', () => {
  it('reads the ledger, drops stuck PRs whose worker already merged or closed, and never throws', async () => {
    selectRows = [
      [open(1, 120), open(2, 120), merged({ timeToLandMs: 4 * MIN })],
      [{ workspaceId: 'ws-1', prNumber: 1 }],
    ];
    const m = await getLandingMetrics(['ws-1'], '7d', NOW);
    expect(m?.stuck.count).toBe(1);
    expect(m?.landed).toBe(1);
    expect(m?.timeToLand?.p50Ms).toBe(4 * MIN);
  });

  it('skips the worker lookup when nothing is stuck', async () => {
    selectRows = [[merged({ timeToLandMs: MIN })]];
    const m = await getLandingMetrics(['ws-1'], '7d', NOW);
    expect(m?.stuck.count).toBe(0);
    expect(selectRows).toEqual([]);
  });

  it('returns null for an empty scope without querying', async () => {
    selectRows = [[merged()]];
    expect(await getLandingMetrics([], '7d', NOW)).toBeNull();
    expect(selectRows.length).toBe(1);
  });

  it('returns null when the ledger read fails', async () => {
    dbThrows = true;
    const orig = console.error;
    console.error = () => {};
    try {
      expect(await getLandingMetrics(['ws-1'], '7d', NOW)).toBeNull();
    } finally {
      console.error = orig;
      dbThrows = false;
    }
  });
});
