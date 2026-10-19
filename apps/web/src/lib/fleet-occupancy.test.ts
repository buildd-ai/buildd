import { describe, it, expect } from 'bun:test';
import {
  buildOccupancySeries,
  occupancyBucketMs,
  occupancyWindowMs,
  isOccupancyWindow,
  MAX_UNENDED_RUN_MS,
  occupancyDiscrepancies,
  scopeMembers,
  type OccupancyWorkerRow,
} from './fleet-occupancy';
import { classifyRunnerOwnership, RUNNER_CLASSES } from './runner-ownership';
import { MAX_UNENDED_RUN_MS as INSIGHTS_UNENDED_CAP } from './insights-flow';

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
    expect(s.summary.runner).toEqual({ peak: 0, avg: 0 });
    expect(s.summary.sessions).toEqual({ peak: 0, avg: 0 });
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
  it('uses the same unended-run cap as Insights', () => {
    expect(INSIGHTS_UNENDED_CAP).toBe(MAX_UNENDED_RUN_MS);
  });

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

describe('owner attribution reconciles to the total', async () => {
  const { occupancyDiscrepancies } = await import('./fleet-occupancy');
  const rows = (): OccupancyWorkerRow[] => [
    row({ ownerId: 'me', startedAt: NOW - 3 * H, completedAt: NOW - H }),
    row({ ownerId: 'you', startedAt: NOW - 2 * H, completedAt: NOW - 30 * MIN }),
    row({ ownerId: null, startedAt: NOW - 90 * MIN, completedAt: NOW - 20 * MIN }),
    row({ runner: 'mcp', ownerId: 'me', startedAt: NOW - 2 * H, completedAt: NOW - H }),
    row({ runner: 'mcp', ownerId: 'you', startedAt: NOW - 90 * MIN, completedAt: NOW - H }),
  ];

  for (const w of ['24h', '7d', '30d'] as const) {
    it(`${w}: mine + others + unattributed = total, runner and sessions apart`, () => {
      const s = buildOccupancySeries({ window: w, now: NOW, workers: rows(), viewerId: 'me' });
      expect(occupancyDiscrepancies(s)).toEqual([]);
      expect(s.summary.runner.avg).toBeGreaterThan(0);
      expect(s.summary.runnerBy.mine.avg).toBeGreaterThan(0);
      expect(s.summary.runnerBy.unattributed.avg).toBeGreaterThan(0);
    });
  }

  it('unknown owner is unattributed, never mine; no viewer means nothing is mine', () => {
    const a = buildOccupancySeries({ window: '24h', now: NOW, workers: rows(), viewerId: 'me' });
    const none = buildOccupancySeries({ window: '24h', now: NOW, workers: rows() });
    expect(a.summary.runnerBy.unattributed.peak).toBe(1);
    expect(none.summary.runnerBy.mine.avg).toBe(0);
    expect(none.summary.runner.avg).toBeCloseTo(a.summary.runner.avg, 9);
  });

  it('sessions are not folded into runner slots in any part', () => {
    const s = buildOccupancySeries({ window: '24h', now: NOW, workers: [row({ runner: 'mcp', ownerId: 'me', startedAt: NOW - H, completedAt: NOW })], viewerId: 'me' });
    expect(s.summary.runner.peak).toBe(0);
    expect(s.summary.sessionsBy.mine.peak).toBe(1);
    expect(occupancyDiscrepancies(s)).toEqual([]);
  });

  it('empty input reconciles at zero', () => {
    expect(occupancyDiscrepancies(buildOccupancySeries({ window: '7d', now: NOW, workers: [], viewerId: 'me' }))).toEqual([]);
  });
});

