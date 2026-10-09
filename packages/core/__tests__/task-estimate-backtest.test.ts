import { describe, it, expect, mock } from 'bun:test';

mock.module('../db/client', () => ({ db: {} }));

const bt = await import('../task-estimate-backtest');
const { neighbourMedianBaseline, quantile } = await import('../task-estimate-baseline');
const { estimateTaskSizeFromSessions } = await import('../task-size-estimate');
type TaskOutcome = import('../task-estimate-backtest').TaskOutcome;
type SizePredictor = import('../task-estimate-backtest').SizePredictor;

const T0 = Date.UTC(2025, 0, 1);
const H = 3_600_000;

/** Task created at hour `at`, finishing `dur` minutes later. */
const outcome = (id: string, at: number, over: Partial<TaskOutcome> & { dur?: number } = {}): TaskOutcome => {
  const dur = over.dur ?? 10;
  return {
    taskId: id,
    workspaceId: 'ws-a',
    createdAt: new Date(T0 + at * H),
    kind: 'engineering',
    complexity: 'normal',
    seedText: id,
    completedAt: new Date(T0 + at * H + dur * 60_000),
    minutes: dur,
    tokens: dur * 1000,
    filesChanged: 3,
    ...over,
  };
};

const fixed = (name: string, p50: number, p80: number): SizePredictor => ({
  name,
  predict: () => ({ minutes: { p50, p80 }, tokens: { p50: p50 * 1000, p80: p80 * 1000 } }),
});

describe('scoring', () => {
  it('pinball loss weights under- and over-estimates asymmetrically', () => {
    expect(bt.pinball(0.8, 10, 20)).toBeCloseTo(8); // under: 0.8 * 10
    expect(bt.pinball(0.8, 20, 10)).toBeCloseTo(2); // over: 0.2 * 10
    expect(bt.pinball(0.5, 10, 14)).toBeCloseTo(2);
  });

  it('computes MAE, median error, pinball and p80 coverage', () => {
    const s = bt.scoreEstimates([
      { q: { p50: 10, p80: 15 }, y: 10 },
      { q: { p50: 10, p80: 15 }, y: 20 },
      { q: { p50: 10, p80: 15 }, y: 4 },
    ]);
    expect(s.n).toBe(3);
    expect(s.mae).toBeCloseTo((0 + 10 + 6) / 3);
    expect(s.medianAbsError).toBe(6);
    expect(s.p80Coverage).toBeCloseTo(2 / 3);
    expect(s.pinball80).toBeCloseTo((0.2 * 5 + 0.8 * 5 + 0.2 * 11) / 3, 5);
  });
});

describe('runBacktest leakage', () => {
  it('shows a predictor only work completed before the cutoff, never the task itself', async () => {
    const seen: Array<{ id: string; history: TaskOutcome[]; cutoff: Date }> = [];
    const spy: SizePredictor = {
      name: 'spy',
      predict: ctx => {
        seen.push({ id: ctx.task.taskId, history: [...ctx.history], cutoff: ctx.cutoff });
        expect('minutes' in ctx.task).toBe(false);
        expect('completedAt' in ctx.task).toBe(false);
        return null;
      },
    };
    // b is created before a finishes, so a must not be visible to b.
    const a = outcome('a', 0, { dur: 90 });
    const b = outcome('b', 1);
    const c = outcome('c', 3);
    await bt.runBacktest([c, b, a], { predictors: [spy] });
    expect(seen.map(s => s.id)).toEqual(['a', 'b', 'c']);
    for (const s of seen) {
      for (const h of s.history) {
        expect(h.completedAt.getTime()).toBeLessThan(s.cutoff.getTime());
        expect(h.taskId).not.toBe(s.id);
      }
    }
    expect(seen[1].history.map(h => h.taskId)).toEqual([]);
    expect(seen[2].history.map(h => h.taskId)).toEqual(['b', 'a']); // oldest completion first
  });

  it('drops neighbours the cutoff hides, even if the store returns them', async () => {
    let got: readonly string[] = [];
    const spy: SizePredictor = { name: 'spy', predict: ctx => { got = ctx.neighbours; return null; } };
    await bt.runBacktest([outcome('a', 0), outcome('b', 5)], {
      predictors: [spy],
      neighbours: async t => (t.taskId === 'a' ? ['b'] : ['b', 'a']),
    });
    expect(got).toEqual(['a']);
  });
});

describe('cold start', () => {
  it('hides the task\'s own workspace history and withholds neighbours', async () => {
    const calls: Array<{ id: string; history: string[]; neighbours: string[] }> = [];
    const spy: SizePredictor = {
      name: 'spy',
      predict: ctx => { calls.push({ id: ctx.task.taskId, history: ctx.history.map(h => h.taskId), neighbours: [...ctx.neighbours] }); return null; },
    };
    const rows = [
      outcome('a1', 0),
      outcome('b1', 1, { workspaceId: 'ws-b' }),
      outcome('a2', 5),
    ];
    await bt.runBacktest(rows, { predictors: [spy], coldStart: true, neighbours: async () => ['a1', 'b1'] });
    const a2 = calls.find(c => c.id === 'a2')!;
    expect(a2.history).toEqual(['b1']);
    expect(a2.neighbours).toEqual([]);
  });

  it('can score one workspace while history still spans the rest', async () => {
    const run = await bt.runBacktest(
      [outcome('a1', 0), outcome('b1', 1, { workspaceId: 'ws-b' })],
      { predictors: [fixed('f', 5, 8)], workspaceIds: ['ws-b'] },
    );
    expect(run.rows.map(r => r.taskId)).toEqual(['b1']);
  });
});

