import { describe, it, expect } from 'bun:test';
import {
  buildOccupancySeries,
  occupancyBucketMs,
  occupancyWindowMs,
  isOccupancyWindow,
  type OccupancyWorkerRow,
} from './fleet-occupancy';
import { MAX_UNENDED_RUN_MS } from './insights-flow';

const MIN = 60_000;
const H = 60 * MIN;
// A bucket-aligned "now" keeps the arithmetic readable: 15-minute buckets for 24h.
const NOW = Date.UTC(2026, 9, 8, 12, 0, 0);
const FROM = NOW - 24 * H;

function row(over: Partial<OccupancyWorkerRow>): OccupancyWorkerRow {
  return { runner: 'http://runner-a', status: 'completed', startedAt: null, completedAt: null, updatedAt: null, ...over };
}

function series(workers: OccupancyWorkerRow[], window: '24h' | '7d' | '30d' = '24h', now = NOW) {
  return buildOccupancySeries({ window, now, workers });
}

/** The bucket that starts at `t`. */
function at(s: ReturnType<typeof series>, t: number) {
  const b = s.buckets.find(x => x.t === t);
  if (!b) throw new Error(`no bucket at ${new Date(t).toISOString()}`);
  return b;
}

describe('windows', () => {
  it('24h = 15-minute buckets, 7d = hourly, 30d = daily', () => {
    expect(occupancyBucketMs('24h')).toBe(15 * MIN);
    expect(occupancyBucketMs('7d')).toBe(H);
    expect(occupancyBucketMs('30d')).toBe(24 * H);
    expect(occupancyWindowMs('24h')).toBe(24 * H);
    expect(occupancyWindowMs('7d')).toBe(7 * 24 * H);
    expect(occupancyWindowMs('30d')).toBe(30 * 24 * H);
  });

  it('accepts only the three windows', () => {
    expect(isOccupancyWindow('24h')).toBe(true);
    expect(isOccupancyWindow('7d')).toBe(true);
    expect(isOccupancyWindow('30d')).toBe(true);
    expect(isOccupancyWindow('90d')).toBe(false);
    expect(isOccupancyWindow(undefined)).toBe(false);
  });

  it('buckets tile the window exactly, oldest first, aligned to the bucket size', () => {
    const midnight = Date.UTC(2026, 9, 8);
    for (const w of ['24h', '7d', '30d'] as const) {
      const s = series([], w, midnight);
      const size = occupancyBucketMs(w);
      expect(s.bucketMs).toBe(size);
      expect(s.buckets.length).toBe(occupancyWindowMs(w) / size);
      expect(s.buckets[0].t).toBe(midnight - occupancyWindowMs(w));
      for (let i = 1; i < s.buckets.length; i++) expect(s.buckets[i].t - s.buckets[i - 1].t).toBe(size);
    }
  });

  it('an unaligned now still ends on the current (partial) bucket', () => {
    const now = NOW + 7 * MIN;
    const s = series([], '24h', now);
    const last = s.buckets[s.buckets.length - 1];
    expect(last.t).toBe(NOW);
    expect(s.window.to).toBe(now);
  });
});

describe('daily buckets follow the viewer\'s midnight', () => {
  it('a UTC-4 viewer\'s days start at 04:00 UTC', () => {
    const s = buildOccupancySeries({ window: '30d', now: NOW, workers: [], tzOffsetMs: -4 * H });
    for (const b of s.buckets) expect(new Date(b.t).getUTCHours()).toBe(4);
    expect(s.buckets[s.buckets.length - 1].t).toBeLessThanOrEqual(NOW);
    expect(s.buckets[s.buckets.length - 1].t + 24 * H).toBeGreaterThan(NOW);
  });

  it('an offset beyond any real zone is clamped, not trusted', () => {
    const s = buildOccupancySeries({ window: '30d', now: NOW, workers: [], tzOffsetMs: 99 * H });
    expect(new Date(s.buckets[0].t).getUTCHours()).toBe(10); // UTC+14
  });
});

describe('empty window', () => {
  it('every bucket is zero and the summary says so', () => {
    const s = series([]);
    expect(s.buckets.every(b => b.runner.avg === 0 && b.runner.peak === 0 && b.sessions.avg === 0 && b.sessions.peak === 0)).toBe(true);
    expect(s.summary).toEqual({ runner: { peak: 0, avg: 0 }, sessions: { peak: 0, avg: 0 } });
  });
});

describe('time weighting', () => {
  it('a worker busy for the whole bucket counts 1; half of it counts 0.5', () => {
    const b0 = NOW - 2 * H;
    const s = series([
      row({ startedAt: b0, completedAt: b0 + 15 * MIN }),
      row({ startedAt: b0 + 15 * MIN, completedAt: b0 + 22.5 * MIN }),
    ]);
    expect(at(s, b0).runner.avg).toBeCloseTo(1);
    expect(at(s, b0 + 15 * MIN).runner.avg).toBeCloseTo(0.5);
  });

  it('a worker spanning several buckets fills each it covers', () => {
    const b0 = NOW - 3 * H;
    const s = series([row({ startedAt: b0 + 5 * MIN, completedAt: b0 + 40 * MIN })]);
    expect(at(s, b0).runner.avg).toBeCloseTo(10 / 15);
    expect(at(s, b0 + 15 * MIN).runner.avg).toBeCloseTo(1);
    expect(at(s, b0 + 30 * MIN).runner.avg).toBeCloseTo(10 / 15);
    expect(at(s, b0 + 45 * MIN).runner.avg).toBe(0);
  });

  it('work that started before the window is clipped to it', () => {
    const s = series([row({ startedAt: FROM - 2 * H, completedAt: FROM + 15 * MIN })]);
    expect(at(s, FROM).runner.avg).toBeCloseTo(1);
    expect(at(s, FROM + 15 * MIN).runner.avg).toBe(0);
  });

  it('the current partial bucket averages over the time elapsed, not the whole bucket', () => {
    const now = NOW + 6 * MIN;
    const s = series([row({ status: 'running', startedAt: NOW - H })], '24h', now);
    expect(at(s, NOW).runner.avg).toBeCloseTo(1);
  });
});