describe('task owner and runner ownership (AC-2)', () => {
  const span = { startedAt: NOW - 2 * H, completedAt: NOW - H };

  it('a task on a managed runner is its task owner\'s, and the slot is the managed runner\'s', () => {
    // Claimed by a bld_ key (no claimer), so the old claimer-only rule said unattributed.
    const s = buildOccupancySeries({
      window: '24h', now: NOW, viewerId: 'me',
      workers: [row({ ...span, ownerId: null, taskOwnerId: 'me', runnerClass: 'managed' })],
    });
    expect(s.summary.runnerBy.mine.avg).toBeGreaterThan(0);
    expect(s.summary.runnerBy.unattributed.avg).toBe(0);
    expect(s.summary.runnerByClass.managed.peak).toBe(1);
    expect(s.summary.runnerByClass.personal.peak).toBe(0);
    expect(occupancyDiscrepancies(s)).toEqual([]);
  });

  it('another member\'s task on my personal runner is theirs, not mine, and the slot stays personal', () => {
    const s = buildOccupancySeries({
      window: '24h', now: NOW, viewerId: 'me',
      workers: [row({ ...span, ownerId: 'me', taskOwnerId: 'you', runnerClass: 'personal' })],
    });
    expect(s.summary.runnerBy.others.peak).toBe(1);
    expect(s.summary.runnerBy.mine.peak).toBe(0);
    expect(s.summary.runnerByClass.personal.peak).toBe(1);
  });

  it('a service-owned task is unattributed even when a person\'s runner claimed it', () => {
    const s = buildOccupancySeries({
      window: '24h', now: NOW, viewerId: 'me',
      workers: [row({ ...span, ownerId: 'me', taskOwnerId: null, runnerClass: 'personal' })],
    });
    expect(s.summary.runnerBy.unattributed.peak).toBe(1);
    expect(s.summary.runnerBy.mine.peak).toBe(0);
  });

  it('a session belongs to its claimer whatever the task owner, and uses no runner class', () => {
    const s = buildOccupancySeries({
      window: '24h', now: NOW, viewerId: 'me',
      workers: [row({ ...span, runner: 'mcp', ownerId: 'me', taskOwnerId: 'you' })],
    });
    expect(s.summary.sessionsBy.mine.peak).toBe(1);
    expect(RUNNER_CLASSES.every(c => s.summary.runnerByClass[c].peak === 0)).toBe(true);
  });

  it('a runner with no recorded class reads unknown; classes reconcile to the total', () => {
    const s = buildOccupancySeries({
      window: '24h', now: NOW,
      workers: [row({ ...span }), row({ ...span, runnerClass: 'team' })],
    });
    expect(s.summary.runnerByClass.unknown.peak).toBe(1);
    expect(occupancyDiscrepancies(s)).toEqual([]);
  });

  it('counts runner work missing an owner or a runner identity instead of guessing', () => {
    const s = buildOccupancySeries({
      window: '24h', now: NOW, viewerId: 'me',
      workers: [
        row({ ...span, taskOwnerId: 'me', runnerClass: 'personal' }),
        row({ ...span, taskOwnerId: null, runnerClass: 'managed' }),
        row({ ...span, taskOwnerId: 'you' }),
        row({ ...span, runner: 'mcp', ownerId: null }),
      ],
    });
    expect(s.summary.coverage).toEqual({ total: 3, ownerMissing: 1, runnerMissing: 1 });
  });
});

describe('classifyRunnerOwnership', () => {
  it('classifies by account, personal stays personal regardless of team', () => {
    expect(classifyRunnerOwnership({ managedRunner: true, createdByUserId: 'u' })).toBe('managed');
    expect(classifyRunnerOwnership({ hostRunner: true, createdByUserId: 'u' })).toBe('team');
    expect(classifyRunnerOwnership({ createdByUserId: 'u' })).toBe('personal');
    expect(classifyRunnerOwnership({})).toBe('unknown');
    expect(classifyRunnerOwnership(null)).toBe('unknown');
  });
});

describe('per-member runner usage', () => {
  it('splits runner slots by owner, leaves sessions and unowned work out, marks the viewer', () => {
    const s = buildOccupancySeries({
      window: '24h', now: NOW, viewerId: 'me',
      workers: [
        row({ ownerId: 'me', startedAt: NOW - 3 * H, completedAt: NOW - H }),
        row({ ownerId: 'you', startedAt: NOW - 2 * H, completedAt: NOW - H }),
        row({ ownerId: null, startedAt: NOW - 2 * H, completedAt: NOW - H }),
        row({ runner: 'mcp', ownerId: 'you', startedAt: NOW - 2 * H, completedAt: NOW - H }),
      ],
    });
    expect(s.members?.map(m => [m.id, m.isMe])).toEqual([['me', true], ['you', false]]);
    expect(s.members![0].avg).toBeGreaterThan(s.members![1].avg);
  });
});