describe('neighbour-median baseline', () => {
  const history = [1, 2, 3, 4, 5, 6].map(i => outcome(`n${i}`, i - 10, { dur: i * 10, tokens: i * 1000 }));

  it('abstains with fewer than k sized neighbours', () => {
    const ctx = { task: outcome('t', 0), cutoff: new Date(T0), history: history.slice(0, 4), neighbours: ['n1', 'n2', 'n3', 'n4'] };
    expect(neighbourMedianBaseline().predict(ctx)).toBeNull();
  });

  it('p50 minutes is exactly the shipped estimate; p80 and tokens come from the same neighbours', () => {
    const ids = ['n1', 'n2', 'n3', 'n4', 'n5', 'n6'];
    const ctx = { task: outcome('t', 0), cutoff: new Date(T0), history, neighbours: ids };
    const est = neighbourMedianBaseline().predict(ctx)!;
    const shipped = estimateTaskSizeFromSessions(
      ids,
      history.map(h => ({ taskId: h.taskId, filesChanged: 3, startedAt: new Date(h.completedAt.getTime() - h.minutes! * 60_000), completedAt: h.completedAt })),
      { cutoff: new Date(T0) },
    )!;
    expect(est.minutes!.p50).toBe(shipped.minutes);
    expect(est.minutes!.p50).toBe(30);
    // k = 5: n1..n5 → 10..50 min; interpolated 80th percentile.
    expect(est.minutes!.p80).toBeCloseTo(42);
    expect(est.tokens).toEqual({ p50: 3000, p80: 4200 });
  });

  it('skips a neighbour with no file count, as the shipped sizing does', () => {
    const h = history.map(o => (o.taskId === 'n1' ? { ...o, filesChanged: null } : o));
    const est = neighbourMedianBaseline().predict({ task: outcome('t', 0), cutoff: new Date(T0), history: h, neighbours: ['n1', 'n2', 'n3', 'n4', 'n5', 'n6'] })!;
    expect(est.minutes!.p50).toBe(40); // n2..n6
  });

  it('quantile interpolates', () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantile([7], 0.8)).toBe(7);
  });
});

describe('report', () => {
  const mk = async (names: Array<[string, number, number]>, rows = 12) => {
    const outs = Array.from({ length: rows }, (_, i) => outcome(`t${i}`, i * 2, { dur: 10 + i, kind: i % 2 ? 'research' : 'engineering', complexity: i < 3 ? null : 'normal' }));
    const run = await bt.runBacktest(outs, { predictors: names.map(([n, a, b]) => fixed(n, a, b)) });
    return bt.computeBacktestReport(run, names[0][0]);
  };

  it('compares candidate with baseline on paired rows, split by kind and complexity', async () => {
    const r = await mk([['base', 10, 12], ['cand', 15, 20]]);
    const m = r.metrics.find(x => x.metric === 'minutes')!;
    expect(m.overall.paired).toBe(12);
    expect(m.byKind.map(g => g.group)).toEqual(['engineering', 'research']);
    expect(m.byComplexity.map(g => g.group)).toEqual(['normal', 'unclassified']);
    expect(m.overall.deltas.cand.mae).toBeLessThan(0); // actuals 10..21, cand is closer
    expect(m.overall.deltas.cand.pinball50Ci).not.toBeNull();
    expect(m.overall.deltas.base).toBeUndefined();
  });

  it('never pools: a predictor that abstains is scored only where both answered', async () => {
    const outs = Array.from({ length: 12 }, (_, i) => outcome(`t${i}`, i * 2, { dur: 10 }));
    const picky: SizePredictor = { name: 'picky', predict: ctx => (Number(ctx.task.taskId.slice(1)) < 4 ? { minutes: { p50: 10, p80: 10 }, tokens: null } : null) };
    const run = await bt.runBacktest(outs, { predictors: [fixed('base', 20, 30), picky] });
    const g = bt.computeBacktestReport(run, 'base').metrics[0].overall;
    expect(g.answered).toEqual({ base: 12, picky: 4 });
    expect(g.paired).toBe(4);
    expect(g.scores.base.n).toBe(4);
    const tokens = bt.computeBacktestReport(run, 'base').metrics[1].overall;
    expect(tokens.paired).toBe(0);
  });

  it('excludes rows with no actual for the metric', async () => {
    const outs = [outcome('a', 0, { tokens: null }), outcome('b', 1)];
    const run = await bt.runBacktest(outs, { predictors: [fixed('base', 5, 6)] });
    const m = bt.computeBacktestReport(run, 'base').metrics;
    expect(m[0].overall.withActual).toBe(2);
    expect(m[1].overall.withActual).toBe(1);
  });

  it('repairs and counts a p80 below p50', async () => {
    const run = await bt.runBacktest([outcome('a', 0)], { predictors: [fixed('bad', 10, 4)] });
    expect(run.repaired.bad).toBe(1);
    expect(run.rows[0].estimates.bad!.minutes).toEqual({ p50: 10, p80: 10 });
  });

  it('reports a tie plainly and declares no winner', async () => {
    const r = await mk([['base', 14, 18], ['same', 14, 18]]);
    const text = bt.formatBacktestReport(r);
    expect(text).toContain('same − base');
    expect(text).toContain('MAE 0.0');
    expect(text.toLowerCase()).not.toContain('winner');
  });

  it('requires the baseline to have run', async () => {
    const run = await bt.runBacktest([outcome('a', 0)], { predictors: [fixed('x', 1, 2)] });
    expect(() => bt.computeBacktestReport(run, 'nope')).toThrow();
  });

  it('is reproducible', async () => {
    const a = JSON.stringify(await mk([['base', 10, 12], ['cand', 15, 20]]));
    const b = JSON.stringify(await mk([['base', 10, 12], ['cand', 15, 20]]));
    expect(a).toBe(b);
  });
});