describe('peak vs average', () => {
  it('two workers that do not overlap peak at 1 even though the bucket averages 1', () => {
    const b0 = NOW - 2 * H;
    const s = series([
      row({ startedAt: b0, completedAt: b0 + 7.5 * MIN }),
      row({ startedAt: b0 + 7.5 * MIN, completedAt: b0 + 15 * MIN }),
    ]);
    expect(at(s, b0).runner.avg).toBeCloseTo(1);
    expect(at(s, b0).runner.peak).toBe(1);
  });

  it('three short overlapping workers peak at 3 while the average stays low', () => {
    const b0 = NOW - 2 * H;
    const s = series([
      row({ startedAt: b0 + MIN, completedAt: b0 + 2 * MIN }),
      row({ startedAt: b0 + MIN, completedAt: b0 + 2 * MIN }),
      row({ startedAt: b0 + MIN, completedAt: b0 + 2 * MIN }),
    ]);
    expect(at(s, b0).runner.peak).toBe(3);
    expect(at(s, b0).runner.avg).toBeCloseTo(3 / 15);
  });

  it('a worker ending exactly when another starts is not counted as overlap', () => {
    const b0 = NOW - 2 * H;
    const s = series([
      row({ startedAt: b0, completedAt: b0 + 5 * MIN }),
      row({ startedAt: b0 + 5 * MIN, completedAt: b0 + 10 * MIN }),
    ]);
    expect(at(s, b0).runner.peak).toBe(1);
  });

  it('summary: peak is the window maximum, avg is the time-weighted mean over the window', () => {
    const b0 = NOW - 2 * H;
    const s = series([
      row({ startedAt: b0, completedAt: b0 + 12 * H / 12 }), // 1h
      row({ startedAt: b0, completedAt: b0 + 30 * MIN }),
    ]);
    expect(s.summary.runner.peak).toBe(2);
    // 1.5 busy-hours over 24h.
    expect(s.summary.runner.avg).toBeCloseTo(1.5 / 24);
  });
});

describe('runner slots vs sessions', () => {
  it('a worker claimed from an interactive session counts as a session, never a runner slot', () => {
    const b0 = NOW - 2 * H;
    const s = series([
      row({ runner: 'mcp', startedAt: b0, completedAt: b0 + 15 * MIN }),
      row({ runner: 'http://runner-a', startedAt: b0, completedAt: b0 + 15 * MIN }),
    ]);
    expect(at(s, b0).runner.avg).toBeCloseTo(1);
    expect(at(s, b0).sessions.avg).toBeCloseTo(1);
    expect(at(s, b0).runner.peak).toBe(1);
    expect(at(s, b0).sessions.peak).toBe(1);
  });

  it('placeholder workers no runner executed (system, external) count as neither', () => {
    const b0 = NOW - 2 * H;
    const s = series([
      row({ runner: 'system', startedAt: b0, completedAt: b0 + 15 * MIN }),
      row({ runner: 'external', startedAt: b0, completedAt: b0 + 15 * MIN }),
    ]);
    expect(at(s, b0).runner.avg).toBe(0);
    expect(at(s, b0).sessions.avg).toBe(0);
  });
});

describe('when a worker stops holding its slot', () => {
  it('a live worker (running, waiting on a person, starting) holds its slot until now', () => {
    for (const status of ['running', 'waiting_input', 'starting', 'idle']) {
      const s = series([row({ status, startedAt: NOW - 30 * MIN, updatedAt: NOW - 25 * MIN })]);
      expect(at(s, NOW - 15 * MIN).runner.avg).toBeCloseTo(1);
    }
  });

  it('a finished worker with no recorded end runs at most MAX_UNENDED_RUN_MS', () => {
    const start = NOW - 20 * H;
    const s = series([row({ status: 'failed', startedAt: start, completedAt: null, updatedAt: NOW - MIN })]);
    const capEnd = start + MAX_UNENDED_RUN_MS;
    expect(at(s, capEnd - 15 * MIN).runner.avg).toBeCloseTo(1);
    expect(at(s, capEnd).runner.avg).toBe(0);
  });

  it('a finished worker with no recorded end stops at its last update when that is sooner', () => {
    const start = NOW - 4 * H;
    const s = series([row({ status: 'failed', startedAt: start, completedAt: null, updatedAt: start + 15 * MIN })]);
    expect(at(s, start).runner.avg).toBeCloseTo(1);
    expect(at(s, start + 15 * MIN).runner.avg).toBe(0);
  });

  it('a worker that never started occupies nothing', () => {
    const s = series([row({ status: 'running', startedAt: null })]);
    expect(s.summary.runner.peak).toBe(0);
  });
});