describe('per-member runner usage uses the same principal as mine/others', () => {
  it('names the task owner, not the claimer, and the member row agrees with the Mine split', () => {
    const s = buildOccupancySeries({
      window: '24h', now: NOW, viewerId: 'me',
      workers: [
        // Managed runner: claimed by a service key (or another member), task owned by me.
        row({ ownerId: 'claimer', taskOwnerId: 'me', runnerClass: 'managed', startedAt: NOW - 2 * H, completedAt: NOW - H }),
        // Another member's task, claimed by me.
        row({ ownerId: 'me', taskOwnerId: 'you', runnerClass: 'personal', startedAt: NOW - 2 * H, completedAt: NOW - H }),
        // Service-owned task: unattributed, no named member.
        row({ ownerId: 'claimer', taskOwnerId: null, runnerClass: 'managed', startedAt: NOW - 2 * H, completedAt: NOW - H }),
      ],
    });
    const byId = Object.fromEntries((s.members ?? []).map(m => [m.id, m]));
    expect(Object.keys(byId).sort()).toEqual(['me', 'you']);
    expect(byId.me.isMe).toBe(true);
    expect(byId.me.avg).toBeCloseTo(s.summary.runnerBy.mine.avg, 9);
    expect(byId.you.avg).toBeCloseTo(s.summary.runnerBy.others.avg, 9);
    expect(byId.claimer).toBeUndefined();
  });
});

describe('By member uses the same principal as Mine', () => {
  const managed = (over: Partial<OccupancyWorkerRow>) => row({ ownerId: 'key-creator', taskOwnerId: 'task-owner', startedAt: NOW - 3 * H, completedAt: NOW - H, ...over });
  for (const win of ['24h', '7d', '30d'] as const) {
    it(`credits the task owner, not the claimer (${win})`, () => {
      const s = buildOccupancySeries({ window: win, now: NOW, viewerId: 'task-owner', workers: [managed({})] });
      expect(s.summary.runnerBy.mine.peak).toBe(1);
      expect(s.members!.map(m => [m.id, m.isMe])).toEqual([['task-owner', true]]);
    });
    it(`leaves service-owned work unattributed in both views (${win})`, () => {
      const s = buildOccupancySeries({ window: win, now: NOW, viewerId: 'key-creator', workers: [managed({ taskOwnerId: null })] });
      expect(s.summary.runnerBy.unattributed.peak).toBe(1);
      expect(s.members).toEqual([]);
    });
  }
});

describe('scopeMembers', () => {
  const NOW = Date.UTC(2026, 9, 18, 12);
  const w = (ownerId: string) => ({ runner: 'runner-a', ownerId, taskOwnerId: ownerId, startedAt: NOW - 3_600_000, completedAt: NOW - 1_800_000, status: 'completed' });
  it('drops named rows for non-members but keeps the totals and Others', () => {
    const series = buildOccupancySeries({ window: '24h', now: NOW, viewerId: 'me', workers: [w('me'), w('mate'), w('outsider')] as any });
    expect(series.members!.map(m => m.id).sort()).toEqual(['mate', 'me', 'outsider']);
    const scoped = scopeMembers(series, new Set(['me', 'mate']));
    expect(scoped.members!.map(m => m.id).sort()).toEqual(['mate', 'me']);
    expect(scoped.summary).toEqual(series.summary);
    expect(occupancyDiscrepancies(scoped)).toEqual([]);
  });
});

describe('AC-5 edge cases', () => {
  const span = { startedAt: NOW - 2 * H, completedAt: NOW - H };

  it('a personal runner working another team\'s task stays in the personal class', () => {
    const s = buildOccupancySeries({
      window: '24h', now: NOW, viewerId: 'me',
      workers: [row({ ...span, ownerId: 'me', taskOwnerId: 'other-team-member', runnerClass: 'personal' })],
    });
    expect(s.summary.runnerByClass.personal.peak).toBe(1);
    expect(s.summary.runnerByClass.managed.peak).toBe(0);
    expect(s.summary.runnerByClass.team.peak).toBe(0);
    expect(s.summary.runnerBy.mine.peak).toBe(0);
    expect(occupancyDiscrepancies(s)).toEqual([]);
  });

  it('overlapping sessions peak at their count and never raise the runner line', () => {
    const s = buildOccupancySeries({
      window: '24h', now: NOW, viewerId: 'me',
      workers: [
        row({ ...span, runner: 'mcp', ownerId: 'me' }),
        row({ ...span, runner: 'mcp', ownerId: 'you' }),
        row({ ...span, runner: 'mcp', ownerId: null }),
      ],
    });
    expect(s.summary.sessions.peak).toBe(3);
    expect(s.summary.runner.peak).toBe(0);
    expect(s.summary.runner.avg).toBe(0);
    expect(s.summary.sessionsBy.mine.peak).toBe(1);
    expect(s.summary.sessionsBy.others.peak).toBe(1);
    expect(s.summary.sessionsBy.unattributed.peak).toBe(1);
    expect(occupancyDiscrepancies(s)).toEqual([]);
  });

  it('a session working while no runner slot is occupied reads zero runner occupancy', () => {
    const s = buildOccupancySeries({
      window: '24h', now: NOW, viewerId: 'me',
      workers: [row({ runner: 'mcp', status: 'running', ownerId: 'me', startedAt: NOW - 10 * MIN })],
    });
    expect(s.summary.sessions.peak).toBe(1);
    expect(s.summary.runner.peak).toBe(0);
    expect(s.summary.runnerByClass.unknown.peak).toBe(0);
  });

  it('a session beside a runner worker is counted once each, not summed', () => {
    const s = buildOccupancySeries({
      window: '24h', now: NOW, viewerId: 'me',
      workers: [
        row({ ...span, runner: 'mcp', ownerId: 'me' }),
        row({ ...span, ownerId: 'me', taskOwnerId: 'me', runnerClass: 'personal' }),
      ],
    });
    expect(s.summary.runner.peak).toBe(1);
    expect(s.summary.sessions.peak).toBe(1);
  });
});

