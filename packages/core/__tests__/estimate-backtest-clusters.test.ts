import { describe, it, expect, mock } from 'bun:test';

mock.module('../db/client', () => ({ db: {} }));
const { replayClusters, compareClustersToNeighbours } = await import('../estimate-backtest-clusters');
const { buildClusterTasks } = await import('../task-area-clusters-source');

const T0 = Date.UTC(2026, 8, 1);
const hr = (h: number) => new Date(T0 + h * 3_600_000);
const area = 'packages/core/drizzle';
const rt = (id: string, h: number, extra: object = {}) =>
  ({ id, workspaceId: 'ws', title: id, description: null, createdAt: hr(h), completedAt: hr(h + 1), kind: 'engineering', complexity: 'normal', ...extra });
const ct = (id: string, h: number, minutes: number, files = [`${area}/a.sql`]) =>
  ({ id, createdAt: hr(h), kind: 'engineering', complexity: 'normal', minutes, tokens: 10, repairs: 0, files });

describe('buildClusterTasks', () => {
  it('joins sessions, files and repairs, and applies the createdAt cutoff', () => {
    const all = [rt('a', 0), rt('b', 5)];
    const sessions = ['a', 'b'].map(taskId => ({ taskId, startedAt: hr(0), completedAt: new Date(hr(0).getTime() + 600_000), inputTokens: 1, outputTokens: 2 }));
    const out = buildClusterTasks(all, sessions as never, new Map([['a', ['x/y.ts']]]), new Map([['a', 2]]), { asOf: hr(5) });
    expect(out.map(t => t.id)).toEqual(['a']);
    expect(out[0]).toMatchObject({ minutes: 10, tokens: 3, repairs: 2, files: ['x/y.ts'] });
  });
});

describe('replayClusters', () => {
  const past = [10, 20, 30, 40, 50, 60].map((m, i) => ct(`p${i}`, i, m));
  const target = rt('t', 100);
  const all = [...past.map((p, i) => rt(p.id, i)), target];
  const actuals = new Map([...past.map(p => [p.id, p.minutes] as [string, number]), ['t', 33]]);

  it('maps a manifest-less task through its neighbours\' diffs and ignores the future', async () => {
    const future = ct('f', 200, 9999, ['apps/other/x.ts']);
    const rows = await replayClusters([...all, rt('f', 200)], [...past, ct('t', 100, 33), future], actuals,
      { findNeighbours: async () => ['p0', 'p1', 'p2', 'f'] });
    const r = rows.find(x => x.taskId === 't')!;
    expect(r.mappedBy).toBe('neighbours');
    expect(r.p50).toBe(30); // median of 10..60 (weighted quantile picks lower middle)
  });

  it('uses the declared manifest when present, without asking for neighbours', async () => {
    const asked: string[] = [];
    const rows = await replayClusters(all.map(t => t.id === 't' ? { ...t, pathManifest: [`${area}/**`] } : t), [...past, ct('t', 100, 33)], actuals,
      { findNeighbours: async (t) => { asked.push(t.id); return []; } });
    expect(rows.find(x => x.taskId === 't')!.mappedBy).toBe('manifest');
    expect(asked).not.toContain('t');
  });

  it('compares both estimators on the same tasks', () => {
    const cmp = compareClustersToNeighbours(
      [{ taskId: 't', workspaceId: 'ws', source: 'neighbours', p50: 10, p80: null, actual: 20, priorCompleted: 6, actualTokens: 0 },
       { taskId: 'u', workspaceId: 'ws', source: 'bucket', p50: 30, p80: null, actual: 20, priorCompleted: 6, actualTokens: 0 }],
      [{ taskId: 't', actual: 20, p50: 20, p80: 25, mappedBy: 'neighbours', repairRate: 0 }],
    );
    expect(cmp.both.n).toBe(1);
    expect(cmp.both.clusters.medianRatio).toBe(1);
    expect(cmp.both.neighbours.medianRatio).toBe(2);
    expect(cmp.both.clusters.withinP80).toBe(1);
    expect(cmp.neither).toBe(1);
  });
});
