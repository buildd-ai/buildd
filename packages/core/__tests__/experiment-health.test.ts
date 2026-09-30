import { describe, expect, it } from 'bun:test';
import {
  DEFAULT_HEALTH_THRESHOLDS,
  evaluateExperimentHealth,
  experimentDeadline,
  stripNonDrawConfig,
  validateDurationCap,
  type HealthAssignment,
  type HealthInput,
} from '../experiment-health';

const DAY = 86_400_000;
const NOW = new Date('2026-06-15T12:00:00.000Z');
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);

function rows(arm: string, n: number, opts: { unit?: (i: number) => string; at?: Date } = {}): HealthAssignment[] {
  return Array.from({ length: n }, (_, i) => ({
    arm,
    unitId: opts.unit ? opts.unit(i) : `${arm}-u${i}`,
    assignedAt: opts.at ?? ago(1),
  }));
}

function input(over: Partial<HealthInput> = {}): HealthInput {
  return {
    status: 'running',
    kind: 'model_routing',
    startedAt: ago(10),
    config: {},
    expectedShares: { control: 0.5, treatment: 0.5 },
    assignments: [...rows('control', 25), ...rows('treatment', 25)],
    ...over,
  };
}

const codes = (i: HealthInput) => evaluateExperimentHealth(i, NOW).map(f => f.code);

describe('evaluateExperimentHealth', () => {
  it('a balanced, recently-enrolling experiment has no findings', () => {
    expect(codes(input())).toEqual([]);
  });

  it('only running experiments are judged', () => {
    for (const status of ['draft', 'paused', 'concluded'] as const) {
      expect(codes(input({ status, assignments: [] }))).toEqual([]);
    }
  });

  describe('no_recent_assignments', () => {
    it('fires when a running experiment has enrolled nothing since it started days ago', () => {
      const f = evaluateExperimentHealth(input({ assignments: [] }), NOW);
      expect(f.map(x => x.code)).toEqual(['no_recent_assignments']);
      expect(f[0].detail).toContain('no unit enrolled');
    });

    it('fires when the latest assignment is older than the window', () => {
      const old = [...rows('control', 25, { at: ago(5) }), ...rows('treatment', 25, { at: ago(5) })];
      expect(codes(input({ assignments: old }))).toEqual(['no_recent_assignments']);
    });

    it('does not fire inside the grace window after start', () => {
      expect(codes(input({ startedAt: ago(1), assignments: [] }))).toEqual([]);
    });
  });

  describe('arm_never_drawn', () => {
    it('fires when an arm with a positive share has zero units after the threshold', () => {
      const f = evaluateExperimentHealth(input({ assignments: rows('control', 40) }), NOW);
      expect(f.map(x => x.code)).toContain('arm_never_drawn');
      expect(f.find(x => x.code === 'arm_never_drawn')!.arm).toBe('treatment');
    });

    it('a tier-pool challenger arm with an allocation share that was never drawn', () => {
      const f = evaluateExperimentHealth(input({
        kind: 'tier_pool',
        expectedShares: { 'arm-incumbent': 0.9, 'arm-challenger': 0.1 },
        assignments: rows('arm-incumbent', 60),
      }), NOW);
      expect(f.map(x => x.code)).toEqual(['arm_never_drawn']);
      expect(f[0].arm).toBe('arm-challenger');
    });

    it('stays quiet below the minimum total', () => {
      expect(codes(input({ assignments: rows('control', 5) }))).toEqual([]);
    });

    it('an arm with a zero share is not expected to be drawn', () => {
      expect(codes(input({
        kind: 'tier_pool',
        expectedShares: { a: 1, b: 0 },
        assignments: rows('a', 40),
      }))).toEqual([]);
    });
  });

  describe('split_imbalance', () => {
    it('fires when the observed split is far outside the treatment fraction', () => {
      const f = evaluateExperimentHealth(input({ assignments: [...rows('control', 80), ...rows('treatment', 20)] }), NOW);
      expect(f.map(x => x.code)).toContain('split_imbalance');
    });

    it('tolerates ordinary binomial noise', () => {
      expect(codes(input({ assignments: [...rows('control', 56), ...rows('treatment', 44)] }))).toEqual([]);
    });

    it('respects a non-half treatment fraction', () => {
      const shares = { control: 0.8, treatment: 0.2 };
      expect(codes(input({ expectedShares: shares, assignments: [...rows('control', 80), ...rows('treatment', 20)] }))).toEqual([]);
      expect(codes(input({ expectedShares: shares, assignments: [...rows('control', 50), ...rows('treatment', 50)] })))
        .toContain('split_imbalance');
    });

    it('counts units, not rows: one mission with many tasks is one draw', () => {
      // 25 control missions, 25 treatment missions, but one treatment mission
      // carries 200 tasks. The draw is balanced; the concentration check is
      // the one that should speak.
      const a = [
        ...rows('control', 25),
        ...rows('treatment', 24),
        ...rows('treatment', 200, { unit: () => 'big-mission' }),
      ];
      const c = codes(input({ assignments: a }));
      expect(c).not.toContain('split_imbalance');
      expect(c).toContain('unit_concentration');
    });
  });

  describe('unit_concentration', () => {
    it('names the unit and its share of the arm', () => {
      const a = [...rows('control', 25), ...rows('treatment', 25), ...rows('treatment', 60, { unit: () => 'mission-x' })];
      const f = evaluateExperimentHealth(input({ assignments: a }), NOW).find(x => x.code === 'unit_concentration')!;
      expect(f.arm).toBe('treatment');
      expect(f.unitId).toBe('mission-x');
      expect(f.detail).toMatch(/7\d% of the treatment arm/);
    });

    it('needs enough rows in the arm before it fires', () => {
      const a = [...rows('control', 3, { unit: () => 'm' }), ...rows('treatment', 2)];
      expect(codes(input({ startedAt: ago(1), assignments: a }))).toEqual([]);
    });
  });

  describe('past_duration_cap', () => {
    it('fires when running past maxDurationDays', () => {
      const f = evaluateExperimentHealth(input({ config: { maxDurationDays: 7 } }), NOW);
      expect(f.map(x => x.code)).toEqual(['past_duration_cap']);
      expect(f[0].severity).toBe('critical');
    });

    it('fires when running past endsAt', () => {
      expect(codes(input({ config: { endsAt: ago(1).toISOString() } }))).toEqual(['past_duration_cap']);
    });

    it('is quiet before the cap', () => {
      expect(codes(input({ config: { maxDurationDays: 30, endsAt: new Date(NOW.getTime() + DAY).toISOString() } }))).toEqual([]);
    });
  });

  it('thresholds are overridable', () => {
    const a = [...rows('control', 56), ...rows('treatment', 44)];
    expect(evaluateExperimentHealth(input({ assignments: a }), NOW, { ...DEFAULT_HEALTH_THRESHOLDS, splitZ: 1 }).map(f => f.code))
      .toContain('split_imbalance');
  });
});