describe('one accountable principal across totals, Mine and member rows', () => {
  const span = { startedAt: NOW - 3 * H, completedAt: NOW - H };
  for (const [window, now] of [['24h', NOW], ['7d', NOW], ['30d', NOW]] as const) {
    it(`${window}: the task owner, not the claimer, is the member row and Mine on runner work`, () => {
      const s = buildOccupancySeries({ window, now, viewerId: 'me', workers: [row({ ...span, ownerId: 'claimer', taskOwnerId: 'me', runnerClass: 'managed' })] });
      expect(s.summary.runnerBy.mine.avg).toBeGreaterThan(0);
      expect(s.members?.map(m => m.id)).toEqual(['me']);
    });
    it(`${window}: service-owned work with a claimer gets no named member row`, () => {
      const s = buildOccupancySeries({ window, now, viewerId: 'me', workers: [row({ ...span, ownerId: 'claimer', taskOwnerId: null, runnerClass: 'managed' })] });
      expect(s.summary.runnerBy.unattributed.avg).toBeGreaterThan(0);
      expect(s.members ?? []).toEqual([]);
    });
  }
  it('the claimer decides when the caller does not know the task owner', () => {
    const s = buildOccupancySeries({ window: '24h', now: NOW, viewerId: 'me', workers: [row({ ...span, ownerId: 'me' })] });
    expect(s.members?.map(m => m.id)).toEqual(['me']);
  });
});

describe('principal for work, physical runner for occupancy', () => {
  const span = { startedAt: NOW - 2 * H, completedAt: NOW - H };

  for (const window of ['24h', '7d', '30d'] as const) {
    it(`${window}: task owner A claimed by B is A's in Mine, in the members list and in the managed class`, () => {
      const s = buildOccupancySeries({
        window, now: NOW, viewerId: 'A',
        workers: [row({ ...span, ownerId: 'B', taskOwnerId: 'A', runnerClass: 'managed' })],
      });
      expect(s.summary.runnerBy.mine.peak).toBe(1);
      expect(s.summary.runnerBy.others.peak).toBe(0);
      expect(s.summary.runnerByClass.managed.peak).toBe(1);
      expect(s.members!.map(m => [m.id, m.peak])).toEqual([['A', 1]]);
      expect(s.members!.find(m => m.id === 'B')).toBeUndefined();
      expect(occupancyDiscrepancies(s)).toEqual([]);
    });

    it(`${window}: a service-owned task credits no member, even to its claimer`, () => {
      const s = buildOccupancySeries({
        window, now: NOW, viewerId: 'B',
        workers: [row({ ...span, ownerId: 'B', taskOwnerId: null, runnerClass: 'managed' })],
      });
      expect(s.summary.runnerBy.unattributed.peak).toBe(1);
      expect(s.summary.runnerBy.mine.peak).toBe(0);
      expect(s.members).toEqual([]);
      expect(s.summary.coverage.ownerMissing).toBe(1);
    });

    it(`${window}: a session still belongs to its claimer and never to the member list`, () => {
      const s = buildOccupancySeries({
        window, now: NOW, viewerId: 'B',
        workers: [row({ ...span, runner: 'mcp', ownerId: 'B', taskOwnerId: 'A' })],
      });
      expect(s.summary.sessionsBy.mine.peak).toBe(1);
      expect(s.members).toEqual([]);
    });
  }

  it('without a task owner on the row the claimer is the principal (older callers)', () => {
    const s = buildOccupancySeries({ window: '24h', now: NOW, viewerId: 'B', workers: [row({ ...span, ownerId: 'B' })] });
    expect(s.members!.map(m => m.id)).toEqual(['B']);
  });
});

