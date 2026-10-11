import { describe, it, expect } from 'bun:test';
import {
  deriveClusters, mapNewTaskToClusters, mapPathsToClusters, estimateFromClusters, weightedQuantile, type ClusterTask,
} from '../task-area-clusters';

const day = (d: number) => new Date(Date.UTC(2026, 8, d));
let seq = 0;
const task = (files: string[], over: Partial<ClusterTask> = {}): ClusterTask => ({
  id: `t${seq++}`, createdAt: day(1 + (seq % 20)), kind: 'engineering', complexity: 'normal',
  minutes: 10, tokens: 1000, repairs: 0, files, ...over,
});

const MISSIONS = 'apps/web/src/app/app/(protected)/missions';
const DRIZZLE = 'packages/core/drizzle';

describe('deriveClusters', () => {
  const fixtures = [
    ...[10, 20, 30].map(m => task([`${MISSIONS}/page.tsx`], { minutes: m })),
    ...[40, 50, 60].map(m => task([`${DRIZZLE}/0001.sql`], { minutes: m })),
  ];

  it('separates deep areas that share a long prefix', () => {
    const labels = deriveClusters(fixtures).clusters.map(c => c.label).sort();
    expect(labels).toEqual([DRIZZLE, MISSIONS].sort());
  });

  it('merges dirs that are always touched together into their parent', () => {
    const ts = [1, 2, 3, 4].map(() => task(['packages/core/a/x.ts', 'packages/core/b/y.ts']));
    expect(deriveClusters(ts).clusters.map(c => c.label)).toEqual(['packages/core']);
  });

  it('does not merge sibling dirs touched by different tasks', () => {
    const ts = [
      ...[1, 2, 3].map(() => task(['packages/core/a/x.ts'])),
      ...[1, 2, 3].map(() => task(['packages/core/b/y.ts'])),
    ];
    expect(deriveClusters(ts).clusters.map(c => c.label).sort()).toEqual(['packages/core/a', 'packages/core/b']);
  });

  it('a lone file does not create a cluster', () => {
    const m = deriveClusters([...fixtures, task(['apps/runner/src/solo.ts'])]);
    expect(m.clusters.some(c => c.label.startsWith('apps/runner'))).toBe(false);
  });

  it('rolls under-sampled deep dirs up to a sampled parent', () => {
    const ts = [task(['apps/web/src/a/x.ts']), task(['apps/web/src/b/y.ts']), task(['apps/web/src/c/z.ts'])];
    expect(deriveClusters(ts).clusters.map(c => c.label)).toEqual(['apps/web/src']);
  });

  it('computes quantiles, n, and repair rate per cluster and group', () => {
    const ts = [10, 20, 30, 40, 50].map((m, i) => task([`${DRIZZLE}/x.sql`], { minutes: m, repairs: i % 2 }));
    const c = deriveClusters(ts).clusters[0];
    expect(c.n).toBe(5);
    expect(c.overall.minutes).toEqual({ p50: 30, p80: 40 });
    expect(c.overall.repairRate).toBeCloseTo(0.4);
    expect(c.byGroup['engineering/normal'].n).toBe(5);
  });

  it('splits a task across clusters by share of files', () => {
    const ts = [
      ...[1, 2, 3].map(() => task([`${MISSIONS}/p.tsx`])),
      ...[1, 2, 3].map(() => task([`${DRIZZLE}/a.sql`])),
      task([`${MISSIONS}/p.tsx`, `${DRIZZLE}/a.sql`, `${DRIZZLE}/b.sql`], { minutes: 100 }),
    ];
    const m = deriveClusters(ts);
    expect(m.clusters.find(c => c.label === MISSIONS)!.n).toBe(4);
    expect(m.clusters.find(c => c.label === DRIZZLE)!.n).toBe(4);
  });

  it('respects the asOf cutoff: later tasks are invisible', () => {
    const early = [1, 2, 3].map(d => task([`${DRIZZLE}/a.sql`], { createdAt: day(d) }));
    const late = [10, 11, 12].map(d => task([`${MISSIONS}/p.tsx`], { createdAt: day(d) }));
    const asOf = deriveClusters([...early, ...late], { asOf: day(5) });
    expect(asOf.clusters.map(c => c.label)).toEqual([DRIZZLE]);
    expect(deriveClusters([...early, ...late], { asOf: day(10) }).clusters).toHaveLength(1); // created at the cutoff is excluded
    expect(deriveClusters([...early, ...late]).clusters).toHaveLength(2);
  });
});

describe('weightedQuantile', () => {
  it('honours weights', () => {
    expect(weightedQuantile([{ value: 1, weight: 1 }, { value: 100, weight: 9 }], 0.5)).toBe(100);
  });
});

describe('mapping a new task', () => {
  const model = deriveClusters([
    ...[10, 20, 30].map(m => task([`${MISSIONS}/page.tsx`], { minutes: m })),
    ...[40, 50, 60].map(m => task([`${DRIZZLE}/0001.sql`], { minutes: m })),
  ]);

  it('uses the declared manifest, globs included', () => {
    const r = mapNewTaskToClusters({ pathManifest: ['packages/core/drizzle/**'], neighbourPaths: [`${MISSIONS}/x.tsx`] }, model);
    expect(r.source).toBe('manifest');
    expect(r.clusters).toEqual([{ label: DRIZZLE, weight: 1 }]);
  });

  it('falls back to neighbours\' diffs when there is no manifest', () => {
    const r = mapNewTaskToClusters({ pathManifest: null, neighbourPaths: [`${MISSIONS}/a.tsx`, `${MISSIONS}/b.tsx`, `${DRIZZLE}/z.sql`] }, model);
    expect(r.source).toBe('neighbours');
    expect(r.clusters[0]).toEqual({ label: MISSIONS, weight: 2 / 3 });
  });

  it('reports none when nothing maps', () => {
    expect(mapNewTaskToClusters({ pathManifest: [], neighbourPaths: ['docs/x.md'] }, model).source).toBe('none');
  });

  it('a broad directory splits across the clusters under it', () => {
    const m = mapPathsToClusters(['apps'], model);
    expect(m).toEqual([{ label: MISSIONS, weight: 1 }]);
  });

  it('estimates from the mapped clusters', () => {
    const e = estimateFromClusters([{ label: DRIZZLE, weight: 1 }], model, { kind: 'engineering', complexity: 'normal' })!;
    expect(e.minutes).toBe(50);
    expect(estimateFromClusters([], model, {})).toBeNull();
  });
});