describe('experimentDeadline', () => {
  it('is the earlier of startedAt + maxDurationDays and endsAt', () => {
    const start = new Date('2026-06-01T00:00:00.000Z');
    expect(experimentDeadline({ maxDurationDays: 10 }, start)?.toISOString()).toBe('2026-06-11T00:00:00.000Z');
    expect(experimentDeadline({ maxDurationDays: 10, endsAt: '2026-06-05T00:00:00.000Z' }, start)?.toISOString())
      .toBe('2026-06-05T00:00:00.000Z');
    expect(experimentDeadline({ endsAt: '2026-06-05T00:00:00.000Z' }, null)?.toISOString()).toBe('2026-06-05T00:00:00.000Z');
  });

  it('is null with no cap, or maxDurationDays before a start', () => {
    expect(experimentDeadline({}, new Date())).toBeNull();
    expect(experimentDeadline({ maxDurationDays: 3 }, null)).toBeNull();
  });
});

describe('validateDurationCap', () => {
  it('accepts absent, positive days and a parseable date', () => {
    expect(validateDurationCap({})).toBeNull();
    expect(validateDurationCap({ maxDurationDays: 14 })).toBeNull();
    expect(validateDurationCap({ endsAt: '2026-07-01T00:00:00Z' })).toBeNull();
    expect(validateDurationCap({ maxDurationDays: null, endsAt: null })).toBeNull();
  });

  it('rejects nonsense', () => {
    expect(validateDurationCap({ maxDurationDays: 0 })).toMatch(/maxDurationDays/);
    expect(validateDurationCap({ maxDurationDays: 'ten' })).toMatch(/maxDurationDays/);
    expect(validateDurationCap({ maxDurationDays: 400 })).toMatch(/maxDurationDays/);
    expect(validateDurationCap({ endsAt: 'soon' })).toMatch(/endsAt/);
  });
});

describe('stripNonDrawConfig', () => {
  it('drops the duration-cap keys and keeps the rest', () => {
    expect(stripNonDrawConfig({ maxDurationDays: 3, endsAt: 'x', minSamplePerArm: 30 })).toEqual({ minSamplePerArm: 30 });
  });
});
